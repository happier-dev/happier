import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { logger } from '@/ui/logger';

import {
  readClaudeCodeNativeCredentialPayload,
  type ClaudeCodeNativeCredentialPayload,
} from './claudeCodeNativeCredentialPayload';

const DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const HAPPIER_MANAGED_CLAUDE_CODE_KEYCHAIN_SERVICE_PATTERN = /^Claude Code-credentials-[a-f0-9]{8}$/;
const KEYCHAIN_TIMESTAMP_PATTERN = /"mdat"<timedate>=[^\n"]*"(\d{14})Z\\000"/;
const CLAUDE_CODE_KEYCHAIN_SECURITY_TIMEOUT_MS = 10_000;

export type ClaudeCodeMacOsKeychainCredentialReadResult = Readonly<{
  payload: ClaudeCodeNativeCredentialPayload;
  updatedAtMs: number | null;
}>;

export type ClaudeCodeMacOsKeychainSweepSkipReason =
  | 'global_service'
  | 'different_account'
  | 'not_happier_managed_service';

export type ClaudeCodeMacOsKeychainSweepEntry = Readonly<{
  account: string;
  service: string;
}>;

export type ClaudeCodeMacOsKeychainSweepSkippedEntry =
  ClaudeCodeMacOsKeychainSweepEntry & Readonly<{
    reason: ClaudeCodeMacOsKeychainSweepSkipReason;
  }>;

export type ClaudeCodeMacOsKeychainSweepResult = Readonly<{
  scanned: number;
  deleted: readonly ClaudeCodeMacOsKeychainSweepEntry[];
  skipped: readonly ClaudeCodeMacOsKeychainSweepSkippedEntry[];
}>;

function resolveDefaultClaudeConfigDir(homeDir: string): string {
  return resolve(join(homeDir, '.claude'));
}

export function resolveClaudeCodeMacOsKeychainServiceName(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
}>): string {
  const resolvedClaudeConfigDir = resolve(params.claudeConfigDir);
  const resolvedHomeDir = resolve(String(params.homeDir ?? homedir()));
  if (resolvedClaudeConfigDir === resolveDefaultClaudeConfigDir(resolvedHomeDir)) {
    return DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE;
  }
  const suffix = createHash('sha256').update(resolvedClaudeConfigDir).digest('hex').slice(0, 8);
  return `${DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE}-${suffix}`;
}

export function isClaudeCodeMacOsGlobalKeychainService(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
}>): boolean {
  return resolveClaudeCodeMacOsKeychainServiceName(params) === DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE;
}

function buildKeychainCommandError(stderr: string, status: number | null): Error {
  const detail = stderr.trim();
  return new Error(
    detail.length > 0
      ? `claude_code_keychain_command_failed:${detail}`
      : `claude_code_keychain_command_failed:status_${status ?? 'unknown'}`,
  );
}

function buildKeychainTimeoutError(): Error {
  return new Error('claude_code_keychain_command_failed:security_timeout');
}

function assertSecuritySpawnAllowed(): void {
  // Structural boundary guard: under the vitest unit environment the REAL macOS `security` binary
  // must NEVER be spawned. A prior boundary escape (an un-mocked `spawnSync` writer) wrote ~266 items
  // into the developer's real login keychain. Every `security` call now funnels through this single
  // choke point, and any test exercising it MUST mock `node:child_process` `spawn` (the mocked binding
  // carries vitest's `.mock` marker). An un-mocked spawn under VITEST is a harness bug, so we fail loud
  // instead of touching the real keychain. Production is unaffected (`process.env.VITEST` is unset).
  if (
    process.env.VITEST
    && !Object.prototype.hasOwnProperty.call(spawn as unknown as Record<string, unknown>, 'mock')
  ) {
    throw new Error('claude_code_keychain_real_security_spawn_blocked_in_test');
  }
}

async function runSecurityCommand(params: Readonly<{
  args: readonly string[];
  timeoutMs?: number | undefined;
  signal?: AbortSignal;
}>): Promise<Readonly<{ stdout: string; stderr: string; status: number | null }>> {
  params.signal?.throwIfAborted();
  assertSecuritySpawnAllowed();
  const child = spawn('security', [...params.args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: params.signal,
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
    ? Math.max(1, Math.trunc(params.timeoutMs))
    : CLAUDE_CODE_KEYCHAIN_SECURITY_TIMEOUT_MS;

  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(buildKeychainTimeoutError());
    }, timeoutMs);
    timeout.unref?.();

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stdout?.on('data', (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.once('error', (error) => {
      settle(() => reject(error));
    });
    child.once('close', (status) => {
      settle(() => resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        status,
      }));
    });
    child.stdin?.end();
  });
}

function resolveKeychainUsername(username?: string | null | undefined): string {
  return String(username ?? userInfo().username).trim();
}

function parseDumpedKeychainCredentialEntries(output: string): ClaudeCodeMacOsKeychainSweepEntry[] {
  const entries: ClaudeCodeMacOsKeychainSweepEntry[] = [];
  for (const block of output.split(/\n(?=keychain: )/)) {
    const account = /"acct"<blob>="([^"]+)"/.exec(block)?.[1]?.trim();
    const service = /"svce"<blob>="([^"]+)"/.exec(block)?.[1]?.trim();
    if (!account || !service) continue;
    entries.push({ account, service });
  }
  return entries;
}

function classifyKeychainSweepEntry(params: Readonly<{
  entry: ClaudeCodeMacOsKeychainSweepEntry;
  username: string;
}>): ClaudeCodeMacOsKeychainSweepSkipReason | 'delete' {
  // The ONLY protected items are (a) other accounts' items — e.g. the ~266 `happier-test-user`
  // residue, never ours to delete — and (b) the user's GLOBAL `Claude Code-credentials` login, which
  // is the only Claude keychain item any `claude` process reads (a managed home sets CLAUDE_CONFIG_DIR
  // and reads ONLY its `.credentials.json` file — verified against the shipped binary). Every remaining
  // Happier-managed SUFFIXED item for this account is obsolete: nothing writes it and nothing reads it,
  // so it is deleted regardless of whether its home is currently live.
  if (params.entry.account !== params.username) return 'different_account';
  if (params.entry.service === DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE) return 'global_service';
  if (!HAPPIER_MANAGED_CLAUDE_CODE_KEYCHAIN_SERVICE_PATTERN.test(params.entry.service)) {
    return 'not_happier_managed_service';
  }
  return 'delete';
}

function parseKeychainTimestamp(metadata: string): number | null {
  const match = KEYCHAIN_TIMESTAMP_PATTERN.exec(metadata);
  const value = match?.[1];
  if (!value) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export async function deleteClaudeCodeMacOsKeychainCredential(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
}>): Promise<void> {
  const serviceName = resolveClaudeCodeMacOsKeychainServiceName({
    claudeConfigDir: params.claudeConfigDir,
    homeDir: params.homeDir,
  });
  const username = resolveKeychainUsername(params.username);
  const result = await runSecurityCommand({
    args: ['delete-generic-password', '-a', username, '-s', serviceName],
  });
  if (result.status !== 0 && !String(result.stderr ?? '').includes('could not be found')) {
    throw buildKeychainCommandError(String(result.stderr ?? ''), result.status);
  }
}

export async function sweepStaleClaudeCodeMacOsKeychainCredentials(params: Readonly<{
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
}>): Promise<ClaudeCodeMacOsKeychainSweepResult> {
  const username = resolveKeychainUsername(params.username);
  const dump = await runSecurityCommand({ args: ['dump-keychain'] });
  if (dump.status !== 0) {
    throw buildKeychainCommandError(String(dump.stderr ?? ''), dump.status);
  }
  const entries = parseDumpedKeychainCredentialEntries(dump.stdout);
  const deleted: ClaudeCodeMacOsKeychainSweepEntry[] = [];
  const skipped: ClaudeCodeMacOsKeychainSweepSkippedEntry[] = [];
  for (const entry of entries) {
    const decision = classifyKeychainSweepEntry({ entry, username });
    if (decision !== 'delete') {
      skipped.push({ ...entry, reason: decision });
      continue;
    }
    const result = await runSecurityCommand({
      args: ['delete-generic-password', '-a', entry.account, '-s', entry.service],
    });
    if (result.status === 0) {
      deleted.push(entry);
      continue;
    }
    if (String(result.stderr ?? '').includes('could not be found')) continue;
    throw buildKeychainCommandError(String(result.stderr ?? ''), result.status);
  }
  const skippedCounts = skipped.reduce<Record<ClaudeCodeMacOsKeychainSweepSkipReason, number>>(
    (counts, entry) => {
      counts[entry.reason] += 1;
      return counts;
    },
    {
      different_account: 0,
      global_service: 0,
      not_happier_managed_service: 0,
    },
  );
  logger.debug('[DAEMON RUN] Claude Code keychain stale credential sweep', {
    event: 'claude_code_keychain_stale_credential_sweep',
    scanned: entries.length,
    deletedCount: deleted.length,
    skippedCounts,
    decidedAtMs: Date.now(),
  });
  return {
    scanned: entries.length,
    deleted,
    skipped,
  };
}

export async function readClaudeCodeMacOsKeychainCredential(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
  signal?: AbortSignal;
}>): Promise<ClaudeCodeNativeCredentialPayload | null> {
  return (await readClaudeCodeMacOsKeychainCredentialWithMetadata(params))?.payload ?? null;
}

export async function readClaudeCodeMacOsKeychainCredentialWithMetadata(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
  signal?: AbortSignal;
}>): Promise<ClaudeCodeMacOsKeychainCredentialReadResult | null> {
  const read = await readClaudeCodeMacOsKeychainDocument(params);
  const payload = read ? readClaudeCodeNativeCredentialPayload(read.document) : null;
  return read && payload ? { payload, updatedAtMs: read.updatedAtMs } : null;
}

/** The parsed JSON document Claude Code keeps in its global keychain item, before any projection. */
export async function readClaudeCodeMacOsKeychainDocument(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
  signal?: AbortSignal;
}>): Promise<Readonly<{ document: unknown; updatedAtMs: number | null }> | null> {
  params.signal?.throwIfAborted();
  const serviceName = resolveClaudeCodeMacOsKeychainServiceName({
    claudeConfigDir: params.claudeConfigDir,
    homeDir: params.homeDir,
  });
  // The keychain read fallback is scoped to the GLOBAL `Claude Code-credentials` service only.
  // Happier no longer writes derived per-config keychain items, and native Claude uses only the
  // global service. A derived-service read could therefore only surface stale legacy Happier
  // artifacts — a split-brain remnant — so we never consult it (no read-back comparison against an
  // item nothing writes, no stale-payload clobber vector). The native/external read fallback for a
  // real `~/.claude` home is preserved.
  if (serviceName !== DEFAULT_CLAUDE_CODE_KEYCHAIN_SERVICE) return null;
  const username = resolveKeychainUsername(params.username);
  try {
    const args = ['find-generic-password', '-a', username, '-s', serviceName] as const;
    const [raw, metadata] = await Promise.all([
      runSecurityCommand({ args: [...args, '-w'], signal: params.signal }),
      runSecurityCommand({ args, signal: params.signal }),
    ]);
    params.signal?.throwIfAborted();
    if (raw.status !== 0 || metadata.status !== 0) return null;
    return {
      document: JSON.parse(raw.stdout.trim()) as unknown,
      updatedAtMs: parseKeychainTimestamp(metadata.stdout),
    };
  } catch {
    params.signal?.throwIfAborted();
    return null;
  }
}
