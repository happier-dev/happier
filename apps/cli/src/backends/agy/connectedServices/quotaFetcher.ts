import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandCapture, type CommandCaptureResult } from '@happier-dev/cli-common/process';
import { ConnectedServiceQuotaSnapshotV1Schema, type ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher, type ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import { readConnectedServiceQuotaStaleAfterMs } from '@/daemon/connectedServices/quotas/configuration';
import { resolveProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { AGY_FILE_TOKEN_STORAGE_ENV_KEY, supportsAgyConnectedAccountIsolation } from '../acp/agyAcpLaunch';
import { AGY_NATIVE_TOKEN_FILE_SEGMENTS, serializeAgyNativeCliCredential } from '../cloud/nativeCredentials';

export type AgyUsageCommandRunner = (input: Readonly<{
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
}>) => Promise<CommandCaptureResult>;

type AgyLaunch = Readonly<{ command: string; args: readonly string[] }>;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function fraction(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
/** `reason` names the failed check so the refresh log shows why (fixed codes only, never values). */
function fail(reason: string, code: 'malformed' | 'provider_backoff' = 'malformed'): never {
  throw new ConnectedServiceQuotaFetchError(`antigravity_${reason}`, { quotaFetchErrorCode: code });
}

/** One `/usage` bucket. agy reports an unset reset as the Unix epoch, which is not a reset time. */
function meter(value: unknown, groupName: string | null): ConnectedServiceQuotaMeterV1 {
  const bucket = object(value);
  const bucketId = text(bucket?.id);
  if (!bucket || !bucketId) return fail('usage_malformed:bucket_without_id');
  const remaining = fraction(bucket.remaining_fraction);
  if (remaining !== null && remaining > 1) return fail('usage_malformed:remaining_fraction_above_one');
  const reset = text(bucket.reset_time) ? Date.parse(text(bucket.reset_time)!) : Number.NaN;
  const resetsAt = Number.isFinite(reset) && reset > 0 ? reset : null;
  const window = text(bucket.window);
  const disabled = bucket.disabled === true;
  const windowDurationMs = window === 'weekly' ? 604_800_000 : window === '5h' ? 18_000_000 : null;
  return {
    meterId: bucketId,
    providerLimitId: bucketId,
    limitScope: 'account',
    scope: window === 'weekly' ? 'weekly' : window === '5h' ? 'five_hour' : 'unknown',
    ...(windowDurationMs ? { windowDurationMs } : {}),
    source: 'provider_api',
    confidence: remaining === null ? 'unknown' : 'exact',
    label: [groupName, text(bucket.name) ?? bucketId].filter(Boolean).join(' · '),
    used: null,
    limit: null,
    remaining: null,
    remainingPct: remaining === null ? null : remaining * 100,
    utilizationPct: remaining === null ? null : (1 - remaining) * 100,
    isExhausted: !disabled && remaining === 0,
    unit: 'unknown',
    resetsAt,
    resetAtMs: resetsAt,
    status: disabled || remaining === null ? 'unavailable' : 'ok',
    details: {
      ...(disabled ? { code: 'provider_disabled' } : {}),
      ...(window ? { rawScope: window } : {}),
      ...(text(bucket.description) ? { note: text(bucket.description) } : {}),
    },
  };
}

function parseUsage(result: CommandCaptureResult): ConnectedServiceQuotaMeterV1[] {
  if (result.kind === 'aborted') throw result.error;
  if (result.kind !== 'exited') return fail(`usage_unavailable:${result.kind}`, 'provider_backoff');
  let output: Record<string, unknown> | null;
  try { output = object(JSON.parse(result.stdout)); } catch { return fail('usage_malformed:not_json'); }
  if (result.status !== 0 || output?.status !== 'SUCCESS') return fail('usage_unavailable:command_failed', 'provider_backoff');
  const groups = object(object(output.command)?.data)?.groups;
  if (!Array.isArray(groups)) return fail('usage_malformed:without_groups');
  return groups.flatMap(value => {
    const group = object(value);
    if (!group || (group.buckets !== undefined && !Array.isArray(group.buckets))) return fail('usage_malformed:group_shape');
    return Array.isArray(group.buckets) ? group.buckets.map(bucket => meter(bucket, text(group.name))) : [];
  });
}

/**
 * Antigravity quota comes from the installed agy itself: `agy -p /usage --output-format json`
 * (agy 1.5.18: no model turn) runs as the account with a throwaway home holding only its token,
 * with file-only token storage so the machine login is never read. Happier makes no request to
 * Google for it; agy onboards a never-used account on its own first run.
 */
export function createAgyQuotaFetcher(deps: Readonly<{
  runCommand?: AgyUsageCommandRunner;
  resolveLaunch?: () => AgyLaunch | null;
  staleAfterMs?: number;
}> = {}): ConnectedServiceQuotaFetcher {
  const runCommand: AgyUsageCommandRunner = deps.runCommand ?? (async (input) => await runCommandCapture({
    cmd: input.command, args: input.args, env: input.env, cwd: input.cwd, signal: input.signal }));
  const resolveLaunch = deps.resolveLaunch ?? (() => resolveProviderCliLaunchSpec('agy', { processEnv: process.env }));
  let isolatedCommand: string | null = null;
  return { serviceId: 'antigravity', async fetch({ record, now, signal }) {
    // The quota boundary hands fetchers an access-token-only view (refresh tokens are stripped);
    // agy reads usage with the daemon-refreshed access token and an empty refresh token.
    if (record.serviceId !== 'antigravity' || record.kind !== 'oauth' || !record.oauth.accessToken) {
      throw new ConnectedServiceQuotaFetchError('missing_antigravity_oauth_record', { quotaFetchErrorCode: 'missing_auth' });
    }
    const launch = resolveLaunch();
    if (!launch) return fail('cli_unavailable', 'provider_backoff');
    const home = await mkdtemp(join(tmpdir(), 'happier-agy-usage-'));
    try {
      // Top-level agy (1.5.18) ignores GEMINI_HOME and has no --gemini-dir flag; it reads the
      // profile from the user's home (`~/.gemini`). The throwaway directory is that home, so the
      // machine login is never in reach. Inherited profile overrides are dropped.
      const { GEMINI_HOME: _geminiHome, ANTIGRAVITY_GEMINI_DIR: _profileDir, ...inherited } = process.env;
      const env: NodeJS.ProcessEnv = { ...inherited, HOME: home, USERPROFILE: home, [AGY_FILE_TOKEN_STORAGE_ENV_KEY]: '1' };
      if (isolatedCommand !== launch.command) {
        const version = await runCommand({ command: launch.command, args: [...launch.args, '--version'], env, cwd: home, signal });
        if (version.kind === 'aborted') throw version.error;
        const reported = version.kind === 'exited' ? version.stdout.trim() : null;
        if (!supportsAgyConnectedAccountIsolation(reported)) return fail('cli_version_unsupported', 'provider_backoff');
        isolatedCommand = launch.command;
      }
      await writeJsonAtomic(join(home, '.gemini', ...AGY_NATIVE_TOKEN_FILE_SEGMENTS), serializeAgyNativeCliCredential({
        accessToken: record.oauth.accessToken, refreshToken: record.oauth.refreshToken ?? '',
        expiresAt: record.expiresAt ?? null, email: record.oauth.providerEmail,
      }));
      const meters = parseUsage(await runCommand({ command: launch.command,
        args: [...launch.args, '-p', '/usage', '--output-format', 'json'], env, cwd: home, signal }));
      return ConnectedServiceQuotaSnapshotV1Schema.parse({ v: 1, serviceId: 'antigravity', profileId: record.profileId,
        fetchedAt: now, staleAfterMs: deps.staleAfterMs ?? readConnectedServiceQuotaStaleAfterMs(process.env),
        planLabel: null, accountLabel: record.oauth.providerEmail ?? record.oauth.providerAccountId, meters });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  } };
}
export const agyQuotaFetcherDescriptor: ConnectedServiceQuotaFetcherDescriptor = { loadQuota: ({ staleAfterMs }) => createAgyQuotaFetcher({ staleAfterMs }) };
