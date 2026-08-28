import {
  buildLinkedExternalSessionMetadataV1,
  normalizeLinkedExternalSessionMetadataV1,
  resolveExternalHistoryImportV1FromMetadata,
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  resolveLinkedExternalSessionMetadataV1,
  readRuntimeDescriptorV1FromMetadata,
  type RuntimeDescriptorV1,
  type ExternalSessionsAgentId,
  type ExternalSessionsSource,
  type PluginAgentExternalSessionLinkData,
  type PluginAgentExternalLinkedTakeoverWriterSafetyV1,
} from '@happier-dev/protocol';
import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import type { StoredCredentials } from '@/persistence';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import {
  tryDecryptSessionOwnerMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  canonicalizeLinkedExternalSessionSource,
  readExternalAgentSurfaceRuntimeDescriptorV1,
} from '@/agent/runtime/bridges/session/externalSessionSourceCanonicalization';
import {
  metadataProvesHostedExternalSessionIdentity,
} from '@/api/session/external/linking/hostedExternalSessionIdentity';
import {
  resolveExternalSessionSourceKeyOwner,
} from '@/session/external/resolveExternalSessionSourceKeyOwner';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import type { ExternalSessionSourceKeyOwner } from '@/plugins/projection/registry/externalSessionSources';

type LoadLinkedExternalSessionDeps = Readonly<{
  resolveExternalSessionProviderOps?: (
    agentId: ExternalSessionsAgentId,
  ) => Promise<ExternalSessionExecutionSurface | null>;
  resolveExternalSessionSourceKeyOwner?: (
    agentId: ExternalSessionsAgentId,
    source: ExternalSessionsSource,
  ) => Promise<ExternalSessionSourceKeyOwner | null>;
  admitPersistedSourceBeforeCanonicalization?: (input: Readonly<{
    agentId: ExternalSessionsAgentId;
    machineId: string;
    remoteSessionId: string;
    source: ExternalSessionsSource;
  }>) => Promise<Readonly<{
    source: ExternalSessionsSource;
    externalLinkedTakeoverWriterSafety:
      PluginAgentExternalLinkedTakeoverWriterSafetyV1;
  }> | null>;
}>;

function applyRuntimeDescriptorSessionStateBinding(
  metadata: Readonly<Record<string, unknown>>,
  runtimeDescriptor: RuntimeDescriptorV1 | null,
): Record<string, unknown> {
  return applyRuntimeDescriptorSessionMetadata(
    metadata as Record<string, unknown>,
    runtimeDescriptor,
  );
}

function canonicalizeExternalSessionRuntimeDescriptorIngress(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const metadata = normalizeLinkedExternalSessionMetadataV1(value) ?? value as Record<string, unknown>;
  const externalSession = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  const runtimeDescriptor = readExternalAgentSurfaceRuntimeDescriptorV1(metadata);
  const canonicalMetadata = applyRuntimeDescriptorSessionStateBinding(
    metadata,
    runtimeDescriptor,
  );

  if (!externalSession || !runtimeDescriptor) {
    return canonicalMetadata;
  }

  const externalSessionWithRuntimeDescriptor = readNonAuthoritativeLinkedExternalSessionV1FromMetadata({
    externalSessionV1: applyRuntimeDescriptorSessionStateBinding(
      externalSession,
      runtimeDescriptor,
    ),
  });
  return externalSessionWithRuntimeDescriptor
    ? buildLinkedExternalSessionMetadataV1(canonicalMetadata, externalSessionWithRuntimeDescriptor)
    : canonicalMetadata;
}

export type LoadedLinkedExternalSession = Readonly<{
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  sessionPath: string | null;
  agentId: ExternalSessionsAgentId;
  machineId: string;
  remoteSessionId: string;
  linkGeneration: string;
  source: ExternalSessionsSource;
  canonicalResolvedSourceKey?: string;
  linkData?: PluginAgentExternalSessionLinkData;
  externalLinkedTakeoverWriterSafety?:
    PluginAgentExternalLinkedTakeoverWriterSafetyV1;
}>;

export type ExpectedCurrentExternalSessionLinkIdentity = Readonly<{
  agentId: ExternalSessionsAgentId;
  machineId: string;
  remoteSessionId: string;
  source: ExternalSessionsSource;
}>;

async function resolveExpectedCurrentLinkSourceKey(params: Readonly<{
  session: Pick<
    LoadedLinkedExternalSession,
    'agentId' | 'machineId' | 'remoteSessionId' | 'source'
  >;
  expected: ExpectedCurrentExternalSessionLinkIdentity;
}>, deps: LoadLinkedExternalSessionDeps = {}): Promise<string | null> {
  if (
    params.session.agentId !== params.expected.agentId
    || params.session.machineId !== params.expected.machineId
    || params.session.remoteSessionId !== params.expected.remoteSessionId
  ) {
    return null;
  }

  const resolveSourceKeyOwner = deps.resolveExternalSessionSourceKeyOwner
    ?? resolveExternalSessionSourceKeyOwner;
  const sourceKeyOwner = await resolveSourceKeyOwner(
    params.expected.agentId,
    params.expected.source,
  ).catch(() => null);
  if (!sourceKeyOwner) return null;
  try {
    return sourceKeyOwner.resolveSourceKey(params.session.source)
      === sourceKeyOwner.sourceKey
      ? sourceKeyOwner.sourceKey
      : null;
  } catch {
    return null;
  }
}

export type PersistedLinkedExternalSession = Readonly<{
  rawSession: RawSessionRecord;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  metadata: Record<string, unknown>;
  agentId: ExternalSessionsAgentId;
  machineId: string;
  remoteSessionId: string;
  linkGeneration: string;
  source: ExternalSessionsSource;
  linkData?: PluginAgentExternalSessionLinkData;
}>;

type PersistedLinkedExternalSessionReadResult =
  | Readonly<{ ok: true; session: PersistedLinkedExternalSession }>
  | Readonly<{
      ok: false;
      errorCode: 'invalid_request' | 'agent_unavailable';
      error: string;
    }>;

function inspectPersistedLinkedExternalSessionFromRaw(params: Readonly<{
  credentials: StoredCredentials;
  rawSession: RawSessionRecord;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
}>):
  | Readonly<{
      ok: true;
      metadata: Record<string, unknown>;
      linkedMetadataResolution: ReturnType<
        typeof resolveLinkedExternalSessionMetadataV1
      >;
      historyImportResolution: ReturnType<
        typeof resolveExternalHistoryImportV1FromMetadata
      >;
      direct: ReturnType<typeof readNonAuthoritativeLinkedExternalSessionV1FromMetadata>;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'invalid_request' | 'agent_unavailable';
      error: string;
    }> {
  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession: params.rawSession,
    accountEncryptionMode: params.accountEncryptionMode,
  });
  if (!metadata) {
    return {
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'session_metadata_unavailable',
    };
  }
  const linkedMetadataResolution =
    resolveLinkedExternalSessionMetadataV1(metadata);
  const historyImportResolution =
    resolveExternalHistoryImportV1FromMetadata(metadata);
  if (historyImportResolution.state === 'invalid') {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: historyImportResolution.error,
    };
  }
  if (
    !linkedMetadataResolution.ok
    && linkedMetadataResolution.error
      === 'linked_session_reconciliation_required'
  ) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'linked_session_reconciliation_required',
    };
  }

  const canonicalizedIngress =
    canonicalizeExternalSessionRuntimeDescriptorIngress(metadata);
  if (
    !canonicalizedIngress
    || typeof canonicalizedIngress !== 'object'
    || Array.isArray(canonicalizedIngress)
  ) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'session_is_not_external',
    };
  }
  const parsedMetadata = canonicalizedIngress as Record<string, unknown>;
  return {
    ok: true,
    metadata: parsedMetadata,
    linkedMetadataResolution,
    historyImportResolution,
    direct: readNonAuthoritativeLinkedExternalSessionV1FromMetadata(parsedMetadata),
  };
}

export function readPersistedLinkedExternalSessionFromRaw(params: Readonly<{
  credentials: StoredCredentials;
  rawSession: RawSessionRecord;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  machineId?: string;
}>): PersistedLinkedExternalSessionReadResult {
  const inspected = inspectPersistedLinkedExternalSessionFromRaw(params);
  if (!inspected.ok) return inspected;
  if (!inspected.linkedMetadataResolution.ok) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: inspected.linkedMetadataResolution.error
        === 'linked_session_invalid'
        ? 'linked_session_metadata_invalid'
        : 'session_is_not_external',
    };
  }
  const direct = inspected.direct;
  if (!direct || direct.linkedAtMs === undefined) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'session_is_not_external',
    };
  }
  if (
    typeof params.machineId === 'string'
    && params.machineId.trim().length > 0
    && direct.machineId !== params.machineId
  ) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'machine_mismatch',
    };
  }
  return {
    ok: true,
    session: {
      rawSession: params.rawSession,
      accountEncryptionMode: params.accountEncryptionMode,
      metadata: inspected.metadata,
      agentId: direct.agentId,
      machineId: direct.machineId,
      remoteSessionId: direct.remoteSessionId,
      linkGeneration: String(direct.linkedAtMs),
      source: direct.source,
      ...(direct.linkData === undefined
        ? {}
        : { linkData: direct.linkData }),
    },
  };
}

export async function loadPersistedLinkedExternalSession(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  machineId?: string;
  expectedIdentity?: ExpectedCurrentExternalSessionLinkIdentity;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>): Promise<PersistedLinkedExternalSessionReadResult> {
  let rawSession: RawSessionRecord | null;
  let accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  try {
    [rawSession, accountEncryptionCurrentness] = await Promise.all([
      fetchSessionById({
        token: params.credentials.token,
        sessionId: params.sessionId,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.deadlineAtMs === undefined
          ? {}
          : { deadlineAtMs: params.deadlineAtMs }),
      }),
      fetchAccountEncryptionCurrentness({
        token: params.credentials.token,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
    ]);
  } catch {
    return {
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'session_load_unavailable',
    };
  }
  if (!rawSession) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'session_not_found',
    };
  }
  const loaded = readPersistedLinkedExternalSessionFromRaw({
    credentials: params.credentials,
    rawSession,
    accountEncryptionMode: accountEncryptionCurrentness.mode,
    ...(params.machineId ? { machineId: params.machineId } : {}),
  });
  if (
    !loaded.ok
    || !params.expectedIdentity
    || await resolveExpectedCurrentLinkSourceKey({
      session: loaded.session,
      expected: params.expectedIdentity,
    })
  ) {
    return loaded;
  }
  return {
    ok: false,
    errorCode: 'invalid_request',
    error: 'linked_session_identity_mismatch',
  };
}

export async function loadLinkedExternalSession(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  machineId?: string;
  expectedIdentity?: ExpectedCurrentExternalSessionLinkIdentity;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>, deps: LoadLinkedExternalSessionDeps = {}): Promise<
  | Readonly<{ ok: true; session: LoadedLinkedExternalSession }>
  | Readonly<{ ok: false; errorCode: 'invalid_request' | 'agent_unavailable'; error: string }>
> {
  let rawSession: RawSessionRecord | null;
  let accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  try {
    [rawSession, accountEncryptionCurrentness] = await Promise.all([
      fetchSessionById({
        token: params.credentials.token,
        sessionId: params.sessionId,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.deadlineAtMs === undefined
          ? {}
          : { deadlineAtMs: params.deadlineAtMs }),
      }),
      fetchAccountEncryptionCurrentness({
        token: params.credentials.token,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
    ]);
  } catch {
    return {
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'session_load_unavailable',
    };
  }
  if (!rawSession) {
    return { ok: false, errorCode: 'invalid_request', error: 'session_not_found' };
  }

  return await loadLinkedExternalSessionFromRaw({
    credentials: params.credentials,
    rawSession,
    accountEncryptionMode: accountEncryptionCurrentness.mode,
    ...(params.machineId ? { machineId: params.machineId } : {}),
    ...(params.expectedIdentity
      ? { expectedIdentity: params.expectedIdentity }
      : {}),
  }, deps);
}

export async function loadLinkedExternalSessionFromRaw(params: Readonly<{
  credentials: StoredCredentials;
  rawSession: RawSessionRecord;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  machineId?: string;
  expectedIdentity?: ExpectedCurrentExternalSessionLinkIdentity;
}>, deps: LoadLinkedExternalSessionDeps = {}): Promise<
  | Readonly<{ ok: true; session: LoadedLinkedExternalSession }>
  | Readonly<{ ok: false; errorCode: 'invalid_request' | 'agent_unavailable'; error: string }>
> {
  const rawSession = params.rawSession;
  const inspected = inspectPersistedLinkedExternalSessionFromRaw(params);
  if (!inspected.ok) return inspected;
  const {
    direct,
    historyImportResolution,
    linkedMetadataResolution,
    metadata: parsedMetadata,
  } = inspected;
  if (!direct || direct.linkedAtMs === undefined) {
    const hostedIdentity = params.expectedIdentity;
    if (
      !hostedIdentity
      || linkedMetadataResolution.ok
      || linkedMetadataResolution.error !== 'linked_session_not_found'
      || historyImportResolution.state === 'valid'
      || !metadataProvesHostedExternalSessionIdentity({
        metadata: parsedMetadata,
        currentStorageState: rawSession.currentStorageState,
        currentStorageStateWasOmitted:
          !Object.prototype.hasOwnProperty.call(
            rawSession,
            'currentStorageState',
          ),
        expected: hostedIdentity,
      })
    ) {
      return { ok: false, errorCode: 'invalid_request', error: 'session_is_not_external' };
    }

    const runtimeDescriptorV1 =
      readRuntimeDescriptorV1FromMetadata(parsedMetadata);
    const hostedMetadata = buildLinkedExternalSessionMetadataV1(
      parsedMetadata,
      {
        v: 1,
        agentId: hostedIdentity.agentId,
        machineId: hostedIdentity.machineId,
        remoteSessionId: hostedIdentity.remoteSessionId,
        source: hostedIdentity.source,
        ...(runtimeDescriptorV1
          ? { runtimeDescriptorV1 }
          : {}),
      },
    );
    const admitted = deps.admitPersistedSourceBeforeCanonicalization
      ? await deps.admitPersistedSourceBeforeCanonicalization({
          agentId: hostedIdentity.agentId,
          machineId: hostedIdentity.machineId,
          remoteSessionId: hostedIdentity.remoteSessionId,
          source: hostedIdentity.source,
        })
      : null;
    if (deps.admitPersistedSourceBeforeCanonicalization && !admitted) {
      return {
        ok: false,
        errorCode: 'invalid_request',
        error: 'linked_session_source_not_current',
      };
    }
    const canonicalized = await canonicalizeLinkedExternalSessionSource({
      agentId: hostedIdentity.agentId,
      metadata: hostedMetadata,
      remoteSessionId: hostedIdentity.remoteSessionId,
      source: admitted?.source ?? hostedIdentity.source,
    }, deps.resolveExternalSessionProviderOps
      ? { resolveExternalSessionProviderOps: deps.resolveExternalSessionProviderOps }
      : {});
    const sessionPath =
      typeof parsedMetadata.path === 'string'
      && parsedMetadata.path.trim().length > 0
        ? parsedMetadata.path.trim()
        : null;
    const loadedSession: LoadedLinkedExternalSession = {
      rawSession,
      metadata: hostedMetadata,
      sessionPath,
      agentId: hostedIdentity.agentId,
      machineId: hostedIdentity.machineId,
      remoteSessionId: canonicalized.remoteSessionId,
      linkGeneration: rawSession.id,
      source: canonicalized.source,
      ...(admitted
        ? {
            externalLinkedTakeoverWriterSafety:
              admitted.externalLinkedTakeoverWriterSafety,
          }
        : {}),
    };
    const canonicalResolvedSourceKey = await resolveExpectedCurrentLinkSourceKey({
      session: loadedSession,
      expected: hostedIdentity,
    }, deps);
    if (!canonicalResolvedSourceKey) {
      return {
        ok: false,
        errorCode: 'invalid_request',
        error: 'linked_session_identity_mismatch',
      };
    }
    return {
      ok: true,
      session: { ...loadedSession, canonicalResolvedSourceKey },
    };
  }
  const normalizedMetadata = parsedMetadata;
  if (typeof params.machineId === 'string' && params.machineId.trim().length > 0 && direct.machineId !== params.machineId) {
    return { ok: false, errorCode: 'invalid_request', error: 'machine_mismatch' };
  }

  const sessionPath = typeof parsedMetadata.path === 'string' && parsedMetadata.path.trim().length > 0
    ? parsedMetadata.path.trim()
    : null;
  const admitted = deps.admitPersistedSourceBeforeCanonicalization
    ? await deps.admitPersistedSourceBeforeCanonicalization({
        agentId: direct.agentId,
        machineId: direct.machineId,
        remoteSessionId: direct.remoteSessionId,
        source: direct.source,
      })
    : null;
  if (deps.admitPersistedSourceBeforeCanonicalization && !admitted) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'linked_session_source_not_current',
    };
  }
  const canonicalized = await canonicalizeLinkedExternalSessionSource({
    agentId: direct.agentId,
    metadata: normalizedMetadata,
    remoteSessionId: direct.remoteSessionId,
    source: admitted?.source ?? direct.source,
  }, deps.resolveExternalSessionProviderOps
    ? { resolveExternalSessionProviderOps: deps.resolveExternalSessionProviderOps }
    : {});
  const loadedSession: LoadedLinkedExternalSession = {
    rawSession,
    metadata: normalizedMetadata,
    sessionPath,
    agentId: direct.agentId,
    machineId: direct.machineId,
    remoteSessionId: canonicalized.remoteSessionId,
    linkGeneration: String(direct.linkedAtMs),
    source: canonicalized.source,
    ...(admitted
      ? {
          externalLinkedTakeoverWriterSafety:
            admitted.externalLinkedTakeoverWriterSafety,
        }
      : {}),
    ...(direct.linkData === undefined
      ? {}
      : { linkData: direct.linkData }),
  };
  const canonicalResolvedSourceKey = params.expectedIdentity
    ? await resolveExpectedCurrentLinkSourceKey({
        session: loadedSession,
        expected: params.expectedIdentity,
      }, deps)
    : null;
  if (params.expectedIdentity && !canonicalResolvedSourceKey) {
    return {
      ok: false,
      errorCode: 'invalid_request',
      error: 'linked_session_identity_mismatch',
    };
  }
  return canonicalResolvedSourceKey
    ? { ok: true, session: { ...loadedSession, canonicalResolvedSourceKey } }
    : { ok: true, session: loadedSession };
}
