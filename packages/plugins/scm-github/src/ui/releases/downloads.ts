import type { FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { readForgeOperationStateV1, type ForgeOperationStateV1 } from '@happier-dev/forge-ci/ui';
import type { ForgeReleaseAssetV1, ForgeReleaseV1 } from '@happier-dev/triage-protocol/releases/v1';
import { GITHUB_RELEASE_ACTION_REFS_V1 } from './model.js';

export type ReleaseAssetDownloadV1 = Readonly<{
    pending: boolean;
    result: FileDownloadResultV1 | null;
    operation: ForgeOperationStateV1;
}>;

/** Mount-local presentation of the canonical receiver result, never a transfer/progress owner. */
export function createReleaseAssetDownloadsV1(host: Pick<PluginUiHostApi, 'downloadFile'>) {
    let state: ReadonlyMap<string, ReleaseAssetDownloadV1> = new Map();
    let retired = false;
    const listeners = new Set<() => void>();
    const publish = (assetId: string, value: ReleaseAssetDownloadV1) => {
        if (retired) return;
        state = new Map(state).set(assetId, value);
        for (const listener of listeners) listener();
    };
    return {
        getSnapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async download(release: ForgeReleaseV1, asset: ForgeReleaseAssetV1) {
            const previous = state.get(asset.assetId);
            if (retired || previous?.pending || previous?.result?.status === 'unknown' || previous?.result?.status === 'accepted') return;
            publish(asset.assetId, { pending: true, result: previous?.result ?? null, operation: previous?.operation ?? { kind: 'ready' } });
            let result: FileDownloadResultV1;
            try {
                result = await host.downloadFile({ action: GITHUB_RELEASE_ACTION_REFS_V1.downloadAsset, input: {
                    repository: release.repository, repositoryId: release.repositoryId, releaseId: release.releaseId, assetId: asset.assetId,
                } });
            } catch (error) {
                // A thrown host call proves neither failure nor cancellation. Never replay it.
                result = { success: false, status: 'unknown', error: error instanceof Error ? error.message : String(error) };
            }
            publish(asset.assetId, { pending: false, result,
                operation: readForgeOperationStateV1({ download: result, hasRetainedValue: true, targetUrl: release.webUrl }) });
        },
        dispose() { retired = true; state = new Map(); listeners.clear(); },
    };
}
export type ReleaseAssetDownloadsControllerV1 = ReturnType<typeof createReleaseAssetDownloadsV1>;
export type ReleaseAssetDownloadsV1 = Readonly<{
    state: ReadonlyMap<string, ReleaseAssetDownloadV1>;
    download: ReleaseAssetDownloadsControllerV1['download'];
}>;
