import {
  buildCodexAgentRuntimeDescriptor,
  normalizeCodexBackendMode,
  type CodexBackendMode,
} from '@happier-dev/agents';
import {
  readCanonicalRuntimeDescriptorV1ForProvider,
  type ExternalSessionsSource,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import type { ExternalSessionLinkIdentity } from '@/session/external/providerOps';

function readCanonicalCodexRuntimeDescriptor(value: RuntimeDescriptorV1 | null | undefined) {
  return readCanonicalRuntimeDescriptorV1ForProvider(value, 'codex');
}

function resolveCodexRuntimeSourceAffinity(source: ExternalSessionsSource): Readonly<{
  home: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
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
    ...(typeof source.homePath === 'string' && source.homePath.trim().length > 0
      ? { homePath: source.homePath.trim() }
      : {}),
  };
}

function buildCodexExternalSessionSource(params: Readonly<{
  home: 'user' | 'connectedService';
  sourceAffinity: ReturnType<typeof resolveCodexRuntimeSourceAffinity>;
  canonicalRuntimeDescriptor: NonNullable<ReturnType<typeof readCanonicalCodexRuntimeDescriptor>>;
}>): ExternalSessionsSource {
  if (params.home === 'connectedService') {
    const connectedServiceId =
      params.canonicalRuntimeDescriptor.connectedServiceId ?? params.sourceAffinity.connectedServiceId;
    const connectedServiceProfileId =
      params.canonicalRuntimeDescriptor.connectedServiceProfileId ?? params.sourceAffinity.connectedServiceProfileId;
    const homePath = params.canonicalRuntimeDescriptor.homePath ?? params.sourceAffinity.homePath;
    return {
      kind: 'codexHome',
      home: 'connectedService',
      ...(connectedServiceId ? { connectedServiceId } : {}),
      ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
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
}>): ExternalSessionLinkIdentity {
  const canonicalRuntimeDescriptor = readCanonicalCodexRuntimeDescriptor(params.runtimeDescriptor ?? null);
  const runtimeVendorSessionId = canonicalRuntimeDescriptor?.vendorSessionId ?? '';
  const remoteSessionId = runtimeVendorSessionId || params.remoteSessionId;
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

  const sourceAffinity = resolveCodexRuntimeSourceAffinity(params.source);
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
      backendMode: codexBackendMode as CodexBackendMode,
      vendorSessionId: remoteSessionId,
      home: canonicalRuntimeDescriptor?.home ?? sourceAffinity.home,
      connectedServiceId: canonicalRuntimeDescriptor?.connectedServiceId ?? sourceAffinity.connectedServiceId,
      connectedServiceProfileId:
        canonicalRuntimeDescriptor?.connectedServiceProfileId ?? sourceAffinity.connectedServiceProfileId,
      homePath: canonicalRuntimeDescriptor?.homePath ?? sourceAffinity.homePath,
    }),
  };
}
