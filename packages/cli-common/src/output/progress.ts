import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import chalk from 'chalk';

type ChalkLike = typeof chalk;

function isTty(): boolean {
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function spinnerFrames(): string[] {
  return ['|', '/', '-', '\\'];
}

function colorResult(chalkLike: ChalkLike, result: string): string {
  const normalized = String(result);
  if (chalkLike.level <= 0) return normalized;
  if (normalized === '✓') return chalkLike.green(normalized);
  if (normalized === 'x' || normalized === '✗') return chalkLike.red(normalized);
  if (normalized === '!') return chalkLike.yellow(normalized);
  return normalized;
}

function colorSpinner(chalkLike: ChalkLike, frame: string): string {
  return chalkLike.level <= 0 ? String(frame) : chalkLike.cyan(String(frame));
}

export function createStepPrinter({ enabled = true, chalkLike = chalk }: Readonly<{ enabled?: boolean; chalkLike?: ChalkLike }> = {}) {
  if (!enabled) {
    return {
      start: () => {},
      stop: () => {},
      info: () => {},
    };
  }

  const tty = enabled && isTty();
  const frames = spinnerFrames();
  let timer: ReturnType<typeof setInterval> | null = null;
  let idx = 0;
  let currentLine = '';

  const write = (value: string) => process.stdout.write(value);

  const start = (label: string) => {
    if (!tty) {
      write(`- [..] ${label}\n`);
      return;
    }
    currentLine = `- [${colorSpinner(chalkLike, frames[idx % frames.length] ?? '|')}] ${label}`;
    write(currentLine);
    timer = setInterval(() => {
      idx += 1;
      const next = `- [${colorSpinner(chalkLike, frames[idx % frames.length] ?? '|')}] ${label}`;
      const pad = currentLine.length > next.length ? ' '.repeat(currentLine.length - next.length) : '';
      currentLine = next;
      write(`\r${next}${pad}`);
    }, 120);
  };

  const stop = (result: string, label: string) => {
    if (timer) clearInterval(timer);
    timer = null;
    if (!tty) {
      write(`- [${colorResult(chalkLike, result)}] ${label}\n`);
      return;
    }
    const out = `- [${colorResult(chalkLike, result)}] ${label}`;
    const pad = currentLine.length > out.length ? ' '.repeat(currentLine.length - out.length) : '';
    currentLine = '';
    write(`\r${out}${pad}\n`);
  };

  const info = (line: string) => {
    write(`${line}\n`);
  };

  return { start, stop, info };
}

export async function runCommandLogged({
  label,
  cmd,
  args,
  cwd,
  env,
  logPath,
  showSteps = true,
  quiet = true,
}: Readonly<{
  label: string;
  cmd: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
  showSteps?: boolean;
  quiet?: boolean;
}>) {
  const steps = createStepPrinter({ enabled: showSteps });
  if (quiet) {
    await mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  }

  steps.start(label);

  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  });

  let stdout = '';
  let stderr = '';
  let logStream: ReturnType<typeof createWriteStream> | null = null;
  if (quiet) {
    logStream = createWriteStream(logPath, { flags: 'a' });
    child.stdout?.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      logStream?.write(s);
    });
    child.stderr?.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      logStream?.write(s);
    });
  }

  const res = await new Promise<Readonly<{ code: number; signal: NodeJS.Signals | null }>>((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => resolvePromise({ code: code ?? 1, signal: signal ?? null }));
  });

  try {
    logStream?.end();
  } catch {
    // ignore
  }

  if (res.code === 0) {
    steps.stop('✓', label);
    return { ok: true, code: 0, stdout, stderr, logPath };
  }

  steps.stop('x', label);
  const err = new Error(`${cmd} failed (code=${res.code}${res.signal ? `, sig=${res.signal}` : ''})`);
  (err as Error & {
    code?: string;
    exitCode?: number;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
    logPath?: string;
  }).code = 'EEXIT';
  (err as Error & { exitCode?: number }).exitCode = res.code;
  (err as Error & { signal?: NodeJS.Signals | null }).signal = res.signal;
  (err as Error & { stdout?: string }).stdout = stdout;
  (err as Error & { stderr?: string }).stderr = stderr;
  (err as Error & { logPath?: string }).logPath = logPath;
  throw err;
}
