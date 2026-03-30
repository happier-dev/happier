import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { resolveWindowsCommandOnPath } from '../process/index.js';
import {
  extractTailscaleServeHttpsUrl,
  tailscaleServeHttpsUrlForInternalServerUrlFromStatus,
} from './serveStatus.js';
import { parseTailscaleStatusJson, type TailscaleStatusSnapshot } from './statusSnapshot.js';

export type TailscaleCommandResult = Readonly<{
  command: string;
  args: ReadonlyArray<string>;
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type TailscaleCommandRequest = Readonly<{
  command: string;
  args: ReadonlyArray<string>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}>;

export type TailscaleCommandRunner = (request: TailscaleCommandRequest) => Promise<TailscaleCommandResult>;

export class TailscaleCommandError extends Error {
  readonly result: TailscaleCommandResult;

  constructor(message: string, result: TailscaleCommandResult) {
    super(message);
    this.name = 'TailscaleCommandError';
    this.result = result;
  }
}

export type ResolveTailscaleCommandOnPath = (
  command: string,
  env: NodeJS.ProcessEnv,
) => Promise<string | null> | string | null;

type ResolveTailscaleBinDeps = Readonly<{
  resolveCommandOnPath?: ResolveTailscaleCommandOnPath;
  isExecutable?: (path: string) => Promise<boolean> | boolean;
}>;

type ResolveTailscaleBinParams = Readonly<{
  env?: NodeJS.ProcessEnv;
}>;

type RunTailscaleDeps = ResolveTailscaleBinDeps &
  Readonly<{
    resolveTailscaleBin?: (params: ResolveTailscaleBinParams) => Promise<string> | string;
    runCommand?: TailscaleCommandRunner;
  }>;

type RunTailscaleParams = Readonly<{
  env?: NodeJS.ProcessEnv;
  tailscaleBin?: string;
  timeoutMs?: number;
}>;

export type RunTailscaleServeEnableParams = RunTailscaleParams &
  Readonly<{
    upstreamUrl: string;
    servePath?: string;
  }>;

export type RunTailscaleServeEnableResult = Readonly<{
  approvalUrl: string | null;
  httpsUrl: string | null;
  rawStatus: string;
}>;

export type RunTailscaleLoginResult = Readonly<{
  usedQr: boolean;
  result: TailscaleCommandResult;
  actionUrl: string | null;
}>;

const TAILSCALE_CLI_ENV_KEYS = ['HAPPIER_TAILSCALE_BIN', 'HAPPIER_STACK_TAILSCALE_BIN'] as const;
const MACOS_TAILSCALE_CLI_PATHS = [
  '/Applications/Tailscale.app/Contents/MacOS/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
] as const;

function normalizeTimeoutMs(value: unknown, defaultMs: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return defaultMs;
  if (numeric <= 0) return 0;
  return Math.trunc(numeric);
}

export function sanitizeTailscaleEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.XPC_SERVICE_NAME;
  return sanitized;
}

async function isExecutablePath(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const name = String(command ?? '').trim();
  if (!name) return null;

  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath(name, env) ?? null;
  }

  const pathEntries = String(env.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const dir of pathEntries) {
    const candidate = join(dir, name);
    if (await isExecutablePath(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function resolveTailscaleBin(
  params: ResolveTailscaleBinParams = {},
  deps: ResolveTailscaleBinDeps = {},
): Promise<string> {
  const env = sanitizeTailscaleEnv(params.env ?? process.env);

  for (const key of TAILSCALE_CLI_ENV_KEYS) {
    const explicit = String(env[key] ?? '').trim();
    if (explicit) {
      return explicit;
    }
  }

  const resolvedOnPath = await (deps.resolveCommandOnPath ?? resolveCommandOnPath)('tailscale', env);
  if (resolvedOnPath) {
    return resolvedOnPath;
  }

  for (const candidate of MACOS_TAILSCALE_CLI_PATHS) {
    if (await (deps.isExecutable ?? isExecutablePath)(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `[tailscale] CLI not found. Install Tailscale, put 'tailscale' on PATH, or set ${TAILSCALE_CLI_ENV_KEYS[0]}.`,
  );
}

const runCommand: TailscaleCommandRunner = async (request) => {
  const timeoutMs = normalizeTimeoutMs(request.timeoutMs, 750);
  const env = sanitizeTailscaleEnv(request.env ?? process.env);
  const command = String(request.command ?? '').trim();
  const args = Array.isArray(request.args) ? request.args.map((value) => String(value)) : [];

  return await new Promise<TailscaleCommandResult>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const result: TailscaleCommandResult = {
          command,
          args,
          exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        };

        if (error) {
          const exitCode = typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
            : (error as NodeJS.ErrnoException & { status?: number }).status ?? 1;
          reject(
            new TailscaleCommandError(
              error instanceof Error ? error.message : `tailscale command failed: ${String(error)}`,
              {
                ...result,
                exitCode,
              },
            ),
          );
          return;
        }

        resolve(result);
      },
    );
  });
};

function collectOutput(result: Readonly<{ stdout?: string; stderr?: string }>): string {
  return [String(result.stdout ?? ''), String(result.stderr ?? '')].filter(Boolean).join('\n').trim();
}

function shouldFallbackFromQrLogin(error: unknown): boolean {
  const combined = error instanceof TailscaleCommandError
    ? collectOutput(error.result)
    : error instanceof Error
      ? error.message
      : String(error);
  const normalized = combined.toLowerCase();
  return normalized.includes('--qr') && (
    normalized.includes('flag provided but not defined') ||
    normalized.includes('unknown flag') ||
    normalized.includes('unknown shorthand flag')
  );
}

function normalizeHttpsUrlWithNoCredentials(raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function extractTailscaleLoginActionUrl(text: string): string | null {
  const match = String(text ?? '').match(/https:\/\/login\.tailscale\.com\/\S+/i);
  if (!match) return null;

  try {
    const parsed = new URL(match[0]);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'login.tailscale.com') {
      return null;
    }
    return normalizeHttpsUrlWithNoCredentials(parsed.toString());
  } catch {
    return null;
  }
}

export function extractTailscaleServeApprovalUrl(text: string): string | null {
  const match = String(text ?? '').match(/https:\/\/login\.tailscale\.com\/f\/serve\?\S+/i);
  if (!match) return null;

  try {
    const parsed = new URL(match[0]);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'login.tailscale.com') {
      return null;
    }
    if (parsed.pathname !== '/f/serve' || !parsed.searchParams.get('node')) {
      return null;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

async function resolveCommand(params: RunTailscaleParams, deps: RunTailscaleDeps): Promise<string> {
  const explicit = String(params.tailscaleBin ?? '').trim();
  if (explicit) return explicit;
  if (deps.resolveTailscaleBin) {
    return await deps.resolveTailscaleBin({ env: params.env ?? process.env });
  }
  return await resolveTailscaleBin({ env: params.env ?? process.env }, deps);
}

async function runTextCommand(
  params: RunTailscaleParams & Readonly<{ args: ReadonlyArray<string> }>,
  deps: RunTailscaleDeps = {},
): Promise<string> {
  const command = await resolveCommand(params, deps);
  const result = await (deps.runCommand ?? runCommand)({
    command,
    args: params.args,
    env: sanitizeTailscaleEnv(params.env ?? process.env),
    timeoutMs: normalizeTimeoutMs(params.timeoutMs, 750),
  });
  return String(result.stdout ?? '');
}

export async function runTailscaleVersion(params: RunTailscaleParams = {}, deps: RunTailscaleDeps = {}): Promise<string> {
  return await runTextCommand({ ...params, args: ['version'] }, deps);
}

export async function runTailscaleStatus(params: RunTailscaleParams = {}, deps: RunTailscaleDeps = {}): Promise<string> {
  return await runTextCommand({ ...params, args: ['status'] }, deps);
}

export async function runTailscaleStatusJson(
  params: RunTailscaleParams = {},
  deps: RunTailscaleDeps = {},
): Promise<TailscaleStatusSnapshot> {
  const raw = await runTextCommand({ ...params, args: ['status', '--json'] }, deps);
  return parseTailscaleStatusJson(raw);
}

export async function runTailscaleLogin(params: RunTailscaleParams = {}, deps: RunTailscaleDeps = {}): Promise<RunTailscaleLoginResult> {
  const command = await resolveCommand(params, deps);
  const runner = deps.runCommand ?? runCommand;
  const env = sanitizeTailscaleEnv(params.env ?? process.env);
  const timeoutMs = normalizeTimeoutMs(params.timeoutMs, 30_000);

  try {
    const result = await runner({
      command,
      args: ['login', '--qr'],
      env,
      timeoutMs,
    });
    return {
      usedQr: true,
      actionUrl: extractTailscaleLoginActionUrl(collectOutput(result)),
      result,
    };
  } catch (error) {
    if (!shouldFallbackFromQrLogin(error)) {
      throw error;
    }
  }

  const fallbackResult = await runner({
    command,
    args: ['login'],
    env,
    timeoutMs,
  });

  return {
    usedQr: false,
    actionUrl: extractTailscaleLoginActionUrl(collectOutput(fallbackResult)),
    result: fallbackResult,
  };
}

export async function runTailscaleUp(
  params: RunTailscaleParams & Readonly<{ extraArgs?: ReadonlyArray<string> }> = {},
  deps: RunTailscaleDeps = {},
): Promise<TailscaleCommandResult> {
  const command = await resolveCommand(params, deps);
  return await (deps.runCommand ?? runCommand)({
    command,
    args: ['up', ...(params.extraArgs ?? [])],
    env: sanitizeTailscaleEnv(params.env ?? process.env),
    timeoutMs: normalizeTimeoutMs(params.timeoutMs, 30_000),
  });
}

export async function runTailscaleDown(params: RunTailscaleParams = {}, deps: RunTailscaleDeps = {}): Promise<TailscaleCommandResult> {
  const command = await resolveCommand(params, deps);
  return await (deps.runCommand ?? runCommand)({
    command,
    args: ['down'],
    env: sanitizeTailscaleEnv(params.env ?? process.env),
    timeoutMs: normalizeTimeoutMs(params.timeoutMs, 15_000),
  });
}

export async function runTailscaleServeStatus(
  params: RunTailscaleParams = {},
  deps: RunTailscaleDeps = {},
): Promise<string> {
  return await runTextCommand({ ...params, args: ['serve', 'status'] }, deps);
}

export async function runTailscaleServeEnable(
  params: RunTailscaleServeEnableParams,
  deps: RunTailscaleDeps = {},
): Promise<RunTailscaleServeEnableResult> {
  const command = await resolveCommand(params, deps);
  const runner = deps.runCommand ?? runCommand;
  const env = sanitizeTailscaleEnv(params.env ?? process.env);
  const timeoutMs = normalizeTimeoutMs(params.timeoutMs, 30_000);
  const upstreamUrl = String(params.upstreamUrl ?? '').trim();
  const servePath = String(params.servePath ?? '/').trim() || '/';
  const args = ['serve', '--bg'];
  if (servePath !== '/') {
    args.push(`--set-path=${servePath}`);
  }
  args.push(upstreamUrl);

  try {
    await runner({
      command,
      args,
      env,
      timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof TailscaleCommandError)) {
      throw error;
    }

    const rawStatus = collectOutput(error.result);
    const approvalUrl = extractTailscaleServeApprovalUrl(rawStatus);
    if (approvalUrl) {
      return {
        approvalUrl,
        httpsUrl: null,
        rawStatus,
      };
    }
    throw error;
  }

  const status = await runTailscaleServeStatus(
    {
      env,
      tailscaleBin: command,
      timeoutMs: params.timeoutMs,
    },
    {
      runCommand: runner,
      resolveTailscaleBin: async () => command,
    },
  ).catch(() => '');

  return {
    approvalUrl: null,
    httpsUrl:
      tailscaleServeHttpsUrlForInternalServerUrlFromStatus(status, upstreamUrl) ?? extractTailscaleServeHttpsUrl(status),
    rawStatus: status,
  };
}

export async function runTailscaleServeReset(params: RunTailscaleParams = {}, deps: RunTailscaleDeps = {}): Promise<void> {
  const command = await resolveCommand(params, deps);
  await (deps.runCommand ?? runCommand)({
    command,
    args: ['serve', 'reset'],
    env: sanitizeTailscaleEnv(params.env ?? process.env),
    timeoutMs: normalizeTimeoutMs(params.timeoutMs, 15_000),
  });
}
