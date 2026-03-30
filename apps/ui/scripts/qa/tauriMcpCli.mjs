import { execFile } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function isTauriMcpCliErrorText(text) {
  const trimmed = String(text ?? '').trimStart();
  return trimmed.startsWith('Error:') || trimmed.startsWith('error:');
}

export function throwIfTauriMcpCliError({ stdout, stderr } = {}) {
  const out = String(stdout ?? '');
  const err = String(stderr ?? '');
  if (isTauriMcpCliErrorText(out)) {
    throw new Error(out.trim());
  }
  if (isTauriMcpCliErrorText(err)) {
    throw new Error(err.trim());
  }
}

export function buildTauriMcpCliCommand(args) {
  return {
    command: 'yarn',
    args: ['-s', 'tauri:mcp:cli', ...args],
  };
}

export async function runTauriMcpCli(args, { cwd, env, timeoutMs = 90_000 } = {}) {
  const invocation = buildTauriMcpCliCommand(args);
  const result = await execFileAsync(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
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
