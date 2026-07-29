import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { machineScmChangeDiscard } from '@/sync/ops/scm/machineScm';

const machineScmChangeDiscardSpy = vi.hoisted(() => vi.fn<typeof machineScmChangeDiscard>(async () => ({ success: true })));
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        confirmResult: true,
        spies: {
            confirm: modalConfirmSpy,
        },
    }).module;
});

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmChangeDiscard: (...args: Parameters<typeof machineScmChangeDiscardSpy>) => machineScmChangeDiscardSpy(...args),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        storage: createStorageStoreMock({
            beginWorkspaceScmOperation: () => ({
                started: true,
                operation: { id: 'op-1', startedAt: 1, sessionId: 'session-1', operation: 'discard' },
            }),
            finishWorkspaceScmOperation: () => true,
            appendWorkspaceScmOperation: () => {},
        } as any),
    });
});

function createSnapshot(): ScmWorkingSnapshot {
    return {
        projectKey: 'server-1:machine-1:/repo',
        fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: {
            writeDiscard: true,
        } as any,
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
        },
    };
}

describe('applyWorkspaceFileDiscardAction', () => {
    beforeEach(() => {
        machineScmChangeDiscardSpy.mockClear();
        modalConfirmSpy.mockClear();
    });

    it('passes the workspace server scope to discard RPCs', async () => {
        const { applyWorkspaceFileDiscardAction } = await import('./applyWorkspaceFileDiscardAction');

        await applyWorkspaceFileDiscardAction({
            scope: { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' },
            machineId: 'machine-1',
            rootPath: '/repo',
            file: { fullPath: 'src/a.ts', status: 'modified' },
            snapshot: createSnapshot(),
            scmWriteEnabled: true,
            commitStrategy: 'atomic',
            surface: 'files',
        });

        expect(machineScmChangeDiscardSpy).toHaveBeenCalledWith(
            'machine-1',
            {
                cwd: '/repo',
                entries: [{ path: 'src/a.ts', kind: 'modified' }],
            },
            { serverId: 'server-1' },
        );
    });
});
