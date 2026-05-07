import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { createSaplingBackend } from './backend';

const context = {
    cwd: '/tmp',
    projectKey: 'machine:/tmp',
    detection: {
        isRepo: true,
        rootPath: '/tmp',
        mode: '.sl' as const,
    },
};

describe('sapling backend unsupported SCM operations', () => {
    it('returns feature-unsupported for remote management operations', async () => {
        const backend = createSaplingBackend();

        await expect(backend.remoteAdd({
            context,
            request: { cwd: '.', name: 'origin', fetchUrl: '/tmp/remote.git' },
        })).resolves.toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
        await expect(backend.remoteSetUrl({
            context,
            request: { cwd: '.', name: 'origin', fetchUrl: '/tmp/remote.git' },
        })).resolves.toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
        await expect(backend.remoteRemove({
            context,
            request: { cwd: '.', name: 'origin' },
        })).resolves.toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
    });

    it('returns feature-unsupported for branch integration operations', async () => {
        const backend = createSaplingBackend();

        await expect(backend.branchMerge({
            context,
            request: { cwd: '.', sourceRef: 'main' },
        })).resolves.toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
        await expect(backend.branchRebase({
            context,
            request: { cwd: '.', sourceRef: 'main' },
        })).resolves.toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
        await expect(backend.branchOperationContinue({
            context,
            request: { cwd: '.', operation: 'merge' },
        })).resolves.toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
        await expect(backend.branchOperationAbort({
            context,
            request: { cwd: '.', operation: 'rebase' },
        })).resolves.toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
    });
});
