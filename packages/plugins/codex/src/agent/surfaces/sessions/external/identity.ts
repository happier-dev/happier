import {
  buildCodexAgentRuntimeDescriptor,
  normalizeCodexBackendMode,
  readCanonicalCodexAgentRuntimeDescriptorV1,
} from '../../../../protocol/runtimeDescriptorV1.js';
import type { CodexExternalSessionSource } from './models.js';

type CodexRuntimeDescriptor = ReturnType<typeof buildCodexAgentRuntimeDescriptor>;

export type CodexExternalSessionLinkIdentity = Readonly<{
  remoteSessionId: string;
  source: CodexExternalSessionSource;
  runtimeDescriptor?: CodexRuntimeDescriptor | null;
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
}>;
function readCanonicalCodexRuntimeDescriptor(value: unknown) {
  return readCanonicalCodexAgentRuntimeDescriptorV1(value);
}

function resolveCodexExternalSessionSourceAffinity(source: CodexExternalSessionSource): Readonly<{
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
}>): CodexExternalSessionSource {
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
  source: CodexExternalSessionSource;
  runtimeDescriptor?: unknown;
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
    };
  }

  const sourceAffinity = resolveCodexExternalSessionSourceAffinity(params.source);
  const source: CodexExternalSessionSource = canonicalRuntimeDescriptor?.home
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
