export type TmuxCursorPosition = Readonly<{ x: number; y: number }>;

export function parseTmuxCursorPosition(stdout: string): TmuxCursorPosition | null {
  const [rawX, rawY] = stdout.trim().split(/\s+/);
  if (rawX === undefined || rawY === undefined) return null;
  if (!/^\d+$/.test(rawX) || !/^\d+$/.test(rawY)) return null;
  const x = Number.parseInt(rawX, 10);
  const y = Number.parseInt(rawY, 10);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
  return { x, y };
}
