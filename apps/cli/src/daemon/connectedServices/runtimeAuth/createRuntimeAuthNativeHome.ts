import { getConnectedServiceStateSharingDescriptor } from '@/daemon/connectedServices/catalogHooks';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { createAgentNativeHomeReadService } from '@/agent/runtime/nativeHomeFileService';
import { materializeConnectedServiceNativeHomeCredentials } from '@/daemon/connectedServices/stateSharing/materializeConnectedServiceNativeHomeCredentials';
import type { ConnectedServiceRuntimeAuthTargetInput } from './types';

export async function createConnectedServiceRuntimeAuthNativeHome(input: Readonly<{
  agentId: CatalogAgentId;
  root: string;
  isCurrent?: () => Promise<boolean>;
}>): Promise<NonNullable<ConnectedServiceRuntimeAuthTargetInput['nativeHome']> | null> {
  const assertCurrent = async () => {
    if (input.isCurrent && !await input.isCurrent()) throw new Error('requester_session_not_current');
  };
  await assertCurrent();
  const descriptor = await getConnectedServiceStateSharingDescriptor(input.agentId)
    .catch(() => null);
  await assertCurrent();
  const declaredSecretEntries = Object.freeze([
    ...(descriptor?.authIsolation.secretEntries ?? []),
  ]);
  const readService = createAgentNativeHomeReadService({
    root: input.root,
    declaredFileIds: declaredSecretEntries,
  });
  if (!readService) return null;
  return Object.freeze({
    async readFiles(fileIds) {
      await assertCurrent();
      const files = await readService.readFiles(fileIds);
      await assertCurrent();
      return files;
    },
    async replaceFiles(files) {
      await assertCurrent();
      await materializeConnectedServiceNativeHomeCredentials({
        targetRoot: input.root,
        declaredSecretEntries,
        files,
      });
      await assertCurrent();
    },
  });
}
