import { exportPromptLibraryArtifact, readPromptLibraryArtifactForExport as readStoredPromptLibraryArtifactForExport, type ExportablePromptLibraryArtifact, type PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptAssetInstallModeV1, PromptAssetScopeV1 } from '@happier-dev/protocol/prompts/library/promptAssetDescriptorsV1';
import type { PromptAssetMutationResponseV1 } from '@happier-dev/protocol/prompts/library/promptAssetsV1';
import type { PromptExternalLinksV1 } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import { machinePromptAssetsWrite } from '@/sync/ops/machinePromptAssets';
import { randomUUID } from '@/platform/randomUUID';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';

export type { ExportablePromptLibraryArtifact };

export async function readPromptLibraryArtifactForExport(
  artifactId: string,
  serverId?: string | null,
): Promise<ExportablePromptLibraryArtifact | null> {
  return await withUiPromptLibraryArtifactStore((store) => readStoredPromptLibraryArtifactForExport({
    store,
    artifactId,
  }), { serverId });
}

export async function writePromptLibraryArtifactToExternalAsset(args: Readonly<{
  artifactId: string;
  machineId: string;
  machineTarget: MachineAdministrationTargetV1;
  libraryServerIdentityId: string;
  assetTypeId: string;
  scope: PromptAssetScopeV1;
  serverId?: string | null;
  workspacePath?: string | null;
  targetInput: string;
  installMode?: PromptAssetInstallModeV1;
  promptExternalLinks: PromptExternalLinksV1 | null | undefined;
  previewOnly: boolean;
}>, store?: PromptLibraryArtifactStore): Promise<
  | Readonly<{ ok: false; error: string; errorCode?: string; currentDigest?: string | null }>
  | Readonly<{
      ok: true;
      artifactState: ExportablePromptLibraryArtifact;
      response: Extract<PromptAssetMutationResponseV1, { ok: true }>;
      nextPromptExternalLinks?: PromptExternalLinksV1;
    }>
> {
  const { machineTarget, libraryServerIdentityId, ...request } = args;
  const runExport = (current: PromptLibraryArtifactStore) => exportPromptLibraryArtifact({
    machineTarget,
    libraryServerIdentityId,
    store: current,
    write: async ({ machineId, serverId, request }) => {
      let response = await machinePromptAssetsWrite(
        machineId,
        request,
        serverId ? { serverId } : undefined,
      );
      if (isTransferFinalizeRecoveryFailure<PromptAssetMutationResponseV1>(response)) {
        const recoveryResult = await runTransferFinalizeRecovery({
          recovery: response.recovery,
          title: t('transferRecovery.title'),
          message: t('transferRecovery.message'),
        });
        if (recoveryResult?.status === 'finalized') {
          response = recoveryResult.response;
        } else {
          response = {
            ok: false,
            error: recoveryResult?.status === 'unavailable'
              ? t('transferRecovery.unavailable')
              : recoveryResult?.status === 'discarded'
                ? t('transferRecovery.discarded')
                : response.error,
            errorCode: 'internal_error',
          };
        }
      }
      return response;
    },
    request,
    randomId: randomUUID,
  });
  const result = await (store ? runExport(store) : withUiPromptLibraryArtifactStore(runExport));
  if (!result.ok) return result;
  return {
    ok: true,
    artifactState: result.artifactState,
    response: result.response,
    ...(result.nextPromptExternalLinks
      ? { nextPromptExternalLinks: result.nextPromptExternalLinks }
      : {}),
  };
}
