import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

const routerPush = vi.hoisted(() => vi.fn());
const storageFixtures = vi.hoisted(() => ({
    sessionMetadata: null as Record<string, unknown> | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useMachine: () => null,
        useSession: () => null,
        useSessionListPreferredMetadata: () => storageFixtures.sessionMetadata,
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});

afterEach(() => {
    routerPush.mockReset();
    storageFixtures.sessionMetadata = null;
});

describe('ActionOperationDetailModal', () => {
    it('shows the preferred source session title when the full session is not loaded', async () => {
        storageFixtures.sessionMetadata = {
            path: '/workspace/dev',
            summary: { text: 'Stabilize CI and Nightly Releases', updatedAt: 123 },
        };
        actionOperationStore.mergeSnapshots([{
            version: 1,
            operationId: 'fork-operation',
            revision: 2,
            actionId: 'session.fork',
            state: 'succeeded',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            title: 'Fork session',
            createdAt: 1_000,
            settledAt: 2_000,
            cancellation: 'unsupported',
        }]);

        const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
        const screen = await renderScreen(
            <ActionOperationDetailModal
                operationId="fork-operation"
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        expect(screen.getTextContent()).toContain('Stabilize CI and Nightly Releases');
        expect(screen.getTextContent()).not.toContain('session-1');
    });

    it('renders the successful handoff cleanup warning and semantic phase', async () => {
        actionOperationStore.mergeSnapshots([{
            version: 1,
            operationId: 'handoff-operation',
            revision: 3,
            actionId: 'session.handoff',
            state: 'succeeded',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            title: 'Hand off session',
            createdAt: 1_000,
            startedAt: 1_100,
            settledAt: 2_000,
            progress: { kind: 'phase', phase: 'cleaning_source', label: 'Cleaning up source' },
            result: {
                handoffId: 'handoff-1',
                status: 'completed',
                warning: { code: 'source_cleanup_failed', message: 'cleanup_failed' },
            },
            domainRef: { kind: 'handoff', id: 'handoff-1' },
            cancellation: 'unsupported',
        }]);

        const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
        const screen = await renderScreen(
            <ActionOperationDetailModal
                operationId="handoff-operation"
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        expect(screen.findByTestId('action-operation-warning')).not.toBeNull();
        expect(screen.findByTestId('action-operation-field.phase')).not.toBeNull();
        expect(screen.findByTestId('action-operation-cancel')).toBeNull();
    });

    it('renders the standard validated plugin result and error summaries', async () => {
        actionOperationStore.mergeSnapshots([{
            version: 1,
            operationId: 'plugin-operation',
            revision: 2,
            actionId: 'acme.preview/deploy',
            state: 'succeeded',
            scope: { accountId: 'account-1', machineId: 'machine-1' },
            title: 'Deploy preview',
            createdAt: 1_000,
            startedAt: 1_100,
            settledAt: 2_000,
            result: { published: true, url: 'https://preview.example' },
            cancellation: 'unsupported',
        }]);

        const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
        const screen = await renderScreen(
            <ActionOperationDetailModal
                operationId="plugin-operation"
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        expect(screen.findByTestId('action-operation-result.published')).not.toBeNull();
        expect(screen.findByTestId('action-operation-result.url')).not.toBeNull();
    });

    it('opens the spawned session only through the explicit completion action', async () => {
        actionOperationStore.mergeSnapshots([{
            version: 1,
            operationId: 'spawn-operation',
            revision: 2,
            actionId: 'session.spawn_new',
            state: 'succeeded',
            scope: { accountId: 'account-1', machineId: 'machine-1' },
            title: 'Create session',
            createdAt: 1_000,
            startedAt: 1_100,
            settledAt: 2_000,
            result: { type: 'success', disposition: 'created', sessionId: 'spawned-session' },
            domainRef: { kind: 'spawnAttempt', id: 'spawn-attempt-1' },
            cancellation: 'unsupported',
        }]);
        const onClose = vi.fn();

        const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
        const screen = await renderScreen(
            <ActionOperationDetailModal
                operationId="spawn-operation"
                onClose={onClose}
                setChrome={vi.fn()}
            />,
        );

        expect(routerPush).not.toHaveBeenCalled();
        await pressTestInstanceAsync(screen.findByTestId('action-operation-open-session'));
        expect(routerPush).toHaveBeenCalledWith('/session/spawned-session');
        expect(onClose).toHaveBeenCalledOnce();
    });
});
