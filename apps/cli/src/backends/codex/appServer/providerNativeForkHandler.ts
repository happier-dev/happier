import { buildCodexAgentRuntimeDescriptor, resolvePersistedCodexRuntimeIdentity, resolveVendorResumeIdFromSessionMetadata, readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import type { ProviderNativeForkHandler } from '@/backends/forking/providerNativeForkHandler';

import { forkCodexAppServerConversationNative } from './nativeFork';

export const codexAppServerProviderNativeForkHandler: ProviderNativeForkHandler = async (params) => {
  const runtimeIdentity = readSessionMetadataRuntimeDescriptor(params.parentMetadata, 'codex');
  const backendMode = runtimeIdentity?.backendMode ?? resolvePersistedCodexRuntimeIdentity(params.parentMetadata)?.backendMode ?? null;
  const vendorSessionIdRaw = resolveVendorResumeIdFromSessionMetadata('codex', params.parentMetadata) ?? '';
  if (backendMode !== 'appServer' || !vendorSessionIdRaw || params.forkPoint.type !== 'latest') return null;

  const processEnv = runtimeIdentity?.homePath
    ? { ...process.env, CODEX_HOME: runtimeIdentity.homePath }
    : process.env;

  const forked = await forkCodexAppServerConversationNative({
    directory: params.directory,
    parentCodexSessionId: vendorSessionIdRaw,
    processEnv,
  }).catch(() => null);
  const vendorSessionId = typeof forked?.vendorSessionId === 'string' ? forked.vendorSessionId.trim() : '';
  if (!vendorSessionId) return null;

  return {
    vendorSessionId,
      spawn: {
        resume: vendorSessionId,
        codexBackendMode: 'appServer',
        ...(runtimeIdentity?.homePath ? { environmentVariables: { CODEX_HOME: runtimeIdentity.homePath } } : {}),
      },
      metadata: {
        codexSessionId: vendorSessionId,
        codexBackendMode: 'appServer',
        ...(runtimeIdentity
          ? {
              agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
                backendMode: 'appServer',
                vendorSessionId,
                home: runtimeIdentity.home,
                connectedServiceId: runtimeIdentity.connectedServiceId,
                connectedServiceProfileId: runtimeIdentity.connectedServiceProfileId,
                homePath: runtimeIdentity.homePath,
              }),
            }
          : {}),
      },
    providerHint: {
      providerId: params.agentId,
      backendMode: 'appServer',
      vendorSessionId,
    },
  };
};
