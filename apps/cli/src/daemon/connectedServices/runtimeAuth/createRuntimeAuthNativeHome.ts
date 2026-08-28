import { getConnectedServiceStateSharingDescriptor } from '@/daemon/connectedServices/catalogHooks';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { createAgentNativeHomeReadService } from '@/agent/runtime/nativeHomeFileService';
import { materializeConnectedServiceNativeHomeCredentials } from '@/daemon/connectedServices/stateSharing/materializeConnectedServiceNativeHomeCredentials';
import type { ConnectedServiceRuntimeAuthTargetInput } from './types';

export async function createConnectedServiceRuntimeAuthNativeHome(input: Readonly<{
  agentId: CatalogAgentId;
  root: string;
}>): Promise<NonNullable<ConnectedServiceRuntimeAuthTargetInput['nativeHome']> | null> {
  const descriptor = await getConnectedServiceStateSharingDescriptor(input.agentId)
    .catch(() => null);
  const declaredSecretEntries = Object.freeze([
    ...(descriptor?.authIsolation.secretEntries ?? []),
  ]);
  const readService = createAgentNativeHomeReadService({
    root: input.root,
    declaredFileIds: declaredSecretEntries,
  });
  if (!readService) return null;
  return Object.freeze({
    readFiles: readService.readFiles,
    async replaceFiles(files) {
      await materializeConnectedServiceNativeHomeCredentials({
        targetRoot: input.root,
        declaredSecretEntries,
        files,
      });
    },
  });
}
