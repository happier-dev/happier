import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import { buildProviderAccountUsageOpaqueLocalCredentialRef } from '@happier-dev/protocol';

import {
  mapClaudeRateLimitEventToUsageDetails,
  mapClaudeRuntimeRateLimitsToUsageObservation,
} from '../auth/services/runtime/usage.js';
import { resolveClaudeUsageSubjectRef } from '../auth/services/usage/identity.js';
import {
  mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot,
  mapClaudeUsageLimitDetailsToProviderAccountUsageSnapshot,
  type ClaudeProviderAccountUsageAliasInput,
} from '../auth/services/usage/snapshot.js';

type ClaudeRuntimeAccountUsageContext = Pick<PluginContextV1, 'accountUsage' | 'logger'>;

type ClaudeRuntimeAccountUsageParams = Readonly<{
  ctx: ClaudeRuntimeAccountUsageContext;
  evidence: unknown;
  sessionId: string;
  launchEnv?: Readonly<Record<string, string>> | null;
  observedAtMs?: number;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readClaudeConfigDir(env: Readonly<Record<string, string>> | null | undefined): string | null {
  return readString(env?.CLAUDE_CONFIG_DIR) ?? readString(env?.HAPPIER_CLAUDE_CONFIG_DIR);
}

function hasEnvCredential(env: Readonly<Record<string, string>> | null | undefined): boolean {
  return Boolean(
    readString(env?.ANTHROPIC_API_KEY)
    ?? readString(env?.ANTHROPIC_AUTH_TOKEN)
    ?? readString(env?.ANTHROPIC_OAUTH_TOKEN),
  );
}

function buildRuntimeAlias(params: Readonly<{
  sessionId: string;
  launchEnv?: Readonly<Record<string, string>> | null;
}>): ClaudeProviderAccountUsageAliasInput {
  const claudeConfigDir = readClaudeConfigDir(params.launchEnv);
  if (claudeConfigDir) {
    return {
      kind: 'nativeCli',
      sessionId: params.sessionId,
      localCredentialRef: buildProviderAccountUsageOpaqueLocalCredentialRef({
        providerId: 'claude',
        kind: 'nativeCli',
        value: claudeConfigDir,
      }),
    };
  }
  if (hasEnvCredential(params.launchEnv)) {
    return {
      kind: 'envCredential',
      sessionId: params.sessionId,
      localCredentialRef: 'claude-runtime-env',
    };
  }
  return {
    kind: 'nativeCli',
    sessionId: params.sessionId,
  };
}

function buildProvisionalDiscriminator(params: Readonly<{
  alias: ClaudeProviderAccountUsageAliasInput;
  sessionId: string;
  launchEnv?: Readonly<Record<string, string>> | null;
}>): string {
  const claudeConfigDir = readClaudeConfigDir(params.launchEnv);
  if (params.alias.kind === 'nativeCli' && claudeConfigDir) {
    return `native:${claudeConfigDir}`;
  }
  return `session:${params.sessionId}`;
}

export async function recordClaudeRuntimeProviderAccountUsageSnapshot(
  params: ClaudeRuntimeAccountUsageParams,
): Promise<void> {
  const service = params.ctx.accountUsage;
  if (!service || typeof service.recordSnapshot !== 'function') return;

  const observedAtMs = params.observedAtMs ?? Date.now();
  const alias = buildRuntimeAlias({
    sessionId: params.sessionId,
    launchEnv: params.launchEnv,
  });
  const subject = resolveClaudeUsageSubjectRef({
    provisionalDiscriminator: buildProvisionalDiscriminator({
      alias,
      sessionId: params.sessionId,
      launchEnv: params.launchEnv,
    }),
  });

  const observation = mapClaudeRuntimeRateLimitsToUsageObservation(params.evidence);
  const snapshot = observation.status !== 'not_loaded'
    ? mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot({
      subject,
      observation,
      observedAtMs,
      fetchedAtMs: observedAtMs,
      aliases: [alias],
    })
    : (() => {
      const details = mapClaudeRateLimitEventToUsageDetails(params.evidence);
      if (!details) return null;
      return mapClaudeUsageLimitDetailsToProviderAccountUsageSnapshot({
        subject,
        details,
        observedAtMs,
        fetchedAtMs: observedAtMs,
        aliases: [alias],
      });
    })();

  if (!snapshot) return;

  try {
    const result = await service.recordSnapshot({
      sessionId: params.sessionId,
      snapshot,
    });
    if (result.status !== 'recorded') {
      params.ctx.logger.debug('Claude runtime provider-account usage snapshot was not recorded', {
        status: result.status,
        reason: 'reason' in result ? result.reason : null,
      });
    }
  } catch (error) {
    params.ctx.logger.debug('Claude runtime provider-account usage recording failed (ignored)', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
