import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createThemeFixture, renderScreen } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { SourceControlBranchIntegrationSection } from './SourceControlBranchIntegrationSection';

// Unrelated key-envelope HTTP API must never be called by repository tools.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unexpected = () => { throw new Error('Unexpected session key-envelope HTTP request in Git'); };
    return { createSessionDataKeyEnvelopeClient: unexpected, readSessionDataKeyEnvelopeCollectionPage: unexpected,
        prepareSessionDataKeyEnvelopesForScope: unexpected, prepareSessionDataKeyEnvelopesDetached: unexpected };
});

const modalState = vi.hoisted(() => ({
    confirm: vi.fn(),
    alert: vi.fn(),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: modalState.confirm,
            alert: modalState.alert,
        },
    }).module;
});

const theme = createThemeFixture() as any;

function createSnapshot(
    overrides?: Partial<ScmWorkingSnapshot>,
): ScmWorkingSnapshot {
    return {
        fetchedAt: 1,
        projectKey: 'machine:/repo',
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            remotes: [],
            worktrees: [],
        },
        capabilities: {
            writeBranchMerge: true,
            writeBranchRebase: true,
            writeBranchOperationControl: true,
        } as any,
        branch: {
            head: 'main',
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            detached: false,
        },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
        operationState: {
            kind: 'merge',
            sourceRef: 'origin/main',
            canContinue: true,
            canAbort: true,
        },
        ...overrides,
    };
}

describe('SourceControlBranchIntegrationSection', () => {
    beforeEach(() => {
        modalState.confirm.mockReset();
        modalState.alert.mockReset();
    });

    it('confirms abort destructively and re-checks abort preflight before invoking the abort callback', async () => {
        const confirmDeferred = createDeferred<boolean>();
        modalState.confirm.mockReturnValue(confirmDeferred.promise);
        const onAbort = vi.fn(async () => ({ success: true }));

        const screen = await renderScreen(
            <SourceControlBranchIntegrationSection
                theme={theme}
                snapshot={createSnapshot()}
                rootPath="/repo"
                writeEnabled
                onMerge={vi.fn(async () => ({ success: true }))}
                onRebase={vi.fn(async () => ({ success: true }))}
                onContinue={vi.fn(async () => ({ success: true }))}
                onAbort={onAbort}
            />,
        );

        await screen.pressByTestIdAsync('scm-update-branch-operation-abort');
        expect(modalState.confirm).toHaveBeenCalledWith(
            'Abort',
            'merge in progress from origin/main',
            expect.objectContaining({
                confirmText: 'Abort',
                cancelText: 'Cancel',
                destructive: true,
            }),
        );

        await screen.update(
            <SourceControlBranchIntegrationSection
                theme={theme}
                snapshot={createSnapshot({
                    operationState: {
                        kind: 'merge',
                        sourceRef: 'origin/main',
                        canContinue: true,
                        canAbort: false,
                    },
                })}
                rootPath="/repo"
                writeEnabled
                onMerge={vi.fn(async () => ({ success: true }))}
                onRebase={vi.fn(async () => ({ success: true }))}
                onContinue={vi.fn(async () => ({ success: true }))}
                onAbort={onAbort}
            />,
        );

        await act(async () => {
            confirmDeferred.resolve(true);
            await confirmDeferred.promise;
        });

        expect(onAbort).not.toHaveBeenCalled();
        expect(modalState.alert).toHaveBeenCalledWith('Error', 'This operation cannot be aborted.');
    });

    it('waits for destructive confirmation before invoking the mutation owner', async () => {
        modalState.confirm.mockResolvedValue(true);
        const onAbort = vi.fn(async () => ({ success: true }));

        const screen = await renderScreen(
            <SourceControlBranchIntegrationSection
                theme={theme}
                snapshot={createSnapshot()}
                rootPath="/repo"
                writeEnabled
                onMerge={vi.fn(async () => ({ success: true }))}
                onRebase={vi.fn(async () => ({ success: true }))}
                onContinue={vi.fn(async () => ({ success: true }))}
                onAbort={onAbort}
            />,
        );

        await screen.pressByTestIdAsync('scm-update-branch-operation-abort');

        expect(onAbort).toHaveBeenCalledWith('merge');
    });

    it('leaves a rich conflict result to the canonical outcome presenter', async () => {
        const onMerge = vi.fn(async () => ({ success: false, outcome: {
            v: 1 as const, kind: 'conflicted' as const, errorCode: 'CONFLICTING_WORKTREE' as const,
            repositoryState: { hasConflicts: true, operation: null }, nextActions: [{ kind: 'resolve_conflicts' as const }],
        } }));
        const screen = await renderScreen(<SourceControlBranchIntegrationSection
            theme={theme} snapshot={createSnapshot({ operationState: null })} rootPath="/repo" writeEnabled
            onMerge={onMerge} onRebase={async () => ({ success: true })}
            onContinue={async () => ({ success: true })} onAbort={async () => ({ success: true })} />);
        await act(async () => { screen.changeTextByTestId('scm-update-branch-source-picker', 'feature'); });
        await screen.pressByTestIdAsync('scm-update-branch-merge');
        expect(onMerge).toHaveBeenCalledOnce();
        expect(modalState.alert).not.toHaveBeenCalled();
    });
});
