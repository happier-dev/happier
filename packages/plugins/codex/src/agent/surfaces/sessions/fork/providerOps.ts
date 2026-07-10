import {
  readSessionMetadataRuntimeDescriptor,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/plugin-sdk/sessions';
import type {
  ForkRequestV1,
  ForkResultV1,
  ForkSurfaceV1,
} from '@happier-dev/plugin-sdk';

import { resolvePersistedCodexRuntimeIdentity } from '../../../identity/runtimeDescriptor.js';
import { buildCodexAgentRuntimeDescriptor } from '../../../../protocol/runtimeDescriptorV1.js';
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
  const runtimeIdentity = readSessionMetadataRuntimeDescriptor(params.parentMetadata, 'codex');
  const backendMode = runtimeIdentity?.backendMode
    ?? resolvePersistedCodexRuntimeIdentity(params.parentMetadata)?.backendMode
    ?? null;
  const providerSessionIdRaw = resolveVendorResumeIdFromSessionMetadata('codex', params.parentMetadata) ?? '';
  const diagnostic: CodexAppServerForkDiagnosticBase = {
    agentId: 'codex',
    parentSessionId: params.parentSessionId,
    backendMode,
    forkPointKind: params.forkPoint.kind,
    hasRuntimeDescriptor: Boolean(runtimeIdentity),
    hasProviderSessionId: providerSessionIdRaw.trim().length > 0,
    hasRuntimeHomePath: typeof runtimeIdentity?.homePath === 'string' && runtimeIdentity.homePath.trim().length > 0,
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

  const processEnv = runtimeIdentity?.homePath
    ? { ...(deps.baseProcessEnv ?? {}), CODEX_HOME: runtimeIdentity.homePath }
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

  const runtimeDescriptor = runtimeIdentity
    ? buildCodexAgentRuntimeDescriptor({
      backendMode: 'appServer',
      providerSessionId,
      home: runtimeIdentity.home,
      connectedServiceId: runtimeIdentity.connectedServiceId,
      connectedServiceProfileId: runtimeIdentity.connectedServiceProfileId,
      connectedServiceGroupId: runtimeIdentity.connectedServiceGroupId,
      homePath: runtimeIdentity.home === 'connectedService' ? null : runtimeIdentity.homePath,
    })
    : null;

  return {
    providerSessionId,
    launch: {
      ...(runtimeIdentity?.homePath ? { environmentVariables: { CODEX_HOME: runtimeIdentity.homePath } } : {}),
      sessionStateUpdates: [
        ...(runtimeDescriptor
          ? [{
            fieldId: 'identity.runtimeDescriptor' as const,
            value: runtimeDescriptor,
          }]
          : []),
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

  const runtimeIdentity = readSessionMetadataRuntimeDescriptor(params.parentMetadata, 'codex');
  const backendMode = runtimeIdentity?.backendMode
    ?? resolvePersistedCodexRuntimeIdentity(params.parentMetadata)?.backendMode
    ?? null;
  if (backendMode !== 'acp') return null;

  const sourceProviderSessionId = resolveVendorResumeIdFromSessionMetadata('codex', params.parentMetadata)?.trim() ?? '';
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

  const runtimeDescriptor = runtimeIdentity
    ? buildCodexAgentRuntimeDescriptor({
      backendMode: 'acp',
      providerSessionId,
      home: runtimeIdentity.home,
      connectedServiceId: runtimeIdentity.connectedServiceId,
      connectedServiceProfileId: runtimeIdentity.connectedServiceProfileId,
      connectedServiceGroupId: runtimeIdentity.connectedServiceGroupId,
      homePath: runtimeIdentity.homePath,
    })
    : null;
  const sessionStateUpdates = forked.value.sessionStateUpdates && forked.value.sessionStateUpdates.length > 0
    ? [...forked.value.sessionStateUpdates]
    : [
      ...(runtimeDescriptor
        ? [{
          fieldId: 'identity.runtimeDescriptor' as const,
          value: runtimeDescriptor,
        }]
        : []),
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
