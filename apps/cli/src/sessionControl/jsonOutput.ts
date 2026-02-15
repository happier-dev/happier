export type SessionControlJsonEnvelope =
  | Readonly<{ v: 1; ok: true; kind: string; data: unknown }>
  | Readonly<{ v: 1; ok: false; kind: string; error: unknown }>;

export function wantsJson(argv: readonly string[]): boolean {
  return argv.includes('--json');
}

export function printJsonEnvelope(
  payload:
    | Readonly<{ ok: true; kind: string; data: unknown }>
    | Readonly<{ ok: false; kind: string; error: unknown }>,
): void {
  // IMPORTANT: stdout must be JSON only in --json mode (no extra logs).
  console.log(JSON.stringify({ v: 1, ...payload }));
}
