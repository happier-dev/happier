import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { ActionExecuteFailureSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { router } from 'expo-router';
import { standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storageStore';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { SessionHandoffPickerResult } from '@/components/sessions/handoff/openSessionHandoffPicker';
import { SessionHandoffPickerModalEntry } from '@/components/sessions/handoff/SessionHandoffPickerModalEntry';
import { SessionHandoffProgressModal } from '@/components/sessions/handoff/SessionHandoffProgressModal';
import { resolveSessionHandoffUiAvailability } from './resolveSessionHandoffUiAvailability';
import { runSessionHandoffPickerFlow } from './runSessionHandoffPickerFlow';

// Distinct ids let each case tell the retained picker from the progress surface.
vi.mock('@/modal', async () => {
    let nextModalId = 0;
    return (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: { show: () => `modal-${++nextModalId}` },
    }).module;
});

const policyFields = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
const contentPolicy = { ...policyFields, policyDigest: computeWorkspaceSyncPolicyDigest(policyFields) };
const completed = (workspace: Readonly<{ kind: 'none' } | { kind: 'relationship'; relationshipId: string; created: boolean }> = { kind: 'none' }) => ({
    ok: true as const,
    result: {
        handoffId: 'handoff_1',
        status: { handoffId: 'handoff_1', status: 'completed' as const, phase: 'finalizing' as const, recoveryActions: [] },
        workspace,
    },
});

function pickerConfig() {
    const config = vi.mocked(Modal.show).mock.calls[0]?.[0];
    const props: unknown = config?.props;
    if (!config || config.component !== SessionHandoffPickerModalEntry || !props || typeof props !== 'object'
        || !('onResolve' in props) || typeof props.onResolve !== 'function') {
        throw new Error('Expected the real handoff picker at the native Modal boundary');
    }
    return { config, onResolve: props.onResolve as (selection: SessionHandoffPickerResult | null) => void };
}
const pickerModalId = () => vi.mocked(Modal.show).mock.results[0]?.value;
const progressSurfaces = () => vi.mocked(Modal.show).mock.calls.filter(([config]) => config.component === SessionHandoffProgressModal);

function chooseTarget(selection: SessionHandoffPickerResult = { targetMachineId: 'target', workspaceAction: { kind: 'none' } }) {
    pickerConfig().onResolve(selection);
}

function startFlow(execute: (...args: never[]) => Promise<ActionExecuteResult>, placement: 'session_info' | 'session_action_menu' = 'session_info') {
    return runSessionHandoffPickerFlow({ execute: execute as Parameters<typeof runSessionHandoffPickerFlow>[0]['execute'],
        sessionId: 'session-a', serverId: 'home-a', sourceMachineId: 'source', placement,
        availability: { available: true, reason: 'available' },
    });
}

describe('available session handoff entry', () => {
    const initial = storage.getState();
    beforeEach(async () => {
        // The picker submission holds the real sync user-request lease.
        await loadSyncSingletonForTests();
        for (const spy of [Modal.show, Modal.update, Modal.hide, Modal.confirm, Modal.alert, router.push]) vi.mocked(spy).mockClear();
        storage.setState({ profileScope: { serverId: 'home-a', accountId: 'account-a' } });
    });
    afterEach(() => { standardCleanup(); storage.setState(initial, true); });

    it('surfaces the actual unavailability reason and takes no action without opening a picker or transferring', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: false, errorCode: 'unexpected', error: 'Unexpected transfer' }));
        const availability = resolveSessionHandoffUiAvailability({ sessionId: 'session-a', serverId: 'home-a',
            session: createSessionFixture({ id: 'session-a', serverId: 'home-a' }),
            sessionHandoffFeatureEnabled: true, runtimeAvailability: 'unavailable',
            serverSnapshot: { status: 'ready', features: { capabilities: {}, features: {
                sessions: { enabled: true, handoff: { enabled: true } },
                machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } } },
            } } },
        });
        expect(availability).toEqual({ available: false, reason: 'runtime_direct_peer_unavailable' });
        const result = runSessionHandoffPickerFlow({ execute, sessionId: 'session-a', serverId: 'home-a',
            sourceMachineId: 'source', placement: 'session_info', availability,
        });
        // Settle the old behavior's picker, so a missing admission check fails an assertion, not a timeout.
        vi.mocked(Modal.show).mock.calls[0]?.[0].onRequestClose?.();
        // The flow takes no action; the reason is the resolved availability asserted above.
        await expect(result).resolves.toBeNull();
        expect(Modal.show).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    });

    it('keeps an admitted request pending and returns an unknown Action outcome without claiming completion', async () => {
        let complete!: (result: ActionExecuteResult) => void;
        const execute = vi.fn(() => new Promise<ActionExecuteResult>(resolve => { complete = resolve; }));
        const result = startFlow(execute);
        let settled = false;
        void result.then(() => { settled = true; });
        chooseTarget();
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        const unknown = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'rpc_request_outcome_unknown', error: 'Outcome unknown' });
        complete(unknown);
        await expect(result).resolves.toEqual(unknown);
    });

    it('returns null without submitting when the picker is dismissed', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => completed());
        const result = startFlow(execute);
        pickerConfig().config.onRequestClose?.();
        await expect(result).resolves.toBeNull();
        expect(execute).not.toHaveBeenCalled();
        expect(progressSurfaces()).toHaveLength(0);
    });

    it('opens the exact deferred approval on its Home instead of operation progress', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: true,
            result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'session.handoff' } }));
        const result = startFlow(execute);
        chooseTarget();
        await expect(result).resolves.toEqual({ ok: true, kind: 'approval_required', artifactId: 'approval-1' });
        expect(router.push).toHaveBeenCalledWith('/inbox/approvals/approval-1?serverId=home-a');
        expect(progressSurfaces()).toHaveLength(0);
        expect(Modal.hide).toHaveBeenCalledWith(pickerModalId());
    });

    it('shows awaiting admission on the retained picker until the request resolves', async () => {
        let complete!: (result: ActionExecuteResult) => void;
        const execute = vi.fn(() => new Promise<ActionExecuteResult>(resolve => { complete = resolve; }));
        const result = startFlow(execute);
        chooseTarget();
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        expect(Modal.update).toHaveBeenCalledWith(pickerModalId(), { awaitingAdmission: true });
        expect(Modal.update).not.toHaveBeenCalledWith(pickerModalId(), { awaitingAdmission: false });
        expect(progressSurfaces()).toHaveLength(0);
        complete(completed({ kind: 'relationship', relationshipId: 'relationship-1', created: true }));
        await expect(result).resolves.toMatchObject({ ok: true, result: { workspace: { kind: 'relationship' } } });
        expect(Modal.update).toHaveBeenCalledWith(pickerModalId(), { awaitingAdmission: false });
        expect(progressSurfaces()).toHaveLength(1);
        expect(Modal.update).toHaveBeenCalledWith(expect.any(String), {
            requestResult: completed({ kind: 'relationship', relationshipId: 'relationship-1', created: true }).result,
        });
    });

    it('does not open progress after the picker is deliberately dismissed before admission', async () => {
        let complete!: (result: ActionExecuteResult) => void;
        const execute = vi.fn(() => new Promise<ActionExecuteResult>(resolve => { complete = resolve; }));
        const result = startFlow(execute);
        chooseTarget();
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        pickerConfig().config.onRequestClose?.();
        expect(Modal.hide).toHaveBeenCalledWith(pickerModalId());
        complete(completed({ kind: 'relationship', relationshipId: 'relationship-1', created: true }));
        await expect(result).resolves.toMatchObject({ ok: true });
        expect(progressSurfaces()).toHaveLength(0);
    });

    it('submits relationship creation intent verbatim without generating identity or forwarding display-only fields', async () => {
        const workspaceAction = { kind: 'create_relationship' as const, mode: 'keep_synced' as const, contentPolicy, flushBeforeCommit: true as const };
        const execute = vi.fn(async (..._args: unknown[]): Promise<ActionExecuteResult> => completed());
        const result = startFlow(execute, 'session_action_menu');
        chooseTarget({ targetMachineId: 'target', targetMachineLabel: 'Build Mac', targetPath: '/target/repo',
            sourceRootPath: '/source/repo', targetSessionStorageMode: 'persisted', workspaceAction });
        await result;
        expect(execute).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledWith('session.handoff', {
            sessionId: 'session-a', targetMachineId: 'target', targetPath: '/target/repo',
            targetSessionStorageMode: 'persisted', workspaceAction,
        }, expect.objectContaining({ defaultSessionId: 'session-a', serverId: 'home-a', surface: 'ui',
            placement: 'session_action_menu', actionRequestId: expect.any(String) }));
    });

    it('leaves the single mirror confirmation to the daemon-bound Action approval', async () => {
        const workspaceAction = { kind: 'create_relationship' as const, mode: 'mirror_exactly' as const, contentPolicy, flushBeforeCommit: true as const };
        const execute = vi.fn(async (..._args: unknown[]): Promise<ActionExecuteResult> => completed());
        const result = startFlow(execute);
        chooseTarget({ targetMachineId: 'target-id', targetMachineLabel: 'Build Mac', targetPath: '/target/repo',
            sourceRootPath: '/source/repo', workspaceAction });
        await result;
        // The target daemon stamps the destination approval inside the Action
        // corridor, so the picker raises no prompt of its own.
        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0]?.[1]).toMatchObject({ targetMachineId: 'target-id', targetPath: '/target/repo' });
        expect((execute.mock.calls[0]?.[1] as { workspaceAction?: unknown }).workspaceAction).toEqual(workspaceAction);
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(Modal.alert).not.toHaveBeenCalled();
        expect(vi.mocked(Modal.show).mock.calls.map(([config]) => config.component))
            .toEqual([SessionHandoffPickerModalEntry, SessionHandoffProgressModal]);
    });
});
