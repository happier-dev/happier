import { spawn } from 'node:child_process';

function appendTail(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) {
    return combined;
  }

  let trimmed = combined;
  while (Buffer.byteLength(trimmed, 'utf8') > maxBytes) {
    trimmed = trimmed.slice(Math.max(1, Math.floor(trimmed.length / 8)));
  }
  return trimmed;
}

function formatTail(label: string, value: string): string {
  const trimmed = value.trim();
  return trimmed ? `\n${label}:\n${trimmed}` : '';
}

export async function runCommandStreaming(params: Readonly<{
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  context?: string;
  maxCapturedBytes?: number;
}>): Promise<void> {
  const cmd = String(params.cmd ?? '').trim();
  if (!cmd) {
    throw new Error('command is required');
  }

  const maxCapturedBytes = Math.max(4 * 1024, Number(params.maxCapturedBytes ?? 32 * 1024));

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [...params.args], {
      cwd: params.cwd,
      env: params.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdoutTail = '';
    let stderrTail = '';

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutTail = appendTail(stdoutTail, chunk, maxCapturedBytes);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = appendTail(stderrTail, chunk, maxCapturedBytes);
    });

    child.once('error', (error) => {
      const context = params.context ? `[${params.context}] ` : '';
      reject(new Error(`${context}failed to start ${cmd}: ${String(error.message || error)}`));
    });

    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const context = params.context ? `[${params.context}] ` : '';
      const signalSuffix = signal ? ` (signal ${signal})` : '';
      reject(new Error(
        `${context}${cmd} exited with status ${code ?? 'unknown'}${signalSuffix}`
        + formatTail('stderr', stderrTail)
        + formatTail('stdout', stdoutTail),
      ));
    });
  });
}
