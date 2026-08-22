import {
  type ProviderNativeForkPoint,
  toForkPointV1,
} from '@/session/fork/providerNativeForkHandler';
import {
  readProviderSessionIdSessionState,
  readSessionMetadataRuntimeDescriptor,
  type ForkResultV1,
  type ForkSessionMetadataV1,
  type ForkSurfaceV1,
} from '@happier-dev/agents';

export function buildForkSessionMetadata(
  metadata: Readonly<Record<string, unknown>>,
): ForkSessionMetadataV1 {
  const providerSessionId = readProviderSessionIdSessionState(metadata).value;
  const codexRuntimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'codex');
  const openCodeRuntimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'opencode');
  return Object.freeze({
    ...(providerSessionId !== null ? { providerSessionId } : {}),
    ...(codexRuntimeDescriptor?.providerSessionId
      ? { codexSessionId: codexRuntimeDescriptor.providerSessionId }
      : {}),
    ...(codexRuntimeDescriptor?.backendMode
      ? { codexBackendMode: codexRuntimeDescriptor.backendMode }
      : {}),
    ...(codexRuntimeDescriptor?.home
      ? { codexHome: codexRuntimeDescriptor.home }
      : {}),
    ...(codexRuntimeDescriptor?.connectedServiceId
      ? { codexConnectedServiceId: codexRuntimeDescriptor.connectedServiceId }
      : {}),
    ...(codexRuntimeDescriptor?.connectedServiceProfileId
      ? { codexConnectedServiceProfileId: codexRuntimeDescriptor.connectedServiceProfileId }
      : {}),
    ...(codexRuntimeDescriptor?.connectedServiceGroupId
      ? { codexConnectedServiceGroupId: codexRuntimeDescriptor.connectedServiceGroupId }
      : {}),
    ...(codexRuntimeDescriptor?.homePath
      ? { codexHomePath: codexRuntimeDescriptor.homePath }
      : {}),
    ...(openCodeRuntimeDescriptor?.providerSessionId
      ? { opencodeSessionId: openCodeRuntimeDescriptor.providerSessionId }
      : {}),
    ...(openCodeRuntimeDescriptor?.backendMode
      ? { opencodeBackendMode: openCodeRuntimeDescriptor.backendMode }
      : {}),
    ...(openCodeRuntimeDescriptor?.serverBaseUrl
      ? { opencodeServerBaseUrl: openCodeRuntimeDescriptor.serverBaseUrl }
      : {}),
    ...(openCodeRuntimeDescriptor?.serverBaseUrl
      ? { opencodeServerBaseUrlExplicit: openCodeRuntimeDescriptor.serverBaseUrlExplicit }
      : {}),
  });
}

export async function dispatchProviderNativeFork(params: Readonly<{
  forkSurface: ForkSurfaceV1 | null;
  parentSessionId: string;
  parentMetadata: Record<string, unknown>;
  directory: string;
  forkPoint: ProviderNativeForkPoint;
}>): Promise<ForkResultV1 | null> {
  if (!params.forkSurface?.fork) {
    return null;
  }
  const result = await params.forkSurface.fork({
    parentSessionId: params.parentSessionId,
    parentMetadata: buildForkSessionMetadata(params.parentMetadata),
    directory: params.directory,
    forkPoint: toForkPointV1(params.forkPoint),
  });
  return result ?? null;
}
