import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, createSessionFixture, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { consumeActionOperationSnapshotPush } from '@/sync/domains/actionOperations/consumeActionOperationSnapshotPush';
import { getActionOperation, type ActionOperationRpc } from '@/sync/ops/actionOperations';

const routerPush = vi.hoisted(() => vi.fn());
const initialState = storage.getState();
const resumeRpc = vi.hoisted(() => ({ signals: [] as (AbortSignal | undefined)[] }));
// The RPC transport is the external boundary; modal, operation projection and resume adapter stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: ({ signal }: { signal?: AbortSignal }) => {
        resumeRpc.signals.push(signal);
        return new Promise((_resolve, reject) => signal?.addEventListener('abort',
            () => reject(new Error('aborted')), { once: true }));
    },
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
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});

beforeEach(() => storage.setState(initialState, true));
afterEach(() => {
    standardCleanup();
    routerPush.mockReset();
    storage.setState(initialState, true);
    actionOperationStore.reset();
    resumeRpc.signals.length = 0;
});

const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');

describe('ActionOperationDetailModal', () => {
    it.each(['plain', 'e2ee'] as const)('shows the pushed Software Apply outcome after the daemon loses its receipt (%s)', async mode => {
        const homeId = 'home-a';
        const serverId = homeId;
        const active = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'software-apply', revision: 1,
            actionId: MACHINE_SETUP_APPLY_ACTION_ID_V1, state: 'running',
            scope: { accountId: 'account-1', machineId: 'machine-1' }, title: 'Install Software',
            createdAt: 100, startedAt: 110, cancellation: 'supported',
            domainRef: { kind: 'machineSetup', serverId: homeId, machineId: 'machine-1', terminalId: 'install-output' } });
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [active] });
        const screen = await renderScreen(<ActionOperationDetailModal serverId={serverId} operationId={active.operationId} onClose={() => {}} />);
        const terminal = ActionOperationSnapshotV1Schema.parse({ ...active, revision: 2, state: 'succeeded', settledAt: 200,
            domainRef: { ...active.domainRef, exitCode: 0 } });
        // Only the daemon RPC boundary has restarted. Its typed terminal push,
        // qualified reader, store, selector and mounted modal remain real.
        // RPC returns untyped wire data; getActionOperation validates the response.
        const rpc: ActionOperationRpc = async <Response,>() => ({ kind: 'not_found' } as Response);
        await act(async () => consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: mode === 'plain'
                ? { t: 'plain', v: terminal } : { t: 'encrypted', c: 'sealed-terminal' } },
            accountEncryptionMode: mode, accountId: 'account-1', sourceServerId: serverId,
            openSnapshot: () => terminal,
            readSnapshot: operationId => getActionOperation({ serverId, accountId: 'account-1', machineId: 'machine-1',
                operationId, requireCurrentDomainFacts: true, rpc }),
        }));
        expect(screen.getTextContent()).toContain('inbox.actionOperations.status.succeeded');
        expect(screen.getTextContent()).not.toContain('inbox.actionOperations.observation.unavailable');
        expect([...actionOperationStore.getSnapshot().operationsByKey.values()]).toEqual([{ serverId, snapshot: terminal }]);
    });

    it('cancels an unanswered handoff resume when its modal closes', async () => {
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [{
            version: 1, operationId: 'handoff-operation', revision: 3, actionId: 'session.handoff', state: 'running',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            title: 'Hand off session', createdAt: 1_000, startedAt: 1_100,
            progress: { kind: 'phase', phase: 'awaiting_user_resume', label: 'Resume' },
            domainRef: { kind: 'handoff', id: 'handoff-1', targetMachineId: 'machine-2' }, cancellation: 'unsupported',
        }] });
        const screen = await renderScreen(<ActionOperationDetailModal serverId="home-a" operationId="handoff-operation" onClose={vi.fn()} />);
        await screen.pressByTestIdAsync('action-operation-resume-handoff');
        expect(resumeRpc.signals).toHaveLength(1);
        await screen.unmount();
        expect(resumeRpc.signals[0]?.aborted).toBe(true);
    });
    it('shows the preferred source session title when the full session is not loaded', async () => {
        const session = createSessionFixture({
            id: 'session-1',
            serverId: 'home-a',
            encryptionMode: 'plain',
            metadata: {
                ...createSessionFixture().metadata!,
                path: '/workspace/dev',
                summary: { text: 'Stabilize CI and Nightly Releases', updatedAt: 123 },
            },
        });
        storage.setState({ sessionListRowsByServerId: { 'home-a': {
            [session.id]: buildSessionListRenderableFromSession(session),
        } } });
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [{
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
        }] });

        const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
        const setChrome = vi.fn();
        const screen = await renderScreen(
            <ActionOperationDetailModal
                serverId="home-a"
                operationId="fork-operation"
                onClose={vi.fn()}
                setChrome={setChrome}
            />,
        );

        expect(screen.getTextContent()).toContain('Stabilize CI and Nightly Releases');
        expect(screen.getTextContent()).not.toContain('session-1');
        // The title band names the operation; the raw action id is never shown in it.
        const chrome = setChrome.mock.calls.at(-1)?.[0];
        expect(chrome?.title).toBe('Fork session');
        expect(chrome?.subtitle).toBeUndefined();
    });

    it('renders the successful handoff cleanup warning and semantic phase', async () => {
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [{
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
        }] });

        const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
        const screen = await renderScreen(
            <ActionOperationDetailModal
                serverId="home-a"
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
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [{
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
        }] });

        const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
        const screen = await renderScreen(
            <ActionOperationDetailModal
                serverId="home-a"
                operationId="plugin-operation"
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        expect(screen.findByTestId('action-operation-result.published')).not.toBeNull();
        expect(screen.findByTestId('action-operation-result.url')).not.toBeNull();
    });

    it('opens the spawned session only through the explicit completion action', async () => {
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [{
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
        }] });
        const onClose = vi.fn();

        const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
        const screen = await renderScreen(
            <ActionOperationDetailModal
                serverId="home-a"
                operationId="spawn-operation"
                onClose={onClose}
                setChrome={vi.fn()}
            />,
        );

        expect(routerPush).not.toHaveBeenCalled();
        await pressTestInstanceAsync(screen.findByTestId('action-operation-open-session'));
        expect(routerPush).toHaveBeenCalledWith('/session/spawned-session?serverId=home-a');
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('does not adopt active-Home context or navigation for an unqualified legacy operation', async () => {
        const wrongSession = createSessionFixture({
            id: 'session-1',
            serverId: 'home-a',
            encryptionMode: 'plain',
            metadata: { ...createSessionFixture().metadata!, summary: { text: 'Wrong active-Home session', updatedAt: 123 } },
        });
        storage.setState({ sessions: { [wrongSession.id]: wrongSession }, sessionListRowsByServerId: { 'home-a': {
            [wrongSession.id]: buildSessionListRenderableFromSession(wrongSession),
        } } });
        actionOperationStore.mergeSnapshots({
            serverId: null,
            snapshots: [{
                version: 1,
                operationId: 'legacy-fork',
                revision: 2,
                actionId: 'session.fork',
                state: 'succeeded',
                scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
                title: 'Fork session',
                createdAt: 1_000,
                startedAt: 1_100,
                settledAt: 2_000,
                result: { childSessionId: 'child-session' },
                cancellation: 'unsupported',
            }],
        });

        const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
        const screen = await renderScreen(
            <ActionOperationDetailModal
                serverId={null}
                operationId="legacy-fork"
                onClose={vi.fn()}
                setChrome={vi.fn()}
            />,
        );

        expect(screen.getTextContent()).not.toContain('Wrong active-Home session');
        expect(screen.getTextContent()).not.toContain('session-1');
        expect(screen.findByTestId('action-operation-open-session')).toBeNull();
    });
});
