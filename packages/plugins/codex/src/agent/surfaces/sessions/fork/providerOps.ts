import type {
  ForkRequestV1,
  ForkResultV1,
  ForkSurfaceV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  buildCodexAgentRuntimeDescriptor,
  normalizeCodexBackendMode,
  type CodexBackendMode,
} from '../../../../protocol/runtimeDescriptorV1.js';
import type { CodexAppServerNativeForkResult } from './native.js';

export type CodexAppServerForkProcessEnv = Record<string, string | undefined>;

export type CodexAppServerNativeForkRunner = (params: Readonly<{
  directory: string;
  parentCodexSessionId: string;
  processEnv?: CodexAppServerForkProcessEnv;
}>) => Promise<CodexAppServerNativeForkResult | null>;

export type CodexAppServerForkDiagnosticBase = Readonly<{
  agentId: 'codex';
  parentSessionId: string;
  backendMode: string | null;
  forkPointKind: ForkRequestV1['forkPoint']['kind'];
  hasRuntimeDescriptor: boolean;
  hasProviderSessionId: boolean;
  hasRuntimeHomePath: boolean;
}>;

export type CodexAppServerForkDiagnosticEvent =
  | Readonly<{
    type: 'skip';
    diagnostic: CodexAppServerForkDiagnosticBase;
    skipReason: 'backend_mode_not_app_server' | 'provider_session_id_missing' | 'fork_point_not_latest';
  }>
  | Readonly<{ type: 'attempt'; diagnostic: CodexAppServerForkDiagnosticBase }>
  | Readonly<{
    type: 'failed';
    diagnostic: CodexAppServerForkDiagnosticBase;
    error: unknown;
    redactedValues: readonly string[];
  }>
  | Readonly<{ type: 'empty'; diagnostic: CodexAppServerForkDiagnosticBase }>
  | Readonly<{ type: 'succeeded'; diagnostic: CodexAppServerForkDiagnosticBase }>;

function buildCodexForkRuntimeDescriptor(params: ForkRequestV1, backendMode: CodexBackendMode, providerSessionId: string) {
  return buildCodexAgentRuntimeDescriptor({
    backendMode,
    providerSessionId,
    home: params.parentMetadata.codexHome ?? null,
    connectedServiceId: params.parentMetadata.codexConnectedServiceId ?? null,
    connectedServiceProfileId: params.parentMetadata.codexConnectedServiceProfileId ?? null,
    connectedServiceGroupId: params.parentMetadata.codexConnectedServiceGroupId ?? null,
    homePath: backendMode === 'appServer' && params.parentMetadata.codexHome === 'connectedService'
      ? null
      : params.parentMetadata.codexHomePath ?? null,
  });
}

export function createCodexForkSurface(deps: Readonly<{
  forkNative: CodexAppServerNativeForkRunner;
  baseProcessEnv?: CodexAppServerForkProcessEnv;
  onDiagnostic?: (event: CodexAppServerForkDiagnosticEvent) => void;
}>): ForkSurfaceV1 {
  return {
    fork: async (params) => (
      await forkCodexAppServerLatest(params, deps)
      ?? await forkCodexAcpLatest(params)
    ),
  };
}

async function forkCodexAppServerLatest(
  params: ForkRequestV1,
  deps: Readonly<{
    forkNative: CodexAppServerNativeForkRunner;
    baseProcessEnv?: CodexAppServerForkProcessEnv;
    onDiagnostic?: (event: CodexAppServerForkDiagnosticEvent) => void;
  }>,
): Promise<ForkResultV1 | null> {
  const backendMode = normalizeCodexBackendMode(params.parentMetadata.codexBackendMode);
  const providerSessionIdRaw = params.parentMetadata.codexSessionId?.trim()
    || params.parentMetadata.providerSessionId?.trim()
    || '';
  const codexHomePath = params.parentMetadata.codexHomePath?.trim() ?? '';
  const diagnostic: CodexAppServerForkDiagnosticBase = {
    agentId: 'codex',
    parentSessionId: params.parentSessionId,
    backendMode,
    forkPointKind: params.forkPoint.kind,
    hasRuntimeDescriptor: backendMode !== null,
    hasProviderSessionId: providerSessionIdRaw.trim().length > 0,
    hasRuntimeHomePath: codexHomePath.length > 0,
  };

  const skipReason = (() => {
    if (backendMode !== 'appServer') return 'backend_mode_not_app_server' as const;
    if (!providerSessionIdRaw) return 'provider_session_id_missing' as const;
    if (params.forkPoint.kind !== 'latest') return 'fork_point_not_latest' as const;
    return null;
  })();
  if (skipReason) {
    deps.onDiagnostic?.({ type: 'skip', diagnostic, skipReason });
    return null;
  }

  const processEnv = codexHomePath
    ? { ...(deps.baseProcessEnv ?? {}), CODEX_HOME: codexHomePath }
    : deps.baseProcessEnv;

  deps.onDiagnostic?.({ type: 'attempt', diagnostic });

  let forked: CodexAppServerNativeForkResult | null;
  try {
    forked = await deps.forkNative({
      directory: params.directory,
      parentCodexSessionId: providerSessionIdRaw,
      ...(processEnv ? { processEnv } : {}),
    });
  } catch (error) {
    deps.onDiagnostic?.({
      type: 'failed',
      diagnostic,
      error,
      redactedValues: [providerSessionIdRaw],
    });
    return null;
  }

  const providerSessionId = typeof forked?.providerSessionId === 'string' ? forked.providerSessionId.trim() : '';
  if (!providerSessionId) {
    deps.onDiagnostic?.({ type: 'empty', diagnostic });
    return null;
  }

  deps.onDiagnostic?.({ type: 'succeeded', diagnostic });

  const runtimeDescriptor = buildCodexForkRuntimeDescriptor(params, 'appServer', providerSessionId);

  return {
    providerSessionId,
    launch: {
      ...(codexHomePath ? { environmentVariables: { CODEX_HOME: codexHomePath } } : {}),
      sessionStateUpdates: [
        {
          fieldId: 'identity.runtimeDescriptor' as const,
          value: runtimeDescriptor,
        },
        {
          fieldId: 'identity.providerSessionId' as const,
          value: providerSessionId,
        },
      ],
    },
  };
}

async function forkCodexAcpLatest(params: ForkRequestV1): Promise<ForkResultV1 | null> {
  if (params.forkPoint.kind !== 'latest') return null;

  const backendMode = normalizeCodexBackendMode(params.parentMetadata.codexBackendMode);
  if (backendMode !== 'acp') return null;

  const sourceProviderSessionId = params.parentMetadata.codexSessionId?.trim()
    || params.parentMetadata.providerSessionId?.trim()
    || '';
  if (!sourceProviderSessionId || !params.acp) return null;

  const loaded = await params.acp.loadSession({
    backendId: 'codex',
    directory: params.directory,
    providerSessionId: sourceProviderSessionId,
  });
  if (!loaded.ok) return null;

  const forked = await params.acp.forkSession({
    backendId: 'codex',
    directory: params.directory,
    sourceProviderSessionId,
  });
  if (!forked.ok) return null;

  const providerSessionId = typeof forked.value.providerSessionId === 'string'
    ? forked.value.providerSessionId.trim()
    : '';
  if (!providerSessionId) return null;

  const runtimeDescriptor = buildCodexForkRuntimeDescriptor(params, 'acp', providerSessionId);

  const sessionStateUpdates = forked.value.sessionStateUpdates && forked.value.sessionStateUpdates.length > 0
    ? [...forked.value.sessionStateUpdates]
    : [
      {
        fieldId: 'identity.runtimeDescriptor' as const,
        value: runtimeDescriptor,
      },
      {
        fieldId: 'identity.providerSessionId' as const,
        value: providerSessionId,
      },
    ];

  return {
    providerSessionId,
    launch: {
      sessionStateUpdates,
    },
  };
}
