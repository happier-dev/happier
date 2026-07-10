import {
  createSessionStateSyncEngine,
  resolveFingerprintPublication,
  rollbackFingerprintPublication,
  type MetadataUpdatePort,
  type SessionStateFieldWriteValue,
} from '@happier-dev/plugin-sdk/sessions';
import type {
  ExternalSessionsSource,
  RuntimeDescriptorMetadataCarrier,
  RuntimeDescriptorV1,
  SessionMetadata,
  SessionStateCapabilitiesV1,
} from '@happier-dev/plugin-sdk/sessions';
import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/plugin-sdk/sessions';

import { readCanonicalCodexRuntimeDescriptorV1 } from '../../../identity/runtimeDescriptor.js';
import {
  buildCodexAgentRuntimeDescriptor,
  normalizeCodexBackendMode,
  type CodexBackendMode,
} from '../../../../protocol/runtimeDescriptorV1.js';
import { inferCodexExternalSessionsSourceFromHome } from './sourceValidation.js';

type LinkedExternalSessionMetadataCompatV1 = Readonly<Partial<RuntimeDescriptorMetadataCarrier>> & {
  v: 1;
  agentId: string;
  machineId: string;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  linkedAtMs: number;
};

type CodexExternalSessionMetadataV1 = LinkedExternalSessionMetadataCompatV1 & {
  agentId: 'codex';
};

type CodexBackendModeCompat = CodexBackendMode | 'mcp';

export type CodexSessionIdentityMetadata = SessionMetadata & Readonly<Partial<RuntimeDescriptorMetadataCarrier>> & {
  codexSessionId?: string;
  codexBackendMode?: CodexBackendModeCompat;
  externalSessionV1?: LinkedExternalSessionMetadataCompatV1;
};

export type CodexExternalSessionLinkIdentity = Readonly<{
  remoteSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
}>;

export type CodexSessionIdentityPublicationState = {
  value: string | null;
  fingerprint?: string | null;
  runtimeDescriptorSessionId?: string | null;
};

const PROVIDER_SESSION_ID_METADATA_CAPABILITIES: SessionStateCapabilitiesV1 = {
  identity: {
    providerSessionId: {
      supported: true,
      happierToProvider: { supported: false },
      providerToHappier: { supported: false },
    },
  },
};

const RUNTIME_DESCRIPTOR_METADATA_CAPABILITIES: SessionStateCapabilitiesV1 = {
  identity: {
    runtimeDescriptor: {
      supported: true,
      happierToProvider: { supported: false },
      providerToHappier: { supported: false },
    },
  },
};

function resolveCodexRuntimeSourceAffinity(params: Readonly<{
  codexHome?: string | null;
  activeServerDir?: string | null;
}>): Readonly<{
  home: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
  homePath?: string;
}> {
  const source = inferCodexExternalSessionsSourceFromHome(params);
  if (source.home === 'connectedService') {
    return {
      home: 'connectedService',
      ...('connectedServiceId' in source && typeof source.connectedServiceId === 'string'
        ? { connectedServiceId: source.connectedServiceId }
        : {}),
      ...('connectedServiceProfileId' in source && typeof source.connectedServiceProfileId === 'string'
        ? { connectedServiceProfileId: source.connectedServiceProfileId }
        : {}),
      ...('connectedServiceGroupId' in source && typeof source.connectedServiceGroupId === 'string'
        ? { connectedServiceGroupId: source.connectedServiceGroupId }
        : {}),
      ...('homePath' in source && typeof source.homePath === 'string' ? { homePath: source.homePath } : {}),
    };
  }

  return {
    home: 'user',
    ...('homePath' in source && typeof source.homePath === 'string' ? { homePath: source.homePath } : {}),
  };
}

function buildCodexRuntimeDescriptor(params: Readonly<{
  backendMode: CodexBackendMode | null | undefined;
  providerSessionId: string;
  codexHome?: string | null;
  activeServerDir?: string | null;
}>): RuntimeDescriptorV1 | null {
  const backendMode = normalizeCodexBackendMode(params.backendMode);
  if (!backendMode) return null;

  return buildCodexAgentRuntimeDescriptor({
    backendMode,
    providerSessionId: params.providerSessionId,
    ...resolveCodexRuntimeSourceAffinity(params),
  });
}

function readCanonicalCodexRuntimeDescriptor(value: RuntimeDescriptorV1 | null | undefined) {
  return readCanonicalCodexRuntimeDescriptorV1(value);
}

function resolveCodexExternalSessionSourceAffinity(source: ExternalSessionsSource): Readonly<{
  home: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
  homePath?: string;
}> {
  if (source.kind !== 'codexHome' || source.home !== 'connectedService') {
    return {
      home: 'user',
      ...(typeof source.homePath === 'string' && source.homePath.trim().length > 0
        ? { homePath: source.homePath.trim() }
        : {}),
    };
  }

  return {
    home: 'connectedService',
    ...(typeof source.connectedServiceId === 'string' && source.connectedServiceId.trim().length > 0
      ? { connectedServiceId: source.connectedServiceId.trim() }
      : {}),
    ...(typeof source.connectedServiceProfileId === 'string' && source.connectedServiceProfileId.trim().length > 0
      ? { connectedServiceProfileId: source.connectedServiceProfileId.trim() }
      : {}),
    ...(typeof source.connectedServiceGroupId === 'string' && source.connectedServiceGroupId.trim().length > 0
      ? { connectedServiceGroupId: source.connectedServiceGroupId.trim() }
      : {}),
    ...(typeof source.homePath === 'string' && source.homePath.trim().length > 0
      ? { homePath: source.homePath.trim() }
      : {}),
  };
}

function buildCodexExternalSessionSource(params: Readonly<{
  home: 'user' | 'connectedService';
  sourceAffinity: ReturnType<typeof resolveCodexExternalSessionSourceAffinity>;
  canonicalRuntimeDescriptor: NonNullable<ReturnType<typeof readCanonicalCodexRuntimeDescriptor>>;
}>): ExternalSessionsSource {
  if (params.home === 'connectedService') {
    const connectedServiceId =
      params.canonicalRuntimeDescriptor.connectedServiceId ?? params.sourceAffinity.connectedServiceId;
    const connectedServiceProfileId =
      params.canonicalRuntimeDescriptor.connectedServiceProfileId ?? params.sourceAffinity.connectedServiceProfileId;
    const connectedServiceGroupId =
      params.canonicalRuntimeDescriptor.connectedServiceGroupId ?? params.sourceAffinity.connectedServiceGroupId;
    const homePath = params.canonicalRuntimeDescriptor.homePath ?? params.sourceAffinity.homePath;
    return {
      kind: 'codexHome',
      home: 'connectedService',
      ...(connectedServiceId ? { connectedServiceId } : {}),
      ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
      ...(connectedServiceGroupId ? { connectedServiceGroupId } : {}),
      ...(homePath ? { homePath } : {}),
    };
  }

  const homePath = params.canonicalRuntimeDescriptor.homePath ?? params.sourceAffinity.homePath;
  return {
    kind: 'codexHome',
    home: 'user',
    ...(homePath ? { homePath } : {}),
  };
}

export function resolveCodexExternalSessionLinkIdentity(params: Readonly<{
  remoteSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  metadata?: Record<string, unknown>;
}>): CodexExternalSessionLinkIdentity {
  const canonicalRuntimeDescriptor = readCanonicalCodexRuntimeDescriptor(params.runtimeDescriptor ?? null);
  const runtimeProviderSessionId = canonicalRuntimeDescriptor?.providerSessionId ?? '';
  const remoteSessionId = runtimeProviderSessionId || params.remoteSessionId;
  const codexBackendMode = normalizeCodexBackendMode(canonicalRuntimeDescriptor?.backendMode)
    ?? normalizeCodexBackendMode(params.metadata?.codexBackendMode)
    ?? null;

  if (!codexBackendMode) {
    return {
      remoteSessionId,
      source: params.source,
      runtimeDescriptor: params.runtimeDescriptor ?? null,
    };
  }

  const sourceAffinity = resolveCodexExternalSessionSourceAffinity(params.source);
  const source: ExternalSessionsSource = canonicalRuntimeDescriptor?.home
    ? buildCodexExternalSessionSource({
      home: canonicalRuntimeDescriptor.home,
      sourceAffinity,
      canonicalRuntimeDescriptor,
    })
    : params.source;

  return {
    remoteSessionId,
    source,
    vendorMetadata: {
      codexBackendMode,
    },
    externalSessionMetadata: {
      codexBackendMode,
    },
    runtimeDescriptor: buildCodexAgentRuntimeDescriptor({
      backendMode: codexBackendMode,
      providerSessionId: remoteSessionId,
      home: canonicalRuntimeDescriptor?.home ?? sourceAffinity.home,
      connectedServiceId: canonicalRuntimeDescriptor?.connectedServiceId ?? sourceAffinity.connectedServiceId,
      connectedServiceProfileId:
        canonicalRuntimeDescriptor?.connectedServiceProfileId ?? sourceAffinity.connectedServiceProfileId,
      connectedServiceGroupId:
        canonicalRuntimeDescriptor?.connectedServiceGroupId ?? sourceAffinity.connectedServiceGroupId,
      homePath: canonicalRuntimeDescriptor?.homePath ?? sourceAffinity.homePath,
    }),
  };
}

export function buildCodexExternalSessionMetadata(
  metadata: CodexSessionIdentityMetadata,
  providerSessionId: string,
  params: Readonly<{
    transcriptStorage?: 'persisted' | 'direct' | null;
    backendMode?: CodexBackendMode | null;
    codexHome?: string | null;
    activeServerDir?: string | null;
    nowMs?: number;
  }>,
): CodexSessionIdentityMetadata {
  if (params.transcriptStorage !== 'direct') {
    const nextMetadata: CodexSessionIdentityMetadata = { ...metadata };
    delete nextMetadata.externalSessionV1;
    return nextMetadata;
  }

  const machineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
  if (!machineId) {
    const nextMetadata: CodexSessionIdentityMetadata = { ...metadata };
    delete nextMetadata.externalSessionV1;
    return nextMetadata;
  }

  const runtimeDescriptor = buildCodexRuntimeDescriptor({
    backendMode: params.backendMode,
    providerSessionId,
    codexHome: params.codexHome,
    activeServerDir: params.activeServerDir,
  });
  const previousExternalSession = metadata.externalSessionV1 && typeof metadata.externalSessionV1 === 'object'
    ? metadata.externalSessionV1
    : undefined;
  const externalSessionBase: CodexExternalSessionMetadataV1 = {
    ...(previousExternalSession ?? {}),
    v: 1,
    agentId: 'codex',
    machineId,
    remoteSessionId: providerSessionId,
    source: inferCodexExternalSessionsSourceFromHome(params),
    linkedAtMs: params.nowMs ?? Date.now(),
  };

  return {
    ...metadata,
    externalSessionV1: runtimeDescriptor
      ? applyRuntimeDescriptorSessionMetadata(externalSessionBase, runtimeDescriptor)
      : externalSessionBase,
  };
}

function publishCodexProviderSessionId(params: Readonly<{
  sessionId?: string | null;
  providerSessionId: string;
  updateHappySessionMetadata: (updater: (metadata: CodexSessionIdentityMetadata) => CodexSessionIdentityMetadata) => Promise<void> | void;
  lastPublished: CodexSessionIdentityPublicationState;
  backendMode: CodexBackendMode | null;
}>): void {
  if (params.lastPublished.value === params.providerSessionId) return;
  const previousValue = params.lastPublished.value;
  params.lastPublished.value = params.providerSessionId;
  const happierSessionId = typeof params.sessionId === 'string' && params.sessionId.trim()
    ? params.sessionId.trim()
    : params.providerSessionId;
  const rollBackPublishedValue = (): void => {
    if (params.lastPublished.value === params.providerSessionId) {
      params.lastPublished.value = previousValue;
    }
  };

  try {
    const metadataPort: MetadataUpdatePort = {
      update: async (_sessionId, updater) => {
        try {
          await Promise.resolve(params.updateHappySessionMetadata((metadata) => {
            const nextMetadata = updater(metadata) as CodexSessionIdentityMetadata;
            if (!params.backendMode) {
              const withoutBackendMode: CodexSessionIdentityMetadata = { ...nextMetadata };
              delete withoutBackendMode.codexBackendMode;
              return withoutBackendMode;
            }
            return {
              ...nextMetadata,
              codexBackendMode: params.backendMode,
            };
          }));
        } catch {
          rollBackPublishedValue();
          return { ok: false, reason: 'unknown_error' };
        }
        return { ok: true, version: 0 };
      },
    };
    const result = createSessionStateSyncEngine({
      capabilities: PROVIDER_SESSION_ID_METADATA_CAPABILITIES,
      facet: null,
      metadataPort,
    }).writeHappierField({
      sessionId: happierSessionId,
      fieldId: 'identity.providerSessionId',
      value: {
        metadataKey: 'codexSessionId',
        value: params.providerSessionId,
      },
      reason: 'reconciliation',
      metadataReason: 'runtime-provider-session-id',
      mirrorToProvider: false,
    });
    void Promise.resolve(result).then((writeResult) => {
      if (!writeResult.ok) rollBackPublishedValue();
    }).catch(() => {
      rollBackPublishedValue();
    });
  } catch {
    rollBackPublishedValue();
  }
}

async function publishCodexRuntimeDescriptor(params: Readonly<{
  providerSessionId: string;
  fingerprint: string;
  publicationState: CodexSessionIdentityPublicationState;
  updateHappySessionMetadata: (updater: (metadata: CodexSessionIdentityMetadata) => CodexSessionIdentityMetadata) => Promise<void> | void;
  runtimeDescriptor: RuntimeDescriptorV1 | null;
  buildMetadata: (metadata: CodexSessionIdentityMetadata) => CodexSessionIdentityMetadata;
}>): Promise<void> {
  const previousSessionId = params.publicationState.runtimeDescriptorSessionId ?? null;
  const previousFingerprint = params.publicationState.fingerprint ?? null;
  const fingerprintDecision = resolveFingerprintPublication({
    state: {
      lastPublishedFingerprint: previousFingerprint,
      rollbackFingerprint: null,
    },
    nextFingerprint: params.fingerprint,
  });

  if (previousSessionId === params.providerSessionId && !fingerprintDecision.publish) {
    return;
  }

  params.publicationState.runtimeDescriptorSessionId = params.providerSessionId;
  params.publicationState.fingerprint = fingerprintDecision.state.lastPublishedFingerprint ?? undefined;

  const rollbackPublicationState = (): void => {
    const fingerprintState = fingerprintDecision.publish
      ? rollbackFingerprintPublication(fingerprintDecision.state)
      : { lastPublishedFingerprint: previousFingerprint };
    params.publicationState.runtimeDescriptorSessionId = previousSessionId ?? undefined;
    params.publicationState.fingerprint = fingerprintState.lastPublishedFingerprint ?? undefined;
  };

  try {
    const metadataPort: MetadataUpdatePort = {
      update: async (_sessionId, updater) => {
        await Promise.resolve(params.updateHappySessionMetadata((metadata) =>
          params.buildMetadata(updater(metadata) as CodexSessionIdentityMetadata),
        ));
        return { ok: true, version: 0 };
      },
    };
    const result = await createSessionStateSyncEngine({
      capabilities: RUNTIME_DESCRIPTOR_METADATA_CAPABILITIES,
      facet: null,
      metadataPort,
    }).writeHappierField({
      sessionId: params.providerSessionId,
      fieldId: 'identity.runtimeDescriptor',
      value: params.runtimeDescriptor as SessionStateFieldWriteValue<'identity.runtimeDescriptor'>,
      reason: 'reconciliation',
      metadataReason: 'runtime-descriptor-publication',
      mirrorToProvider: false,
    });
    if (!result.ok) {
      rollbackPublicationState();
    }
  } catch {
    rollbackPublicationState();
  }
}

export function maybeUpdateCodexSessionIdMetadata(params: Readonly<{
  getCodexThreadId: () => string | null;
  sessionId?: string | null;
  backendMode?: CodexBackendMode | null;
  transcriptStorage?: 'persisted' | 'direct' | null;
  codexHome?: string | null;
  activeServerDir?: string | null;
  updateHappySessionMetadata: (updater: (metadata: CodexSessionIdentityMetadata) => CodexSessionIdentityMetadata) => Promise<void> | void;
  lastPublished: CodexSessionIdentityPublicationState;
}>): void {
  const raw = params.getCodexThreadId();
  const providerSessionId = typeof raw === 'string' ? raw.trim() : '';
  if (!providerSessionId) return;

  const backendMode = normalizeCodexBackendMode(params.backendMode);
  const externalSource = inferCodexExternalSessionsSourceFromHome(params);
  const publishFingerprint = JSON.stringify({
    backendMode,
    transcriptStorage: params.transcriptStorage ?? null,
    source: externalSource,
  });
  const canonicalRuntimeDescriptor = buildCodexRuntimeDescriptor({
    backendMode,
    providerSessionId,
    codexHome: params.codexHome,
    activeServerDir: params.activeServerDir,
  });

  publishCodexProviderSessionId({
    sessionId: params.sessionId,
    providerSessionId,
    updateHappySessionMetadata: params.updateHappySessionMetadata,
    lastPublished: params.lastPublished,
    backendMode,
  });

  void publishCodexRuntimeDescriptor({
    providerSessionId,
    fingerprint: publishFingerprint,
    publicationState: params.lastPublished,
    updateHappySessionMetadata: params.updateHappySessionMetadata,
    runtimeDescriptor: canonicalRuntimeDescriptor,
    buildMetadata: (metadata) => {
      let nextMetadata: CodexSessionIdentityMetadata = { ...metadata };
      if (!backendMode) {
        delete nextMetadata.codexBackendMode;
      }

      nextMetadata = {
        ...nextMetadata,
        ...(backendMode ? { codexBackendMode: backendMode } : {}),
      };
      return buildCodexExternalSessionMetadata(nextMetadata, providerSessionId, { ...params, backendMode });
    },
  });
}

export function publishCodexSessionIdMetadata<TMetadata extends SessionMetadata>(params: Readonly<{
  session: Readonly<{
    sessionId?: string | null;
    updateMetadata: (updater: (metadata: TMetadata) => TMetadata) => Promise<void> | void;
  }>;
  getCodexThreadId: () => string | null;
  backendMode?: CodexBackendMode | null;
  transcriptStorage?: 'persisted' | 'direct' | null;
  codexHome?: string | null;
  activeServerDir?: string | null;
  lastPublished: CodexSessionIdentityPublicationState;
}>): void {
  maybeUpdateCodexSessionIdMetadata({
    sessionId: params.session.sessionId,
    getCodexThreadId: params.getCodexThreadId,
    backendMode: params.backendMode,
    transcriptStorage: params.transcriptStorage,
    codexHome: params.codexHome,
    activeServerDir: params.activeServerDir,
    updateHappySessionMetadata: (updater) => params.session.updateMetadata((metadata) =>
      updater(metadata as CodexSessionIdentityMetadata) as TMetadata,
    ),
    lastPublished: params.lastPublished,
  });
}
