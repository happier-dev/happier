import {
  buildCodexAgentRuntimeDescriptor,
  resolvePersistedCodexRuntimeIdentity,
  resolveVendorResumeIdFromSessionMetadata,
  readSessionMetadataRuntimeDescriptor,
} from '@happier-dev/agents';
import {
  buildRuntimeDescriptorSessionMetadata,
  buildVendorSessionIdSessionMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import type { ProviderNativeForkHandler } from '@/session/fork/providerNativeForkHandler';

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
  const vendorSessionMetadata = buildVendorSessionIdSessionMetadata({
    metadataKey: 'codexSessionId',
    value: vendorSessionId,
  });
  const runtimeDescriptor = runtimeIdentity
    ? buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        vendorSessionId,
        home: runtimeIdentity.home,
        connectedServiceId: runtimeIdentity.connectedServiceId,
        connectedServiceProfileId: runtimeIdentity.connectedServiceProfileId,
        homePath: runtimeIdentity.homePath,
      })
    : null;
  const runtimeDescriptorMetadata = runtimeDescriptor
    ? buildRuntimeDescriptorSessionMetadata(
        runtimeDescriptor,
      )
    : {};

  return {
    vendorSessionId,
      spawn: {
        resume: vendorSessionId,
        codexBackendMode: 'appServer',
        ...(runtimeIdentity?.homePath ? { environmentVariables: { CODEX_HOME: runtimeIdentity.homePath } } : {}),
      },
      metadata: {
        ...vendorSessionMetadata,
        codexBackendMode: 'appServer',
        ...runtimeDescriptorMetadata,
      },
    providerHint: {
      providerId: params.agentId,
      backendMode: 'appServer',
      vendorSessionId,
    },
  };
};
