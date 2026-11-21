import { closeSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The one report a detached CLI updater sends back to the daemon that started it (plan R13,
 * review 6): whether the update transaction was admitted — it holds the install locks — or refused
 * before doing anything (`cli_update_in_progress`: another update is running, and that attempt owns
 * `last-update.json`; `cli_not_managed`; any other failure before admission). The daemon answers the
 * remote task only after this report, so a refused attempt is never reported as started.
 *
 * The channel is an extra pipe (fd 3) named by `UPDATER_ADMISSION_FD_ENV`, or, when a scheduled
 * task cannot inherit that pipe, one JSON line at `UPDATER_ADMISSION_PATH_ENV`. Exactly one report
 * is written, then the channel is forgotten, so the updater never writes it after the daemon restarts.
 */
export const UPDATER_ADMISSION_FD_ENV = 'HAPPIER_CLI_UPDATE_ADMISSION_FD';

/** One JSON line on disk. A Windows scheduled task cannot inherit the daemon's pipe. */
export const UPDATER_ADMISSION_PATH_ENV = 'HAPPIER_CLI_UPDATE_ADMISSION_PATH';

const ADMISSION_PATH_FLAG = '--admission-path';

/** Record `--admission-path` for this process and return the argv without that flag. */
export function applyUpdaterAdmissionPathArg(argv: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const rest: string[] = [];
  let path: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === ADMISSION_PATH_FLAG) {
      path = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg.startsWith(`${ADMISSION_PATH_FLAG}=`)) {
      path = arg.slice(ADMISSION_PATH_FLAG.length + 1);
      continue;
    }
    rest.push(arg);
  }
  if (path !== null && path.trim()) env[UPDATER_ADMISSION_PATH_ENV] = path;
  return rest;
}

export type UpdaterAdmission =
  | Readonly<{ admitted: true }>
  | Readonly<{ admitted: false; code: string; message: string }>;

/** Send the report once (later calls, and runs not started by a daemon, do nothing). */
export function reportUpdaterAdmission(admission: UpdaterAdmission, env: NodeJS.ProcessEnv = process.env): void {
  const line = `${JSON.stringify(admission)}\n`;
  const path = env[UPDATER_ADMISSION_PATH_ENV];
  if (typeof path === 'string' && path.trim()) {
    delete env[UPDATER_ADMISSION_PATH_ENV];
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, line, 'utf8');
    } catch {
      // The daemon that asked is gone, or the path is not writable.
    }
  }
  const fd = Number(env[UPDATER_ADMISSION_FD_ENV]);
  if (!Number.isInteger(fd) || fd < 3) return;
  delete env[UPDATER_ADMISSION_FD_ENV];
  try {
    writeSync(fd, line);
  } catch {
    // The daemon that asked is gone; nobody is waiting for the report.
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }
}

function parseAdmission(line: string): UpdaterAdmission | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { admitted?: unknown; code?: unknown; message?: unknown };
    if (record.admitted === true) return { admitted: true };
    if (record.admitted === false && typeof record.code === 'string') {
      return { admitted: false, code: record.code, message: typeof record.message === 'string' ? record.message : '' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Wait for the updater's one report. `null` when the pipe ended without one (the updater exited or
 * crashed before admission). No timeout: the updater reports as soon as it holds or is refused the
 * locks, before any download.
 */
export async function readUpdaterAdmission(stream: NodeJS.ReadableStream): Promise<UpdaterAdmission | null> {
  return await new Promise((resolve) => {
    let buffered = '';
    let settled = false;
    const finish = (admission: UpdaterAdmission | null) => {
      if (settled) return;
      settled = true;
      stream.removeAllListeners('data');
      if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy();
      resolve(admission);
    };
    stream.on('data', (chunk: Buffer | string) => {
      buffered += String(chunk);
      const newline = buffered.indexOf('\n');
      if (newline >= 0) finish(parseAdmission(buffered.slice(0, newline)));
    });
    stream.on('end', () => finish(buffered.trim() ? parseAdmission(buffered.trim()) : null));
    stream.on('close', () => finish(buffered.trim() ? parseAdmission(buffered.trim()) : null));
    stream.on('error', () => finish(null));
  });
}
