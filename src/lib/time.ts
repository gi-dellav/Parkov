// Time-context helpers for Parkov prediction.
// Context = day-of-week + weekday/weekend flag + 3-hour window.

export interface TimeContext {
  date: Date;
  dow: number; // 0 = Sunday … 6 = Saturday
  dowName: string;
  isWeekend: boolean;
  kind: "weekday" | "weekend";
  hour: number;
  window: number; // 0..7, each covering 3 hours
  windowLabel: string;
  dowWindowKey: string; // e.g. "1@3" (Monday, 09–12)
  kindWindowKey: string; // e.g. "weekday@3"
  windowKey: string; // e.g. "w3"
}

export const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DOW_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function hourWindow(hour: number): number {
  return Math.min(7, Math.max(0, Math.floor(hour / 3)));
}

export function windowLabel(window: number): string {
  const start = window * 3;
  const end = start + 3;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(start)}–${pad(end)}`;
}

export function getTimeContext(date: Date = new Date()): TimeContext {
  const dow = date.getDay();
  const hour = date.getHours();
  const window = hourWindow(hour);
  const isWeekend = dow === 0 || dow === 6;
  const kind = isWeekend ? "weekend" : "weekday";
  return {
    date,
    dow,
    dowName: DOW_NAMES[dow] ?? "?",
    isWeekend,
    kind,
    hour,
    window,
    windowLabel: windowLabel(window),
    dowWindowKey: `${dow}@${window}`,
    kindWindowKey: `${kind}@${window}`,
    windowKey: `w${window}`,
  };
}

/** "Mon 09–12 · weekday" style label. */
export function formatContext(ctx: TimeContext): string {
  return `${DOW_FULL[ctx.dow]} ${ctx.windowLabel} · ${ctx.kind}`;
}
