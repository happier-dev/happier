import {
  buildCodexSpawnRuntimeAffinityCompatFields,
  type CodexBackendMode,
} from '@happier-dev/agents';
import type {
  BackendSurfaceResultV1,
  ExternalSessionActivityRequestV1,
  ExternalSessionActivityResultV1,
  ExternalSessionCandidatePageV1,
  ExternalSessionFollowLeaseRequestV1,
  ExternalSessionFollowLeaseV1,
  ExternalSessionFollowTranscriptPathResolutionV1,
  ExternalSessionFailureCodeV1,
  ExternalSessionListCandidatesRequestV1,
  ExternalSessionReadAfterRequestV1,
  ExternalSessionResolveFollowTranscriptPathRequestV1,
  ExternalSessionResolveLinkedIdentityRequestV1,
  ExternalSessionResolveLinkIdentityRequestV1,
  ExternalSessionResolveSourceRequestV1,
  ExternalSessionResolvedIdentityV1,
  ExternalSessionRuntimeContextV1,
  ExternalSessionSurfaceV1,
  ExternalSessionTakeoverLaunchRequestV1,
  ExternalSessionTakeoverLaunchResultV1,
  ExternalSessionTranscriptPageRequestV1,
  ExternalSessionTranscriptPageV1,
} from '@happier-dev/agents';
import {
  readRuntimeDescriptorV1FromMetadata,
  type ExternalSessionsSource,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import { homeEntries, resolveConfiguredCodexHomePath } from '../../../rollout/discovery/homeEntries.js';
import { resolveCodexExternalSessionLinkIdentity } from './identity.js';
import { validateCodexExternalSessionsSourcePolicy } from './sourceValidation.js';

export type CodexExternalSessionTakeoverSpawnPlan = Readonly<{
  directory: string;
  backendTarget: Readonly<{ kind: 'backend'; backendId: 'codex'; sourceKind: 'built_in' }>;
  existingSessionId: string;
  resume: string;
  approvedNewDirectoryCreation: true;
  transcriptStorage: 'direct';
  codexBackendMode?: CodexBackendMode;
  environmentVariables: Readonly<{ CODEX_HOME: string }>;
}>;

export type CreateCodexExternalSessionSurfaceParams = Readonly<{
  baseProcessEnv: Readonly<Record<string, string | undefined>>;
}>;

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

export function resolveCodexExternalSessionFallbackHome(
  entries: readonly Readonly<{ codexHome: string | null | undefined }>[],
): string | null {
  if (entries.length !== 1) return null;
  return normalizeNonEmptyString(entries[0]?.codexHome ?? null);
}

export function resolveCodexExternalSessionTakeoverSpawnPlan(params: Readonly<{
  sessionId: string;
  remoteSessionId: string;
  directory: string | null | undefined;
  codexHome: string | null | undefined;
  codexBackendMode?: CodexBackendMode | null;
}>): CodexExternalSessionTakeoverSpawnPlan | null {
  const directory = normalizeNonEmptyString(params.directory);
  const codexHome = normalizeNonEmptyString(params.codexHome);
  if (!directory || !codexHome) return null;

  return {
    directory,
    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    existingSessionId: params.sessionId,
    resume: params.remoteSessionId,
    approvedNewDirectoryCreation: true,
    transcriptStorage: 'direct',
    ...buildCodexSpawnRuntimeAffinityCompatFields(
      params.codexBackendMode ? { backendMode: params.codexBackendMode } : null,
    ),
    environmentVariables: {
      CODEX_HOME: codexHome,
    },
  };
}

function isSafeConnectedServiceId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(raw.trim());
}

function ok<TValue>(value: TValue): BackendSurfaceResultV1<TValue, never> {
  return { ok: true, value };
}

function fail<TValue, TCode extends ExternalSessionFailureCodeV1>(
  code: TCode,
  message?: string,
): BackendSurfaceResultV1<TValue, TCode> {
  return {
    ok: false,
    code,
    ...(message ? { message } : {}),
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readExternalSessionRuntimeDescriptor(value: Readonly<Record<string, unknown>>): RuntimeDescriptorV1 | null {
  return readRuntimeDescriptorV1FromMetadata(value);
}

function resolveSourcePolicy(params: Readonly<{
  source: ExternalSessionsSource;
  baseProcessEnv: Readonly<Record<string, string | undefined>>;
}>): BackendSurfaceResultV1<Readonly<{ source: ExternalSessionsSource }>, 'source_invalid'> {
  const canonicalRequestedHomePath = params.source.kind === 'codexHome' && typeof params.source.homePath === 'string'
    ? params.source.homePath.trim() || null
    : null;
  const result = validateCodexExternalSessionsSourcePolicy({
    source: params.source,
    configuredCodexHomePath: resolveConfiguredCodexHomePath(params.baseProcessEnv),
    canonicalRequestedHomePath,
    isSafeConnectedServiceId,
  });
  if (!result.ok) {
    return fail('source_invalid', result.error);
  }
  return ok({ source: result.source });
}

async function resolveHomeFallback(params: Readonly<{
  source: ExternalSessionsSource;
  runtime?: ExternalSessionRuntimeContextV1;
  baseProcessEnv: Readonly<Record<string, string | undefined>>;
}>): Promise<string | null> {
  const activeServerDir = params.runtime?.directories?.activeServerDir;
  if (typeof activeServerDir !== 'string' || activeServerDir.trim().length === 0) {
    return null;
  }
  const entries = await homeEntries({
    source: params.source,
    activeServerDir,
    env: {
      ...params.baseProcessEnv,
    },
  });
  return resolveCodexExternalSessionFallbackHome(entries);
}

function requireTranscriptService(runtime?: ExternalSessionRuntimeContextV1) {
  return runtime?.external?.transcripts ?? null;
}

function requireCandidateService(runtime?: ExternalSessionRuntimeContextV1) {
  return runtime?.external?.candidates ?? null;
}

type ExternalSessionTranscriptStoreService = NonNullable<
  NonNullable<ExternalSessionRuntimeContextV1['external']>['transcripts']
>;

async function mapTranscriptCall<TValue>(
  runtime: ExternalSessionRuntimeContextV1 | undefined,
  operation: (service: ExternalSessionTranscriptStoreService) => Promise<TValue>,
): Promise<BackendSurfaceResultV1<TValue, 'provider_unavailable'>> {
  const service = requireTranscriptService(runtime);
  if (!service) {
    return fail<TValue, 'provider_unavailable'>('provider_unavailable', 'external_session_transcript_service_unavailable');
  }
  try {
    return ok(await operation(service));
  } catch {
    return fail<TValue, 'provider_unavailable'>('provider_unavailable', 'external_session_transcript_service_failed');
  }
}

function resolveIdentity(params: Readonly<{
  providerSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  metadata?: Readonly<Record<string, unknown>>;
}>): ExternalSessionResolvedIdentityV1 {
  const identity = resolveCodexExternalSessionLinkIdentity({
    remoteSessionId: params.providerSessionId,
    source: params.source,
    runtimeDescriptor: params.runtimeDescriptor ?? null,
    metadata: params.metadata ? { ...params.metadata } : undefined,
  });
  return {
    providerSessionId: identity.remoteSessionId,
    source: identity.source,
    runtimeDescriptor: identity.runtimeDescriptor ?? null,
    vendorMetadata: identity.vendorMetadata,
    externalSessionMetadata: identity.externalSessionMetadata,
  };
}

export function createCodexExternalSessionSurface(
  params: CreateCodexExternalSessionSurfaceParams,
): ExternalSessionSurfaceV1 {
  return {
    resolveSource: (request: ExternalSessionResolveSourceRequestV1) => resolveSourcePolicy({
      source: request.source,
      baseProcessEnv: params.baseProcessEnv,
    }),
    listCandidates: async (request: ExternalSessionListCandidatesRequestV1) => {
      const resolved = resolveSourcePolicy({
        source: request.source,
        baseProcessEnv: params.baseProcessEnv,
      });
      if (!resolved.ok) {
        return fail<ExternalSessionCandidatePageV1, 'source_invalid'>('source_invalid', resolved.message);
      }
      const service = requireCandidateService(request.runtime);
      if (!service) {
        return fail<ExternalSessionCandidatePageV1, 'provider_unavailable'>('provider_unavailable', 'external_session_candidate_service_unavailable');
      }
      try {
        return ok(await service.listViaChildHost({
          providerId: 'codex',
          source: resolved.value.source,
          cursor: request.cursor,
          limit: request.limit,
          searchTerm: request.searchTerm,
          searchMode: request.searchMode,
        }));
      } catch {
        return fail<ExternalSessionCandidatePageV1, 'provider_unavailable'>('provider_unavailable', 'external_session_candidate_service_failed');
      }
    },
    getActivity: async (request: ExternalSessionActivityRequestV1) => await mapTranscriptCall<ExternalSessionActivityResultV1>(
      request.runtime,
      (service) => service.getActivity({
        providerId: 'codex',
        source: request.source,
        providerSessionId: request.providerSessionId,
      }),
    ),
    pageTranscript: async (request: ExternalSessionTranscriptPageRequestV1) => await mapTranscriptCall<ExternalSessionTranscriptPageV1>(
      request.runtime,
      (service) => service.page({
        providerId: 'codex',
        source: request.source,
        providerSessionId: request.providerSessionId,
        direction: request.direction,
        cursor: request.cursor,
        maxBytes: request.maxBytes,
        maxItems: request.maxItems,
      }),
    ),
    readAfterTranscript: async (request: ExternalSessionReadAfterRequestV1) => await mapTranscriptCall<ExternalSessionTranscriptPageV1>(
      request.runtime,
      (service) => service.readAfter({
        providerId: 'codex',
        source: request.source,
        providerSessionId: request.providerSessionId,
        cursor: request.cursor,
        maxBytes: request.maxBytes,
        maxItems: request.maxItems,
      }),
    ),
    resolveFollowTranscriptPath: async (request: ExternalSessionResolveFollowTranscriptPathRequestV1) => await mapTranscriptCall<ExternalSessionFollowTranscriptPathResolutionV1>(
      request.runtime,
      (service) => service.resolveFollowTranscriptPath({
        providerId: 'codex',
        source: request.source,
        providerSessionId: request.providerSessionId,
        reason: request.reason,
        linkedSessionId: request.linkedSessionId,
      }),
    ),
    acquireFollowLease: async (request: ExternalSessionFollowLeaseRequestV1) => await mapTranscriptCall<ExternalSessionFollowLeaseV1>(
      request.runtime,
      (service) => service.acquireFollowLease({
        providerId: 'codex',
        source: request.source,
        providerSessionId: request.providerSessionId,
        reason: request.reason,
        linkedSessionId: request.linkedSessionId,
      }),
    ),
    resolveLinkIdentity: (request: ExternalSessionResolveLinkIdentityRequestV1) => ok(resolveIdentity({
      providerSessionId: request.providerSessionId,
      source: request.source,
      runtimeDescriptor: request.runtimeDescriptor,
      metadata: request.metadata,
    })),
    resolveLinkedIdentity: (request: ExternalSessionResolveLinkedIdentityRequestV1) => {
      const externalSession = readRecord(request.metadata.externalSessionV1);
      const runtimeDescriptor = (
        externalSession ? readExternalSessionRuntimeDescriptor(externalSession) : null
      ) ?? readRuntimeDescriptorV1FromMetadata(request.metadata);
      return ok(resolveIdentity({
        providerSessionId: request.providerSessionId,
        source: request.source,
        runtimeDescriptor,
        metadata: request.metadata,
      }));
    },
    resolveTakeoverLaunch: async (request: ExternalSessionTakeoverLaunchRequestV1) => {
      const service = requireTranscriptService(request.runtime);
      if (!service) {
        return fail<ExternalSessionTakeoverLaunchResultV1, 'provider_unavailable'>('provider_unavailable', 'external_session_transcript_service_unavailable');
      }
      const key = {
        providerId: 'codex' as const,
        source: request.source,
        providerSessionId: request.providerSessionId,
      };
      const directory =
        normalizeNonEmptyString(request.runtime?.session?.directory)
        ?? await service.getWorkingDirectory(key).catch(() => null);
      const providerHome =
        await service.getProviderHome(key).catch(() => null)
        ?? await resolveHomeFallback({
          source: request.source,
          runtime: request.runtime,
          baseProcessEnv: params.baseProcessEnv,
        });
      const plan = resolveCodexExternalSessionTakeoverSpawnPlan({
        sessionId: request.linkedSessionId,
        remoteSessionId: request.providerSessionId,
        directory,
        codexHome: providerHome,
        codexBackendMode: null,
      });
      if (!plan) {
        return fail<ExternalSessionTakeoverLaunchResultV1, 'takeover_not_available'>('takeover_not_available');
      }
      return ok({
        providerSessionId: request.providerSessionId,
        source: request.source,
        launch: {
          directory: plan.directory,
          environmentVariables: plan.environmentVariables,
        },
      });
    },
  };
}
