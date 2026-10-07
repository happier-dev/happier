import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStorage } from '@/sync/domains/state/storage';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { PromptAssetMutationResponseV1 } from '@happier-dev/protocol';
import {
    createTransferFinalizeRecovery,
    settleTransferFinalizeRecovery,
} from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';

type MachinePromptAssetsWriteResult = Awaited<ReturnType<typeof import('@/sync/ops/machinePromptAssets').machinePromptAssetsWrite>>;

const machinePromptAssetsWriteMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<MachinePromptAssetsWriteResult> => ({
    ok: true as const,
    externalRef: { path: '.claude/commands/review.md' },
    digest: 'digest-1',
    preview: {
        operation: 'write' as const,
        targetPath: '.claude/commands/review.md',
        fileCount: 1,
    },
})));

// This suite stops at the machine upload operation; signed Iroh grants and
// native carrier acquisition belong to the transfer suite. Store and export
// logic, including recovery selection and settlement, remain real here.
vi.mock('@/sync/ops/machinePromptAssets', () => ({
    machinePromptAssetsWrite: machinePromptAssetsWriteMock,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: (config) => {
        const resolve: unknown = Reflect.get(config.props ?? {}, 'onResolve');
        if (typeof resolve !== 'function') throw new Error('Expected a recovery action selector');
        resolve('retry_finalize');
        return 'recovery-modal';
    } } }).module;
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'link-1',
}));

beforeAll(async () => { await import('@/sync/domains/state/storageStore'); });

describe('writePromptLibraryArtifactToExternalAsset', () => {
    beforeEach(() => {
        machinePromptAssetsWriteMock.mockClear();
        const artifact = {
            id: 'doc-1',
            header: { title: 'Review prompt' },
            title: 'Review prompt',
            body: JSON.stringify({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 }),
            headerVersion: 1,
            bodyVersion: 1,
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            isDecrypted: true,
        } satisfies DecryptedArtifact;
        getStorage().setState({ artifacts: {} });
        getStorage().getState().applyArtifacts([artifact]);
    });

    it('finishes a retained prompt upload without issuing another write', async () => {
        const recoveredResponse = {
            ok: true,
            externalRef: { path: '.claude/commands/review.md' },
            digest: 'digest-recovered',
        } satisfies PromptAssetMutationResponseV1;
        const retryFinalize = vi.fn(async () => settleTransferFinalizeRecovery({
            status: 'finalized' as const,
            response: recoveredResponse,
        }));
        const discard = vi.fn(async () => settleTransferFinalizeRecovery<PromptAssetMutationResponseV1>({ status: 'discarded' }));
        const recovery = createTransferFinalizeRecovery<PromptAssetMutationResponseV1>({
            expiresAt: Date.now() + 60_000,
            retryFinalize,
            discard,
        });
        machinePromptAssetsWriteMock.mockResolvedValueOnce({
            success: false,
            error: 'Finalize recovery is required',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery,
        });
        const { writePromptLibraryArtifactToExternalAsset } = await import('./exportPromptLibraryArtifact');

        const result = await writePromptLibraryArtifactToExternalAsset({
            artifactId: 'doc-1',
            machineId: 'machine-1',
            assetTypeId: 'claude.command',
            scope: 'user',
            targetInput: 'review.md',
            promptExternalLinks: { v: 1, links: [] },
            previewOnly: false,
        });

        expect(result).toMatchObject({ ok: true, response: { digest: 'digest-recovered' } });
        expect(machinePromptAssetsWriteMock).toHaveBeenCalledTimes(1);
        expect(retryFinalize).toHaveBeenCalledOnce();
        expect(discard).not.toHaveBeenCalled();
        expect(recovery.isActionable()).toBe(false);
        expect(result).toMatchObject({ nextPromptExternalLinks: { v: 1, links: [{
            id: 'link-1', artifactId: 'doc-1', lastExternalDigest: 'digest-recovered',
        }] } });
    });

    it('passes server routing through to machine prompt asset writes', async () => {
        const { writePromptLibraryArtifactToExternalAsset } = await import('./exportPromptLibraryArtifact');

        const result = await writePromptLibraryArtifactToExternalAsset({
            artifactId: 'doc-1',
            machineId: 'machine-1',
            assetTypeId: 'claude.command',
            scope: 'user',
            targetInput: 'review.md',
            promptExternalLinks: { v: 1, links: [] },
            previewOnly: false,
            serverId: 'server-1',
        });

        expect(result).toMatchObject({ ok: true });
        expect(machinePromptAssetsWriteMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                assetTypeId: 'claude.command',
                targetPath: 'review.md',
            }),
            { serverId: 'server-1' },
        );
    });
});
