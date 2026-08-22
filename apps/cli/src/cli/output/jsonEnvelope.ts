export type SessionControlJsonEnvelope =
  | Readonly<{ v: 1; ok: true; kind: string; data: unknown }>
  | Readonly<{ v: 1; ok: false; kind: string; error: unknown }>;

export function wantsJson(argv: readonly string[]): boolean {
  return argv.includes('--json');
}

async function writeLineAndWaitForStdout(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      process.stdout.removeListener('error', onError);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onError = (error: unknown): void => finish(error);

    process.stdout.once('error', onError);
    try {
      // The callback is the portable completion boundary for both buffered
      // pipes and regular files. In particular, Bun may return from console.log
      // while a large pipe write is still pending.
      process.stdout.write(`${line}\n`, (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

export async function writeJsonStdout(
  value: unknown,
  opts?: Readonly<{ pretty?: boolean }>,
): Promise<void> {
  const serialized = JSON.stringify(value, null, opts?.pretty ? 2 : undefined);
  if (serialized === undefined) {
    throw new TypeError('Cannot serialize undefined as JSON output');
  }
  await writeLineAndWaitForStdout(serialized);
}

export async function printJsonEnvelope(
  payload:
    | Readonly<{ ok: true; kind: string; data: unknown }>
    | Readonly<{ ok: false; kind: string; error: unknown }>,
  opts?: Readonly<{ exitCode?: 0 | 1 | 2 }>,
): Promise<void> {
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

  // IMPORTANT: stdout must be JSON only in --json mode (no extra logs).
  await writeJsonStdout({ v: 1, ...payload });
}
