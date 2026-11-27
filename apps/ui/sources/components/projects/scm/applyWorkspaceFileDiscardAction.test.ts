import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { machineScmChangeDiscard } from '@/sync/ops/scm/machineScm';
import { Modal } from '@/modal';
import type { ScmRpcFailure } from '@/sync/ops/scm/scmRpcFailure';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';

const machineScmChangeDiscardSpy = vi.hoisted(() => vi.fn<typeof machineScmChangeDiscard>(async () => ({ success: true })));
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => false));

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
        projectManager.clear();
        storage.setState(storage.getInitialState(), true);
        machineScmChangeDiscardSpy.mockClear();
        modalConfirmSpy.mockClear();
    });

    it('reveals a supplied refusal cause in the Workspace failure alert', async () => {
        const response = { success: false, errorCode: 'BACKEND_UNAVAILABLE', actionErrorCode: 'credential_scope_denied', error: 'Refused', requestId: 'workspace-discard-refusal', effectAttempted: false,
            failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: 403 } } satisfies ScmRpcFailure;
        machineScmChangeDiscardSpy.mockResolvedValueOnce(response);
        const { applyWorkspaceFileDiscardAction } = await import('./applyWorkspaceFileDiscardAction');
        await applyWorkspaceFileDiscardAction({ scope: { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' }, machineId: 'machine-1', rootPath: '/repo',
            file: { fullPath: 'src/a.ts', status: 'modified' }, snapshot: createSnapshot(), scmWriteEnabled: true, commitStrategy: 'atomic', surface: 'files' });
        const details = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]?.find((button) => button.text === 'approvals.technicalDetails');
        expect(details).toBeDefined();
        details?.onPress?.();
        expect(vi.mocked(Modal.alert).mock.calls.at(-1)?.[1]).toContain('workspace-discard-refusal');
        expect(vi.mocked(Modal.alert).mock.calls.at(-1)?.[1]).toContain('execution_authorization');
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
            { serverId: 'server-1', onDispatched: expect.any(Function) },
        );
        expect(modalConfirmSpy).not.toHaveBeenCalled();
    });
});
