import type {
  AgentAccountUsageSnapshot,
  AgentAccountUsageSourceContextInput,
  AgentSessionNativeHomeService,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import { isClaudeSidechainRuntimeEvidence, isSidechainSessionHook } from '../hooks/sidechain.js';
import type { ClaudeRuntimeAuthIdentity } from '../auth/services/runtime/requestIdentity.js';
import type { ClaudeRuntimeLogger } from './dependencies.js';

import { resolveClaudeConfigDirOverride } from '../environment.js';
import {
  mapClaudeProviderFailureToUsageDetails,
  mapClaudeRuntimeRateLimitsToUsageObservation,
  resolveClaudeRuntimeQuotaWindows,
} from '../auth/services/runtime/usage.js';
import { resolveClaudeUsageSubjectRef } from '../auth/services/usage/identity.js';
import { readClaudeNativeUsageIdentity } from '../auth/services/native/accountIdentity.js';
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
}> | null;

export type ClaudeRuntimeAccountUsageService = Readonly<{
  resolveSourceContext?(input: Readonly<{
    serviceId: 'claude-subscription';
    env?: Readonly<Record<string, string>>;
  }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<ClaudeProviderAccountUsageSourceContext>;
  recordSnapshot?(input: Readonly<{
    sessionId?: string | null;
    snapshot: AgentAccountUsageSnapshot;
    policyDisposition?: 'evidence_only';
    source?: AgentAccountUsageSourceContextInput | null;
    credentialProof?: Readonly<{ providerAccountId: string; credentialFingerprint: string }>;
  }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<
    | { status: 'recorded' }
    | { status: 'unavailable' | 'rejected'; reason?: string }
  >>;
}>;

export type ClaudeRuntimeAccountUsageContext = Readonly<{
  agentRuntime: Readonly<{
    accountUsage: ClaudeRuntimeAccountUsageService;
    nativeHome?: AgentSessionNativeHomeService;
  }>;
  logger: Pick<ClaudeRuntimeLogger, 'debug' | 'warn'>;
}>;

type ClaudeRuntimeAccountUsageParams = Readonly<{
  ctx: ClaudeRuntimeAccountUsageContext;
  evidence: unknown;
  sessionId: string;
  launchEnv?: Readonly<Record<string, string>> | null;
  observedAtMs?: number;
  policyDisposition?: 'evidence_only';
  runtimeAuthIdentity?: ClaudeRuntimeAuthIdentity;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readClaudeConfigDir(env: Readonly<Record<string, string>> | null | undefined): string | null {
  return env ? resolveClaudeConfigDirOverride(env) : null;
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
}> {
  const claudeConfigDir = readClaudeConfigDir(params.launchEnv);
  if (claudeConfigDir) {
    return {
      kind: 'nativeCli',
      sessionId: params.sessionId,
    };
  }
  if (hasEnvCredential(params.launchEnv)) {
    return {
      kind: 'envCredential',
      sessionId: params.sessionId,
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
  let observation = params.runtimeAuthIdentity ? params.runtimeAuthIdentity.observeQuotaEvidence(params.evidence)
    : mapClaudeRuntimeRateLimitsToUsageObservation(params.evidence);
  if (observation === null) return;
  const evidenceRecord = params.evidence && typeof params.evidence === 'object' && !Array.isArray(params.evidence)
    ? params.evidence as Readonly<Record<string, unknown>> : null;
  const sidechain = isClaudeSidechainRuntimeEvidence(params.evidence) || isSidechainSessionHook(evidenceRecord);
  const details = observation.status === 'not_loaded' || sidechain
    ? mapClaudeProviderFailureToUsageDetails(params.evidence) : null;
  if (sidechain && observation.status === 'loaded_data' && details) {
    const parentWindows = params.runtimeAuthIdentity?.readQuotaWindows() ?? [];
    const childWindows = observation.meters.filter(meter => meter.meterId !== details.providerLimitId
      || !parentWindows.some(parent => parent.meterId === meter.meterId));
    const combined = new Map([...parentWindows, ...childWindows].map(meter => [meter.meterId, meter]));
    observation = { status: 'loaded_data', meters: resolveClaudeRuntimeQuotaWindows(details, [...combined.values()]).windows };
  }
  if (observation.status === 'not_loaded' && !details) return;
  const quota = details ? resolveClaudeRuntimeQuotaWindows(details, params.runtimeAuthIdentity?.readQuotaWindows() ?? []) : null;
  const service = params.ctx.agentRuntime.accountUsage;
  const recordSnapshot = service?.recordSnapshot;
  if (typeof recordSnapshot !== 'function') return;

  const observedAtMs = params.observedAtMs ?? Date.now();
  const identity = buildRuntimeIdentity({
    sessionId: params.sessionId,
    launchEnv: params.launchEnv,
  });
  const claudeConfigDir = readClaudeConfigDir(params.launchEnv);
  const requestIdentity = params.runtimeAuthIdentity?.readUsageIdentity();
  const nativeContext = requestIdentity ?? await (async () => {
    try {
      const files = await params.ctx.agentRuntime.nativeHome?.readFiles(['.claude.json', '.credentials.json']);
      const parseFile = (bytes: Uint8Array | undefined): unknown => {
        if (!bytes) return null;
        try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
        catch { return null; }
      };
      return readClaudeNativeUsageIdentity(parseFile(files?.['.claude.json']), parseFile(files?.['.credentials.json']));
    } catch {
      return null;
    }
  })();
  const liveAccountIdentity = nativeContext?.identity ?? null;
  const credentialProof = nativeContext?.credentialProof ?? null;
  const serializedConnectedServiceSelection = params.launchEnv?.[
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV
  ];
  const sourceAddress = {
    serviceId: 'claude-subscription',
    ...(serializedConnectedServiceSelection
      ? {
          env: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV]: serializedConnectedServiceSelection,
          },
        }
      : {}),
  } as const satisfies AgentAccountUsageSourceContextInput;
  let sourceContext: ClaudeProviderAccountUsageSourceContext = null;
  if (typeof service.resolveSourceContext === 'function') {
    try {
      sourceContext = await service.resolveSourceContext(sourceAddress);
    } catch (error) {
      params.ctx.logger.debug('Claude runtime provider-account usage source context resolution failed (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return;
    }
  }
  const subject = resolveClaudeUsageSubjectRef({
    oauthAccountUuid: liveAccountIdentity?.providerAccountId ?? null,
    organizationId: liveAccountIdentity?.providerOrganizationId ?? null,
    provisionalDiscriminator: buildProvisionalDiscriminator({
      identity,
      sessionId: params.sessionId,
      launchEnv: params.launchEnv,
      sourceContext: requestIdentity === undefined ? sourceContext : null,
    }),
  });

  const snapshot = observation.status !== 'not_loaded'
    ? mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot({
      subject,
      observation,
      observedAtMs,
      fetchedAtMs: observedAtMs,
      accountLabel: liveAccountIdentity?.accountLabel ?? null,
    })
    : (() => {
      if (!details || !quota) return null;
      return mapClaudeUsageLimitDetailsToProviderAccountUsageSnapshot({
        subject,
        details,
        quotaWindows: quota.windows,
        observedAtMs,
        fetchedAtMs: observedAtMs,
        accountLabel: liveAccountIdentity?.accountLabel ?? null,
      });
    })();

  if (!snapshot) return;

  // Account identity and source qualification above belong to this observation.
  // The host owns best-effort delivery/retries once the qualified snapshot is submitted.
  void (async () => {
    try {
      const result = await recordSnapshot.call(service, {
        sessionId: params.sessionId,
        snapshot,
        ...(params.policyDisposition ? { policyDisposition: params.policyDisposition } : {}),
        ...(sourceContext && credentialProof ? { credentialProof } : {}),
        ...(sourceContext && (credentialProof || (requestIdentity === undefined && subject.kind === 'providerSubject'))
          ? { source: sourceAddress }
          : {}),
      });
      if (result.status !== 'recorded') {
        params.ctx.logger.warn('Claude runtime provider-account usage snapshot was not recorded', {
          status: result.status,
          reason: 'reason' in result ? result.reason : null,
        });
      }
    } catch (error) {
      params.ctx.logger.warn('Claude runtime provider-account usage recording failed (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  })();
}
