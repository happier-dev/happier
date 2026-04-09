import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function isTauriMcpCliErrorText(text) {
  const trimmed = String(text ?? '').trimStart();
  return trimmed.startsWith('Error:') || trimmed.startsWith('error:');
}

function extractTauriMcpCliEnvelopeErrorText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return isTauriMcpCliErrorText(trimmed) ? trimmed : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  if (typeof value.text === 'string') {
    const textError = extractTauriMcpCliEnvelopeErrorText(value.text);
    if (textError) {
      return textError;
    }
  }

  if (Array.isArray(value.content)) {
    for (const entry of value.content) {
      const contentError = extractTauriMcpCliEnvelopeErrorText(entry?.text);
      if (contentError) {
        return contentError;
      }
    }
  }

  return null;
}

function extractTauriMcpStructuredErrorText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return null;
  }

  if (isTauriMcpCliErrorText(raw)) {
    return raw;
  }

  try {
    return extractTauriMcpCliEnvelopeErrorText(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function throwIfTauriMcpCliError({ stdout, stderr } = {}) {
  const out = String(stdout ?? '');
  const err = String(stderr ?? '');
  const outError = extractTauriMcpStructuredErrorText(out);
  if (outError) {
    throw new Error(outError);
  }
  const errError = extractTauriMcpStructuredErrorText(err);
  if (errError) {
    throw new Error(errError);
  }
}

export function buildTauriMcpCliCommand(args) {
  return {
    command: 'yarn',
    args: ['-s', 'tauri:mcp:cli', ...args],
  };
}

function createTauriMcpTimeoutError(invocation, timeoutMs) {
  const error = new Error(
    `Command timed out after ${timeoutMs}ms: ${invocation.command} ${invocation.args.join(' ')}`,
  );
  error.code = 'ETIMEDOUT';
  return error;
}

function createTauriMcpExitError(invocation, code, signal, stdout, stderr) {
  const error = new Error(`Command failed: ${invocation.command} ${invocation.args.join(' ')}`);
  error.code = code;
  error.signal = signal;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

export function killSpawnedProcessTree(childProcess, signal = 'SIGKILL') {
  const pid = Number(childProcess?.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      childProcess?.kill?.(signal);
    } catch {}
  }
}

export async function runTauriMcpCli(args, {
  cwd,
  env,
  timeoutMs = 90_000,
  spawnImpl = spawn,
  killProcessTree = killSpawnedProcessTree,
} = {}) {
  const invocation = buildTauriMcpCliCommand(args);
  const child = spawnImpl(invocation.command, invocation.args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let timeoutError = null;
  let timeoutHandle = null;

  if (child.stdout && typeof child.stdout.setEncoding === 'function') {
    child.stdout.setEncoding('utf8');
  }
  if (child.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk ?? '');
    });
  }
  if (child.stderr && typeof child.stderr.setEncoding === 'function') {
    child.stderr.setEncoding('utf8');
  }
  if (child.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk ?? '');
    });
  }

  const result = await new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });

    child.once('close', (code, signal) => {
      cleanup();

      if (timeoutError) {
        timeoutError.stdout = stdout;
        timeoutError.stderr = stderr;
        timeoutError.code = timeoutError.code ?? 'ETIMEDOUT';
        timeoutError.signal = signal ?? null;
        reject(timeoutError);
        return;
      }

      if (code !== 0) {
        reject(createTauriMcpExitError(invocation, code, signal ?? null, stdout, stderr));
        return;
      }

      resolve({
        stdout,
        stderr,
        code,
        signal: signal ?? null,
      });
    });

    timeoutHandle = setTimeout(() => {
      timeoutError = createTauriMcpTimeoutError(invocation, timeoutMs);
      killProcessTree(child);
    }, timeoutMs);
  });
  throwIfTauriMcpCliError(result);
  return {
    ...result,
    command: invocation.command,
    args: invocation.args,
  };
}

export async function runTauriMcpCliJson(args, options = {}) {
  const result = await runTauriMcpCli([...args, '--json'], options);
  return JSON.parse(String(result.stdout ?? '').trim() || '{}');
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeTextArtifact(filePath, contents) {
  await ensureDir(dirname(filePath));
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

export async function appendTextArtifact(filePath, contents) {
  await ensureDir(dirname(filePath));
  await appendFile(filePath, contents, 'utf8');
  return filePath;
}

export function todayStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export function nowStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export function resolveWizardQaArtifactRoot(repoRoot, { date = new Date(), runId = nowStamp(date) } = {}) {
  return join(repoRoot, '.project', 'logs', 'bootstrap-qa', `tauri-onboarding-wizard-${todayStamp(date)}-${runId}`);
}
