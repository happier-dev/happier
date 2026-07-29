import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/plugin-sdk/experimental/cloud/usage';
import { buildProviderAccountUsageOpaqueLocalCredentialRef } from '@happier-dev/plugin-sdk/experimental/cloud/usage';
import { HAPPIER_CLAUDE_CONFIG_DIR_ENV } from '@happier-dev/plugin-sdk/experimental/envConstants';
import type { ClaudeRuntimeLogger } from './dependencies.js';

import {
  mapClaudeRateLimitEventToUsageDetails,
  mapClaudeRuntimeRateLimitsToUsageObservation,
} from '../auth/services/runtime/usage.js';
import { resolveClaudeUsageSubjectRef } from '../auth/services/usage/identity.js';
import {
  mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot,
  mapClaudeUsageLimitDetailsToProviderAccountUsageSnapshot,
} from '../auth/services/usage/snapshot.js';

type ClaudeConnectedServiceId =
  | 'anthropic'
  | 'bitbucket'
  | 'claude-subscription'
  | 'gemini'
  | 'github'
  | 'openai'
  | 'openai-codex';

type ClaudeProviderAccountUsageSourceContext = Readonly<{
  serviceId: ClaudeConnectedServiceId;
  profileId: string;
  bindingKind: 'profile' | 'group_member';
  groupId?: string;
  groupGeneration?: number;
}> | null;

export type ClaudeRuntimeAccountUsageService = Readonly<{
  resolveSourceContext?(input: Readonly<{
    serviceId: 'claude-subscription';
    env?: Readonly<Record<string, string>>;
  }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<ClaudeProviderAccountUsageSourceContext>;
  recordSnapshot?(input: Readonly<{
    sessionId?: string | null;
    snapshot: ProviderAccountUsageSnapshotV1;
    source?: Exclude<ClaudeProviderAccountUsageSourceContext, null> | null;
  }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<
    | { status: 'recorded'; recordId?: string; persisted?: boolean }
    | { status: 'unavailable' | 'rejected'; reason?: string }
  >>;
}>;

export type ClaudeRuntimeAccountUsageContext = Readonly<{
  agentRuntime: Readonly<{ accountUsage: ClaudeRuntimeAccountUsageService }>;
  logger: Pick<ClaudeRuntimeLogger, 'debug'>;
}>;

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
