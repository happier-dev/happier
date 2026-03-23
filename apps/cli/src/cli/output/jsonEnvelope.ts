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
  opts?: Readonly<{ exitCode?: 0 | 1 | 2 }>,
): void {
  // IMPORTANT: stdout must be JSON only in --json mode (no extra logs).
  console.log(JSON.stringify({ v: 1, ...payload }));

  // Stable exit codes for automation:
  // - 0: success
  // - 1: expected failure
  // - 2: unexpected failure
  const desired =
    typeof opts?.exitCode === 'number'
      ? opts.exitCode
      : payload.ok
        ? 0
        : 1;
  // Never downgrade an existing more-severe exit code.
  const current = typeof process.exitCode === 'number' ? process.exitCode : undefined;
  if (current === undefined || desired > current) {
    process.exitCode = desired;
  }
}
