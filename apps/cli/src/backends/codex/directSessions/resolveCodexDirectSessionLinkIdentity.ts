import {
  buildCodexAgentRuntimeDescriptor,
  normalizeCodexBackendMode,
  type CodexBackendMode,
} from '@happier-dev/agents';
import {
  readCanonicalAgentRuntimeDescriptorV1ForProvider,
  type AgentRuntimeDescriptorV1,
  type DirectSessionsSource,
} from '@happier-dev/protocol';

import type { DirectSessionLinkIdentity } from '@/backends/directSessions/providerOps';

function readCanonicalCodexRuntimeDescriptor(value: AgentRuntimeDescriptorV1 | null | undefined) {
  return readCanonicalAgentRuntimeDescriptorV1ForProvider(value, 'codex');
}

function resolveCodexRuntimeSourceAffinity(source: DirectSessionsSource): Readonly<{
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

function buildCodexDirectSessionSource(params: Readonly<{
  home: 'user' | 'connectedService';
  sourceAffinity: ReturnType<typeof resolveCodexRuntimeSourceAffinity>;
  canonicalRuntimeDescriptor: NonNullable<ReturnType<typeof readCanonicalCodexRuntimeDescriptor>>;
}>): DirectSessionsSource {
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

export function resolveCodexDirectSessionLinkIdentity(params: Readonly<{
  remoteSessionId: string;
  source: DirectSessionsSource;
  runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
  metadata?: Record<string, unknown>;
}>): DirectSessionLinkIdentity {
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
  const source: DirectSessionsSource = canonicalRuntimeDescriptor?.home
    ? buildCodexDirectSessionSource({
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
    directSessionMetadata: {
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
