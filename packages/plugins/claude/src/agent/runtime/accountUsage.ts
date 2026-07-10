import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import { buildProviderAccountUsageOpaqueLocalCredentialRef } from '@happier-dev/plugin-sdk/experimental/cloud/usage';
import { HAPPIER_CLAUDE_CONFIG_DIR_ENV } from '@happier-dev/plugin-sdk/experimental/envConstants';

import {
  mapClaudeRateLimitEventToUsageDetails,
  mapClaudeRuntimeRateLimitsToUsageObservation,
} from '../auth/services/runtime/usage.js';
import { resolveClaudeUsageSubjectRef } from '../auth/services/usage/identity.js';
import {
  mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot,
  mapClaudeUsageLimitDetailsToProviderAccountUsageSnapshot,
} from '../auth/services/usage/snapshot.js';

type ClaudeRuntimeAccountUsageContext = Readonly<{
  agentRuntime: Pick<PluginContextV1['agentRuntime'], 'accountUsage'>;
  logger: PluginContextV1['logger'];
}>;
type ClaudeProviderAccountUsageSourceContext = Awaited<
  ReturnType<PluginContextV1['agentRuntime']['accountUsage']['resolveSourceContext']>
>;

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
  return readString(env?.CLAUDE_CONFIG_DIR) ?? readString(env?.[HAPPIER_CLAUDE_CONFIG_DIR_ENV]);
}

function hasEnvCredential(env: Readonly<Record<string, string>> | null | undefined): boolean {
  return Boolean(
    readString(env?.ANTHROPIC_API_KEY)
    ?? readString(env?.ANTHROPIC_AUTH_TOKEN)
    ?? readString(env?.ANTHROPIC_OAUTH_TOKEN),
  );
}

function buildRuntimeIdentity(params: Readonly<{
  sessionId: string;
  launchEnv?: Readonly<Record<string, string>> | null;
}>): Readonly<{
  kind: 'nativeCli' | 'envCredential';
  sessionId: string;
  localCredentialRef?: string;
}> {
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
  identity: ReturnType<typeof buildRuntimeIdentity>;
  sessionId: string;
  launchEnv?: Readonly<Record<string, string>> | null;
  sourceContext: ClaudeProviderAccountUsageSourceContext;
}>): string {
  if (params.sourceContext?.bindingKind === 'group_member' && params.sourceContext.groupId) {
    return `connected-service-group:${params.sourceContext.serviceId}:${params.sourceContext.groupId}:${params.sourceContext.profileId}`;
  }
  if (params.sourceContext?.bindingKind === 'profile') {
    return `connected-service-profile:${params.sourceContext.serviceId}:${params.sourceContext.profileId}`;
  }
  const claudeConfigDir = readClaudeConfigDir(params.launchEnv);
  if (params.identity.kind === 'nativeCli' && claudeConfigDir) {
    return `native:${claudeConfigDir}`;
  }
  return `session:${params.sessionId}`;
}

export async function recordClaudeRuntimeProviderAccountUsageSnapshot(
  params: ClaudeRuntimeAccountUsageParams,
): Promise<void> {
  const service = params.ctx.agentRuntime.accountUsage;
  if (!service || typeof service.recordSnapshot !== 'function') return;

  const observedAtMs = params.observedAtMs ?? Date.now();
  const identity = buildRuntimeIdentity({
    sessionId: params.sessionId,
    launchEnv: params.launchEnv,
  });
  let sourceContext: ClaudeProviderAccountUsageSourceContext = null;
  if (typeof service.resolveSourceContext === 'function') {
    try {
      sourceContext = await service.resolveSourceContext({
        serviceId: 'claude-subscription',
        ...(params.launchEnv ? { env: params.launchEnv } : {}),
      });
    } catch (error) {
      params.ctx.logger.debug('Claude runtime provider-account usage source context resolution failed (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return;
    }
  }
  const subject = resolveClaudeUsageSubjectRef({
    provisionalDiscriminator: buildProvisionalDiscriminator({
      identity,
      sessionId: params.sessionId,
      launchEnv: params.launchEnv,
      sourceContext,
    }),
  });

  const observation = mapClaudeRuntimeRateLimitsToUsageObservation(params.evidence);
  const snapshot = observation.status !== 'not_loaded'
    ? mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot({
      subject,
      observation,
      observedAtMs,
      fetchedAtMs: observedAtMs,
    })
    : (() => {
      const details = mapClaudeRateLimitEventToUsageDetails(params.evidence);
      if (!details) return null;
      return mapClaudeUsageLimitDetailsToProviderAccountUsageSnapshot({
        subject,
        details,
        observedAtMs,
        fetchedAtMs: observedAtMs,
      });
    })();

  if (!snapshot) return;

  try {
    const result = await service.recordSnapshot({
      sessionId: params.sessionId,
      snapshot,
      ...(sourceContext ? { source: sourceContext } : {}),
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
