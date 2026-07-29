import {
  buildLinkedExternalSessionMetadataV1,
  normalizeLinkedExternalSessionMetadataV1,
  normalizeCodexBackendMode,
  readExternalHistoryImportV1FromMetadata,
  readLinkedExternalSessionV1FromMetadata,
  resolveLinkedExternalSessionMetadataV1,
  readRuntimeDescriptorV1FromMetadata,
  readRuntimeDescriptorV1,
  type RuntimeDescriptorV1,
  type CodexBackendMode,
  type ExternalSessionsAgentId,
  type ExternalSessionsSource,
  type PluginAgentExternalSessionLinkData,
} from '@happier-dev/protocol';
import {
  resolvePersistedCodexRuntimeIdentity,
} from '@happier-dev/plugins-codex/agent/identity/runtimeDescriptor';
import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import type { Credentials } from '@/persistence';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import {
  tryDecryptSessionOwnerMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  canonicalizeLinkedExternalSessionSource,
  resolveExternalSessionLinkIdentity,
} from '@/agent/runtime/bridges/session/externalSessionSourceCanonicalization';
import {
  metadataProvesHostedExternalSessionIdentity,
} from '@/api/session/external/linking/hostedExternalSessionIdentity';

function readExternalSessionRuntimeDescriptor(value: Readonly<Record<string, unknown>>): RuntimeDescriptorV1 | null {
  return readRuntimeDescriptorV1FromMetadata(value)
    ?? readRuntimeDescriptorV1(value.runtimeDescriptorV1);
}

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
  const topLevelRuntimeDescriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  const externalSession = readLinkedExternalSessionV1FromMetadata(metadata);
  const externalSessionRuntimeDescriptor = externalSession ? readExternalSessionRuntimeDescriptor(externalSession) : null;
  const canonicalMetadata = applyRuntimeDescriptorSessionStateBinding(metadata, topLevelRuntimeDescriptor);

  if (!externalSession || !externalSessionRuntimeDescriptor) {
    return canonicalMetadata;
  }

  const externalSessionWithRuntimeDescriptor = readLinkedExternalSessionV1FromMetadata({
    externalSessionV1: applyRuntimeDescriptorSessionStateBinding(
      externalSession,
      externalSessionRuntimeDescriptor,
    ),
  });
  return externalSessionWithRuntimeDescriptor
    ? buildLinkedExternalSessionMetadataV1(canonicalMetadata, externalSessionWithRuntimeDescriptor)
    : canonicalMetadata;
}

function buildCanonicalLinkedExternalSessionMetadata(
  metadata: Readonly<Record<string, unknown>>,
  externalSession: Readonly<Record<string, unknown>>,
  runtimeDescriptorV1: RuntimeDescriptorV1 | null,
): Record<string, unknown> {
  if (!runtimeDescriptorV1) return { ...metadata };

  return {
    ...applyRuntimeDescriptorSessionStateBinding(metadata, runtimeDescriptorV1),
    externalSessionV1: {
      ...applyRuntimeDescriptorSessionStateBinding(externalSession, runtimeDescriptorV1),
    },
  };
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
  linkData?: PluginAgentExternalSessionLinkData;
  codexBackendMode: CodexBackendMode | null;
}>;

export type ExpectedHostedExternalSessionIdentity = Readonly<{
  agentId: ExternalSessionsAgentId;
  machineId: string;
  remoteSessionId: string;
  source: ExternalSessionsSource;
}>;

export type PersistedLinkedExternalSession = Readonly<{
  rawSession: RawSessionRecord;
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
  credentials: Credentials;
  rawSession: RawSessionRecord;
}>):
  | Readonly<{
      ok: true;
      metadata: Record<string, unknown>;
      linkedMetadataResolution: ReturnType<
        typeof resolveLinkedExternalSessionMetadataV1
      >;
      direct: ReturnType<typeof readLinkedExternalSessionV1FromMetadata>;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'invalid_request' | 'agent_unavailable';
      error: string;
    }> {
  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession: params.rawSession,
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
    direct: readLinkedExternalSessionV1FromMetadata(parsedMetadata),
  };
}

export function readPersistedLinkedExternalSessionFromRaw(params: Readonly<{
  credentials: Credentials;
  rawSession: RawSessionRecord;
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
  const runtimeDescriptor = readExternalSessionRuntimeDescriptor(direct);
  const metadata = buildCanonicalLinkedExternalSessionMetadata(
    inspected.metadata,
    direct,
    runtimeDescriptor,
  );
  return {
    ok: true,
    session: {
      rawSession: params.rawSession,
      metadata,
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
  credentials: Credentials;
  sessionId: string;
  machineId?: string;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>): Promise<PersistedLinkedExternalSessionReadResult> {
  let rawSession: RawSessionRecord | null;
  try {
    rawSession = await fetchSessionById({
      token: params.credentials.token,
      sessionId: params.sessionId,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: params.deadlineAtMs }),
    });
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
  return readPersistedLinkedExternalSessionFromRaw({
    credentials: params.credentials,
    rawSession,
    ...(params.machineId ? { machineId: params.machineId } : {}),
  });
}

export async function loadLinkedExternalSession(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  machineId?: string;
  expectedHostedIdentity?: ExpectedHostedExternalSessionIdentity;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>): Promise<
  | Readonly<{ ok: true; session: LoadedLinkedExternalSession }>
  | Readonly<{ ok: false; errorCode: 'invalid_request' | 'agent_unavailable'; error: string }>
> {
  const rawSession = await fetchSessionById({
    token: params.credentials.token,
    sessionId: params.sessionId,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.deadlineAtMs === undefined
      ? {}
      : { deadlineAtMs: params.deadlineAtMs }),
  }).catch(() => null);
  if (!rawSession) {
    return { ok: false, errorCode: 'invalid_request', error: 'session_not_found' };
  }

  return await loadLinkedExternalSessionFromRaw({
    credentials: params.credentials,
    rawSession,
    ...(params.machineId ? { machineId: params.machineId } : {}),
    ...(params.expectedHostedIdentity
      ? { expectedHostedIdentity: params.expectedHostedIdentity }
      : {}),
  });
}

export async function loadLinkedExternalSessionFromRaw(params: Readonly<{
  credentials: Credentials;
  rawSession: RawSessionRecord;
  machineId?: string;
  expectedHostedIdentity?: ExpectedHostedExternalSessionIdentity;
}>): Promise<
  | Readonly<{ ok: true; session: LoadedLinkedExternalSession }>
  | Readonly<{ ok: false; errorCode: 'invalid_request' | 'agent_unavailable'; error: string }>
> {
  const rawSession = params.rawSession;
  const inspected = inspectPersistedLinkedExternalSessionFromRaw(params);
  if (!inspected.ok) return inspected;
  const {
    direct,
    linkedMetadataResolution,
    metadata: parsedMetadata,
  } = inspected;
  if (!direct || direct.linkedAtMs === undefined) {
    const hostedIdentity = params.expectedHostedIdentity;
    if (
      !hostedIdentity
      || linkedMetadataResolution.ok
      || linkedMetadataResolution.error !== 'linked_session_not_found'
      || readExternalHistoryImportV1FromMetadata(parsedMetadata)
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
    const canonicalized = runtimeDescriptorV1
      ? await resolveExternalSessionLinkIdentity({
          agentId: hostedIdentity.agentId,
          metadata: hostedMetadata,
          remoteSessionId: hostedIdentity.remoteSessionId,
          source: hostedIdentity.source,
          runtimeDescriptor: runtimeDescriptorV1,
        })
      : await canonicalizeLinkedExternalSessionSource({
          agentId: hostedIdentity.agentId,
          metadata: hostedMetadata,
          remoteSessionId: hostedIdentity.remoteSessionId,
          source: hostedIdentity.source,
        });
    const sessionPath =
      typeof parsedMetadata.path === 'string'
      && parsedMetadata.path.trim().length > 0
        ? parsedMetadata.path.trim()
        : null;
    return {
      ok: true,
      session: {
        rawSession,
        metadata: hostedMetadata,
        sessionPath,
        agentId: hostedIdentity.agentId,
        machineId: hostedIdentity.machineId,
        remoteSessionId: canonicalized.remoteSessionId,
        linkGeneration: rawSession.id,
        source: canonicalized.source,
        codexBackendMode: normalizeCodexBackendMode(
          resolvePersistedCodexRuntimeIdentity(hostedMetadata)?.backendMode,
        ),
      },
    };
  }
  if (
    params.expectedHostedIdentity
    && (
      direct.agentId !== params.expectedHostedIdentity.agentId
      || direct.machineId !== params.expectedHostedIdentity.machineId
      || direct.remoteSessionId !== params.expectedHostedIdentity.remoteSessionId
    )
  ) {
    return { ok: false, errorCode: 'invalid_request', error: 'session_is_not_external' };
  }
  const directRuntimeDescriptor = readExternalSessionRuntimeDescriptor(direct);
  const normalizedMetadata = buildCanonicalLinkedExternalSessionMetadata(
    parsedMetadata,
    direct,
    directRuntimeDescriptor,
  );
  if (typeof params.machineId === 'string' && params.machineId.trim().length > 0 && direct.machineId !== params.machineId) {
    return { ok: false, errorCode: 'invalid_request', error: 'machine_mismatch' };
  }

  const sessionPath = typeof parsedMetadata.path === 'string' && parsedMetadata.path.trim().length > 0
    ? parsedMetadata.path.trim()
    : null;
  const canonicalized = directRuntimeDescriptor
    ? await resolveExternalSessionLinkIdentity({
        agentId: direct.agentId,
        metadata: normalizedMetadata,
        remoteSessionId: direct.remoteSessionId,
        source: direct.source,
        runtimeDescriptor: directRuntimeDescriptor,
      })
    : await canonicalizeLinkedExternalSessionSource({
        agentId: direct.agentId,
        metadata: normalizedMetadata,
        remoteSessionId: direct.remoteSessionId,
        source: direct.source,
      });
  const persistedCodexBackendMode = normalizeCodexBackendMode(
    resolvePersistedCodexRuntimeIdentity(normalizedMetadata)?.backendMode,
  );
  return {
    ok: true,
    session: {
      rawSession,
      metadata: normalizedMetadata,
      sessionPath,
      agentId: direct.agentId,
      machineId: direct.machineId,
      remoteSessionId: canonicalized.remoteSessionId,
      linkGeneration: String(direct.linkedAtMs),
      source: canonicalized.source,
      ...(direct.linkData === undefined
        ? {}
        : { linkData: direct.linkData }),
      codexBackendMode:
        persistedCodexBackendMode
        ?? normalizeCodexBackendMode(direct.codexBackendMode),
    },
  };
}
