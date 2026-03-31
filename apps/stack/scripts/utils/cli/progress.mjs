import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createStepPrinter as createSharedStepPrinter } from '@happier-dev/cli-common/output';

export const createStepPrinter = createSharedStepPrinter;
 
export async function runCommandLogged({
  label,
  cmd,
  args,
  cwd,
  env,
  logPath,
  showSteps = true,
  quiet = true,
}) {
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
  let logStream = null;
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
 
  const res = await new Promise((resolvePromise, rejectPromise) => {
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
  err.code = 'EEXIT';
  err.exitCode = res.code;
  err.signal = res.signal;
  err.stdout = stdout;
  err.stderr = stderr;
  err.logPath = logPath;
  throw err;
}
