import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import type { ForgeReleaseActionInputByOperationV1, ForgeReleaseAssetV1 } from '@happier-dev/triage-protocol/releases/v1';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { readReleaseResource, type AdmittedReleaseInvocation } from './nativeReads.js';

const failed = (errorCode: string): FileDownloadResultV1 => ({ success: false, status: 'failed',
    error: 'The selected GitHub release asset could not be acquired.', errorCode });

/** Provider acquisition only; canonical host custody owns publication, receipt and receiver settlement. */
export async function downloadReleaseAssetV1(admitted: AdmittedReleaseInvocation,
    input: ForgeReleaseActionInputByOperationV1['downloadAsset'], context: PluginInvocationContext): Promise<FileDownloadResultV1> {
    let acquired: Parameters<PluginInvocationContext['services']['fs']['prepareDownload']>[0];
    try {
        const release = await readReleaseResource(admitted, 'readRelease', { ...admitted.target, releaseId: input.releaseId });
        if (release.kind !== 'value') return failed(release.kind === 'unavailable' ? release.failure.code : 'github_release_fresh_read_required');
        // The asset endpoint has no parent-release operand. Prove membership in the selected exact release first.
        let asset: ForgeReleaseAssetV1 | undefined;
        let cursor: string | undefined;
        do {
            const page = await readReleaseResource(admitted, 'listAssets', { ...admitted.target, releaseId: input.releaseId,
                ...(cursor === undefined ? {} : { cursor }) });
            if (page.kind !== 'value') return failed(page.kind === 'unavailable' ? page.failure.code : 'github_release_assets_unavailable');
            asset = page.value.rows.find(row => row.assetId === input.assetId);
            if (asset) break;
            if (page.value.incomplete !== null || page.value.omittedRowCount !== 0 || page.value.projectionTruncated)
                return failed('github_release_assets_incomplete');
            cursor = page.value.continuation ?? undefined;
        } while (cursor !== undefined);
        if (!asset) return failed('github_release_asset_not_found');
        if (asset.state !== 'uploaded') return failed('github_release_asset_not_ready');
        const response = await admitted.client.requestMedia({ url: `${admitted.baseUrl}/assets/${input.assetId}`, media: 'binary' });
        if (response.status !== 200) return failed(classifyGithubResponseFailure(response, Date.now()).code);
        if (response.body.byteLength !== asset.size) return failed('github_release_asset_size_changed');
        acquired = { name: asset.name, bytes: response.body, destination: input.destination };
    } catch (error) {
        if (context.signal.aborted) return { success: false, status: 'cancelled', error: 'Release asset acquisition was cancelled.', errorCode: 'cancelled' };
        return failed(classifyGithubTransportFailure(error).code);
    }
    // Publication errors are not acquisition failures: acceptance may already have happened. Never replay here.
    return context.services.fs.prepareDownload(acquired, { signal: context.signal });
}
