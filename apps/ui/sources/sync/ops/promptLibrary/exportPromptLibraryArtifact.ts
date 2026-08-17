import {
  exportPromptLibraryArtifact,
  readPromptLibraryArtifactForExport as readStoredPromptLibraryArtifactForExport,
  type ExportablePromptLibraryArtifact,
  type PromptAssetInstallModeV1,
  type PromptAssetMutationResponseV1,
  type PromptAssetScopeV1,
  type PromptExternalLinksV1,
} from '@happier-dev/protocol';

import { machinePromptAssetsWrite } from '@/sync/ops/machinePromptAssets';
import { randomUUID } from '@/platform/randomUUID';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import { uiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';

export type { ExportablePromptLibraryArtifact };

export async function readPromptLibraryArtifactForExport(
  artifactId: string,
): Promise<ExportablePromptLibraryArtifact | null> {
  return await readStoredPromptLibraryArtifactForExport({
    store: uiPromptLibraryArtifactStore,
    artifactId,
  });
}

export async function writePromptLibraryArtifactToExternalAsset(args: Readonly<{
  artifactId: string;
  machineId: string;
  assetTypeId: string;
  scope: PromptAssetScopeV1;
  serverId?: string | null;
  workspacePath?: string | null;
  targetInput: string;
  installMode?: PromptAssetInstallModeV1;
  promptExternalLinks: PromptExternalLinksV1 | null | undefined;
  previewOnly: boolean;
}>): Promise<
  | Readonly<{ ok: false; error: string; errorCode?: string; currentDigest?: string | null }>
  | Readonly<{
      ok: true;
      artifactState: ExportablePromptLibraryArtifact;
      response: Extract<PromptAssetMutationResponseV1, { ok: true }>;
      nextPromptExternalLinks?: PromptExternalLinksV1;
    }>
> {
  const result = await exportPromptLibraryArtifact({
    store: uiPromptLibraryArtifactStore,
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
    request: args,
    randomId: randomUUID,
  });
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
