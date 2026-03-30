import type { ProviderNativeForkHandler } from '@/backends/forking/providerNativeForkHandler';

import {
  applyOpenCodeSessionAffinityMetadata,
  buildOpenCodeSessionEnvironmentVariables,
  readOpenCodeSessionRuntimeHandleFromMetadata,
} from '@/backends/opencode/utils/opencodeSessionAffinity';

import { forkOpenCodeSessionNative } from './nativeFork';

export const openCodeProviderNativeForkHandler: ProviderNativeForkHandler = async (params) => {
  const runtimeHandle = readOpenCodeSessionRuntimeHandleFromMetadata(params.parentMetadata);
  const backendMode = runtimeHandle.backendMode ?? '';
  const vendorSessionIdRaw = runtimeHandle.vendorSessionId ?? '';
  if (backendMode !== 'server' || !vendorSessionIdRaw) return null;

  const forked = await forkOpenCodeSessionNative({
    credentials: params.credentials,
    parentHappySessionId: params.parentSessionId,
    parentRawSession: params.parentRawSession,
    directory: params.directory,
    parentOpenCodeSessionId: vendorSessionIdRaw,
    forkPoint: params.forkPoint.type === 'seq'
      ? { type: 'seq', upToSeqInclusive: params.targetSeqInclusive }
      : { type: 'latest' },
  }).catch(() => null);
  const vendorSessionId = typeof forked?.vendorSessionId === 'string' ? forked.vendorSessionId.trim() : '';
  if (!vendorSessionId) return null;

  return {
    vendorSessionId,
    spawn: {
      resume: vendorSessionId,
      environmentVariables: buildOpenCodeSessionEnvironmentVariables({
        backendMode: 'server',
        serverBaseUrl: runtimeHandle.serverBaseUrl ?? null,
        serverBaseUrlExplicit: runtimeHandle.serverBaseUrlExplicit,
      }),
    },
    metadata: applyOpenCodeSessionAffinityMetadata({
      backendMode: 'server',
      vendorSessionId,
      serverBaseUrl: runtimeHandle.serverBaseUrl ?? null,
      serverBaseUrlExplicit: runtimeHandle.serverBaseUrlExplicit,
    }),
    providerHint: {
      providerId: params.agentId,
      backendMode: 'server',
      vendorSessionId,
    },
  };
};
