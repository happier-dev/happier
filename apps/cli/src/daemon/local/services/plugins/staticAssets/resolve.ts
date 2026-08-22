import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    resolveHostedWebAssetPolicy,
    type HostedWebAssetPolicyFailureCode,
    type HostedWebAssetPolicyInput,
} from '@happier-dev/protocol/plugins/ui';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

export type HostedWebStaticAssetResolveFailureCode =
    | HostedWebAssetPolicyFailureCode
    | 'asset_root_escape'
    | 'asset_unavailable';

export type HostedWebStaticAssetResolveResult =
    | Readonly<{
        ok: true;
        filePath: string;
        relativePath: string;
        contentType: string;
        fallback?: 'spa';
        headers: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        ok: false;
        code: HostedWebStaticAssetResolveFailureCode;
        status: number;
    }>;

export type HostedWebStaticAssetResolveInput = HostedWebAssetPolicyInput & Readonly<{
    installedRoot: string;
}>;

function failure(code: HostedWebStaticAssetResolveFailureCode, status: number): HostedWebStaticAssetResolveResult {
    return Object.freeze({ ok: false, code, status });
}

async function resolveContainedFile(params: Readonly<{
    installedRoot: string;
    assetRootId: string;
    relativePath: string;
}>): Promise<Readonly<{ ok: true; filePath: string }> | HostedWebStaticAssetResolveResult> {
    const installedRootReal = await realpath(params.installedRoot);
    const assetRootReal = await realpath(resolve(installedRootReal, params.assetRootId));
    if (!isCanonicalAbsolutePathInsideRoot(installedRootReal, assetRootReal)) {
        return failure('asset_root_escape', 403);
    }
    const filePath = resolve(installedRootReal, params.relativePath);
    let filePathReal: string;
    try {
        filePathReal = await realpath(filePath);
    } catch {
        return failure('asset_unavailable', 404);
    }
    if (!isCanonicalAbsolutePathInsideRoot(assetRootReal, filePathReal)) {
        return failure('asset_root_escape', 403);
    }
    const fileStat = await stat(filePathReal);
    if (!fileStat.isFile()) {
        return failure('directory_listing_disabled', 404);
    }
    return { ok: true, filePath: filePathReal };
}

export async function resolveHostedWebStaticAssetRequest(
    input: HostedWebStaticAssetResolveInput,
): Promise<HostedWebStaticAssetResolveResult> {
    const policy = resolveHostedWebAssetPolicy(input);
    if (!policy.ok) {
        return policy;
    }

    const contained = await resolveContainedFile({
        installedRoot: input.installedRoot,
        assetRootId: policy.assetRootId,
        relativePath: policy.relativePath,
    });
    if (!contained.ok) {
        return contained;
    }

    return Object.freeze({
        ok: true,
        filePath: contained.filePath,
        relativePath: policy.relativePath,
        contentType: policy.contentType,
        fallback: policy.fallback,
        headers: policy.headers,
    });
}
