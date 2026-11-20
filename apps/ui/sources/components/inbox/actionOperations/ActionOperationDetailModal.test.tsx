import * as React from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, createSessionFixture, pressTestInstanceAsync, standardCleanup } from '@/dev/testkit';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import type { ActionOperationRpc } from '@/sync/ops/actionOperations';

const routerPush = vi.hoisted(() => vi.fn());
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

// Browser focus and dismissal listeners require a DOM; keep the shell, portal and modal owners real.
vi.mock('@/utils/web/radixCjs', async importOriginal => {
    const actual = await importOriginal<typeof import('@/utils/web/radixCjs')>();
    const Inline = (props: Readonly<{ children?: React.ReactNode }>) => props.children;
    return { ...actual, requireRadixDismissableLayer: () => ({ Root: Inline, Branch: Inline }),
        requireRadixFocusScope: () => ({ Root: Inline }) };
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { consumeActionOperationSnapshotPush } = await import('@/sync/domains/actionOperations/consumeActionOperationSnapshotPush');
const { getActionOperation } = await import('@/sync/ops/actionOperations');
const { storage } = await import('@/sync/domains/state/storageStore');
const initialState = storage.getState();

beforeEach(async () => { await homes.reset(); storage.setState(initialState, true); });
afterEach(async () => {
    standardCleanup();
    routerPush.mockReset();
    storage.setState(initialState, true);
    actionOperationStore.reset();
    resumeRpc.signals.length = 0;
    await homes.reset();
});

const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');

describe('ActionOperationDetailModal', () => {
    it('opens the exact held Project setup review inside the operation detail', async () => {
        const serverId = await homes.addHome({ name: 'Setup Home', serverUrl: 'https://modal-setup.test', accountId: 'account-1' });
        const snapshot = ActionOperationSnapshotV1Schema.parse({
            version: 1, operationId: 'team-source-setup', revision: 1, actionId: 'projects.prepare',
            state: 'accepted', scope: { accountId: 'account-1', machineId: 'machine-1' },
            title: 'Set up a project', createdAt: 100, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId, machineId: 'machine-1',
                workspaceRefId: 'checkout', cwd: '/repo',
                sourceWorkspace: { serverId, machineId: 'machine-1', workspaceId: 'checkout', rootPath: '/repo' } },
            setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required',
                reviewedEffectDigest: 'reviewed', reviewedEffect: {} },
        });
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [snapshot] });
        const screen = await renderScreen(<ActionOperationDetailModal serverId={serverId} operationId={snapshot.operationId} onClose={vi.fn()} />);

        expect(screen.findByTestId('project-setup-session-review:team-source-setup')).not.toBeNull();
        expect(screen.findByTestId('action-operation-cancel')).toBeNull();
    });

    it('opens the exact Workflow recovery from a failed Machine Setup receipt', async () => {
        const serverId = 'setup-home';
        const onClose = vi.fn();
        const snapshot = ActionOperationSnapshotV1Schema.parse({
            version: 1, operationId: 'failed-setup', revision: 2, actionId: MACHINE_SETUP_APPLY_ACTION_ID_V1,
            state: 'failed', scope: { accountId: 'account-1', machineId: 'machine-1' }, title: 'Apply machine setup',
            createdAt: 100, startedAt: 110, settledAt: 120, cancellation: 'unsupported',
            error: { errorCode: 'machine_setup_setup_failed', error: 'Setup failed',
                setupRetry: { runId: '5b423e3b-62a0-47ba-b4e1-93fe5895a517', invocationId: 'b7ea2558-7e4c-4e56-8439-4678c89f21c2' } },
        });
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [snapshot] });
        const screen = await renderScreen(<ActionOperationDetailModal serverId={serverId} operationId={snapshot.operationId} onClose={onClose} />);
        try {
            await screen.pressByTestIdAsync('action-operation-retry-setup');
            expect(routerPush).toHaveBeenCalledExactlyOnceWith(
                '/workflows/runs/5b423e3b-62a0-47ba-b4e1-93fe5895a517?invocationId=b7ea2558-7e4c-4e56-8439-4678c89f21c2&serverId=setup-home',
            );
            expect(onClose).toHaveBeenCalledOnce();
        } finally { await screen.unmount(); }
    });

    it('keeps the Account investigation owner when Inbox opens a failed operation in the shell modal', async () => {
        const [{ AppPaneModalProvider }, { renderScreen: renderRoot }, { openActionOperationDetail }, { AccountNoticeInvestigationBoundary }] = await Promise.all([
            import('@/components/appShell/providers/AppPaneModalProvider'), import('@/dev/testkit'),
            import('./openActionOperationDetail'), import('@/hooks/inbox/AccountNoticeInvestigationProvider'),
        ]);
        const snapshot = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'modal-setup-failure', revision: 1,
            actionId: MACHINE_SETUP_APPLY_ACTION_ID_V1, state: 'failed',
            scope: { accountId: 'account-1', machineId: 'machine-1' }, title: 'Apply machine setup',
            createdAt: 100, startedAt: 110, settledAt: 120, cancellation: 'unsupported',
            error: { errorCode: 'content_unavailable', error: 'Setup could not start' },
        });
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [snapshot] });
        // The real shell portal is above Inbox's existing boundary, just as on the loaded app.
        const screen = await renderRoot(<AppPaneModalProvider><AccountNoticeInvestigationBoundary>
            <View testID="inbox-page" />
        </AccountNoticeInvestigationBoundary></AppPaneModalProvider>);
        try {
            await act(async () => { openActionOperationDetail({ serverId: 'home-a', operationId: snapshot.operationId }); });
            const { waitForTestEvent } = await import('@/dev/testkit');
            await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('action-operation-investigate')).not.toBeNull());
        } finally { await screen.unmount(); }
    });

    it.each([
        { kind: 'backup', failed: true }, { kind: 'managed-install', failed: true },
        { kind: 'machine-setup', failed: true }, { kind: 'machine-setup-before-execution', failed: true },
        { kind: 'backup', failed: false },
    ] as const)('offers the shared investigation only for a failed receipt ($kind, failed=$failed)', async ({ kind, failed }) => {
        const snapshot = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'retained-failure', revision: 1,
            actionId: kind === 'backup' ? DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 : kind.startsWith('machine-setup') ? MACHINE_SETUP_APPLY_ACTION_ID_V1 : 'machines.managed.acquire', state: failed ? 'failed' : 'succeeded',
            scope: { accountId: 'account-1', machineId: 'machine-1' }, title: 'Retained failure',
            createdAt: 100, startedAt: 110, settledAt: 120, cancellation: 'unsupported',
            ...(failed ? { error: { errorCode: 'native_failed', error: 'Native operation failed' } } : {}),
            ...(kind === 'managed-install' ? { domainRef: { kind: 'managedMachine', id: 'removed-managed-resource' } }
                : kind === 'machine-setup' ? { domainRef: { kind: 'machineSetup', serverId: 'home-a', machineId: 'machine-1', terminalId: 'install-output' } } : {}),
        });
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [snapshot] });
        const screen = await renderScreen(<ActionOperationDetailModal serverId="home-a" operationId={snapshot.operationId} onClose={() => {}} />);
        try {
            expect(screen.findByTestId('action-operation-investigate') !== null).toBe(failed);
            expect(screen.findByTestId('action-operation-retry-setup')).toBeNull();
        } finally { await screen.unmount(); }
    });

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
        expect([...actionOperationStore.getSnapshot().operationsByKey.values()]).toMatchObject([{ serverId, snapshot: terminal }]);
    });

    it('shows a Setup operation\u2019s reviewed steps as the Setup checklist', async () => {
        const operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'setup-steps', revision: 1,
            actionId: MACHINE_SETUP_APPLY_ACTION_ID_V1, state: 'running', scope: { accountId: 'account-1', machineId: 'machine-1' },
            title: 'Set up', createdAt: 100, startedAt: 110, cancellation: 'supported',
            domainRef: { kind: 'machineSetup', serverId: 'home-a', machineId: 'machine-1', steps: [
                { planIndex: 0, stepId: 'docker', label: { key: 'x', fallback: 'Install Docker' }, state: 'succeeded' },
                { planIndex: 0, stepId: 'firewall', label: { key: 'y', fallback: 'Open the firewall' }, state: 'running' },
            ] } });
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [operation] });
        const screen = await renderScreen(<ActionOperationDetailModal serverId="home-a" operationId="setup-steps" onClose={() => {}} />);
        expect(screen.findByTestId('action-operation-setup-steps')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Install Docker');
        expect(screen.getTextContent()).toContain('Open the firewall');
        await screen.unmount();
    });

    it('shows a Project setup’s reviewed commands on the same Setup checklist, the running init opening its terminal in place (E U2)', async () => {
        const operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'project-setup-steps', revision: 1,
            actionId: 'projects.prepare', state: 'running', scope: { accountId: 'account-1', machineId: 'machine-1' },
            title: 'Set up a project', createdAt: 100, startedAt: 110, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'home-a', machineId: 'machine-1',
                workspaceRefId: 'checkout', cwd: '/repo', steps: [
                    { index: 0, source: { kind: 'command', command: 'pnpm install' }, state: 'succeeded', exitCode: 0 },
                    { index: 1, source: { kind: 'command', command: './scripts/init.sh' }, state: 'running', terminalId: 'init-terminal' },
                    { index: 2, source: { kind: 'command', command: 'pnpm db:migrate' }, state: 'pending' },
                ] } });
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [operation] });
        const screen = await renderScreen(<ActionOperationDetailModal serverId="home-a" operationId="project-setup-steps" onClose={() => {}} />);
        const steps = screen.findByTestId('action-operation-setup-steps');
        expect(steps).not.toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('pnpm install');
        expect(text).toContain('./scripts/init.sh');
        expect(text).toContain('pnpm db:migrate');
        await screen.unmount();
    });

    it('marks the step a Setup waits on as needing the person, asking its password question once above', async () => {
        const operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'setup-waits', revision: 1,
            actionId: MACHINE_SETUP_APPLY_ACTION_ID_V1, state: 'running', scope: { accountId: 'account-1', machineId: 'machine-1' },
            title: 'Set up', createdAt: 100, startedAt: 110, cancellation: 'supported',
            domainRef: { kind: 'machineSetup', serverId: 'home-a', machineId: 'machine-1',
                setupTask: { id: 'task-1', taskKind: 'machine.setup.apply.v1', prompt: { kind: 'sudo.password', adminUsername: 'ops' } },
                steps: [
                    { planIndex: 0, stepId: 'redis', label: { key: 'x', fallback: 'Redis 7' }, state: 'succeeded' },
                    { planIndex: 0, stepId: 'postgres', label: { key: 'y', fallback: 'Postgres 17' }, state: 'running' },
                ] } });
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [operation] });
        const screen = await renderScreen(<ActionOperationDetailModal serverId="home-a" operationId="setup-waits" onClose={() => {}} />);
        const steps = screen.findByTestId('action-operation-setup-steps')!;
        const text = (node: typeof steps) => node.findAll(child => typeof child.children?.[0] === 'string')
            .map(child => child.children[0] as string);
        expect(text(steps)).toContain('inbox.needsYou');
        expect(text(steps)).not.toContain('common.running');
        expect(screen.findHostByTestId('action-operation-sudo-password')).not.toBeNull();
        expect(text(steps)).not.toContain('inbox.actionOperations.sudo.passwordFor');
        await screen.unmount();
    });

    it('acknowledges the active operation settling while its detail remains open', async () => {
        const active = { version: 1 as const, operationId: 'settles-open', revision: 1, actionId: 'session.spawn_new',
            state: 'running' as const, scope: { accountId: 'account-1', machineId: 'machine-1' }, title: 'Create session',
            createdAt: 100, startedAt: 110, cancellation: 'unsupported' as const };
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [active] });
        await renderScreen(<ActionOperationDetailModal serverId="home-a" operationId="settles-open" onClose={() => {}} />);
        await act(async () => actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [{ ...active,
            revision: 2, state: 'failed', settledAt: 200, error: { errorCode: 'internal_error', error: 'Failed' } }] }));
        expect([...actionOperationStore.getSnapshot().seenAtByOperationKey.values()]).toMatchObject([{ revision: 2 }]);
    });

    it('does not acknowledge terminal outcomes from mounting the detail component', async () => {
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [{
            version: 1, operationId: 'mount-only', revision: 1, actionId: 'session.spawn_new', state: 'failed',
            scope: { accountId: 'account-1', machineId: 'machine-1' }, title: 'Create session',
            createdAt: 100, settledAt: 200, cancellation: 'unsupported',
        }] });
        await renderScreen(<ActionOperationDetailModal serverId="home-a" operationId="mount-only" onClose={() => {}} />);
        expect(actionOperationStore.getSnapshot().seenAtByOperationKey.size).toBe(0);
    });


    it('cancels an unanswered handoff resume when its modal closes', async () => {
        const serverId = await homes.addHome({ name: 'Recovery Home', serverUrl: 'https://modal-recovery.test', accountId: 'account-1' });
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [{
            version: 1, operationId: 'handoff-operation', revision: 3, actionId: 'session.handoff', state: 'running',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            title: 'Hand off session', createdAt: 1_000, startedAt: 1_100,
            progress: { kind: 'phase', phase: 'awaiting_user_resume', label: 'Resume' },
            domainRef: { kind: 'handoff', id: 'handoff-1', targetMachineId: 'machine-2' }, cancellation: 'unsupported',
        }] });
        const screen = await renderScreen(<ActionOperationDetailModal serverId={serverId} operationId="handoff-operation" onClose={vi.fn()} />);
        await screen.pressByTestIdAsync('action-operation-resume-handoff');
        await vi.waitFor(() => expect(resumeRpc.signals).toHaveLength(1));
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
