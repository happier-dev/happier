import { describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { projectActionOperationListSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectCommandSourceV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { ProjectCommandAttachmentV1 } from '@happier-dev/protocol/actions/operations/v1';

import { createActionOperationSelectors, readActionOperationSudoPrompt, selectTerminalActionOperation } from './actionOperationSelectors';
import { createActionOperationStore, type ActionOperationStore } from './actionOperationStore';
import { actionOperationAddressKey, actionOperationMachineAddressKey } from './qualifiedActionOperation';
import type { ActionOperationProjectScriptQuery } from './qualifiedActionOperation';

import { getPersistenceStorage } from '../state/persistenceStorage';
import { serverAccountScopedStorageKey } from '../scope/serverAccountScope';
import { log } from '@/log';

const SERVER_ID = 'home-a';

function merge(store: ActionOperationStore, snapshots: readonly ActionOperationSnapshotV1[]): void {
    store.mergeSnapshots({ serverId: SERVER_ID, snapshots });
}

function operationAddress(operationId: string) {
    return { serverId: SERVER_ID, operationId } as const;
}

function sessionAddress(sessionId: string) {
    return { serverId: SERVER_ID, sessionId } as const;
}

function operation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return {
        version: 1 as const,
        operationId: 'operation-a',
        revision: 1,
        actionId: 'session.spawn_new',
        state: 'accepted' as const,
        scope: {
            accountId: 'account-a',
            machineId: 'machine-a',
            sessionId: 'session-a',
        },
        title: 'Create session',
        createdAt: 100,
        cancellation: 'unsupported' as const,
        ...overrides,
    };
}

describe('action operation store', () => {
    it.each(['succeeded', 'failed', 'cancelled'] as const)(
        'publishes a complete %s snapshot at the summary revision and never downgrades it to a later summary', state => {
            const store = createActionOperationStore();
            const full = operation({ actionId: 'deployments.backups.restore', requestId: 'restore-request', state,
                startedAt: 110, settledAt: 200,
                ...(state === 'succeeded' ? { result: { kind: 'restored', verified: true, nextAction: 'Inspect', evidence: {} } }
                    : state === 'failed' ? { error: { errorCode: 'restore_failed', error: 'restore_failed' } } : {}) });
            const summary = projectActionOperationListSnapshotV1(full);
            const read = () => store.getSnapshot().operationsByKey.get(actionOperationAddressKey(operationAddress(full.operationId)));
            const observations: boolean[] = [];
            store.subscribe(() => observations.push(read()?.snapshotComplete === true));
            merge(store, [summary]);
            expect(read()?.snapshotComplete).toBeUndefined();
            store.mergeSnapshots({ serverId: SERVER_ID, snapshots: [full], snapshotComplete: true });
            expect(read()).toMatchObject({ snapshot: full, snapshotComplete: true });
            expect(observations).toEqual([false, true]);
            const completed = store.getSnapshot();
            merge(store, [summary]);
            store.mergeSnapshots({ serverId: SERVER_ID, snapshots: [full], snapshotComplete: true });
            expect(store.getSnapshot()).toBe(completed);
            expect(observations).toEqual([false, true]);
        });

    it.each([
        { title: 'Changed lifecycle fact' },
        { requestId: 'another-request' },
        { scope: { accountId: 'another-account', machineId: 'machine-a', sessionId: 'session-a' } },
    ])('rejects same-revision completeness that changes retained facts: %j', changes => {
        const store = createActionOperationStore();
        const full = operation({ state: 'succeeded', settledAt: 200, requestId: 'original-request', result: { accepted: true } });
        const summary = projectActionOperationListSnapshotV1(full);
        merge(store, [summary]);
        const before = store.getSnapshot();
        store.mergeSnapshots({ serverId: SERVER_ID, snapshots: [{ ...full, ...changes }], snapshotComplete: true });
        expect(store.getSnapshot()).toBe(before);
        expect(before.operationsByKey.get(actionOperationAddressKey(operationAddress(full.operationId))))
            .toMatchObject({ snapshot: summary });
    });

    it('upgrades an identical unmarked full receipt without allowing same-revision result replacement', () => {
        const store = createActionOperationStore();
        const full = operation({ state: 'succeeded', settledAt: 200, result: { accepted: true } });
        merge(store, [full]);
        const before = store.getSnapshot();
        store.mergeSnapshots({ serverId: SERVER_ID, snapshots: [{ ...full, result: { accepted: false } }], snapshotComplete: true });
        expect(store.getSnapshot()).toBe(before);
        store.mergeSnapshots({ serverId: SERVER_ID, snapshots: [full], snapshotComplete: true });
        const retained = store.getSnapshot().operationsByKey.get(actionOperationAddressKey(operationAddress(full.operationId)));
        expect(retained?.snapshot).toBe(full);
        expect(retained?.snapshotComplete).toBe(true);
    });
    it('publishes exact worker admission changes once and keeps labels, other scopes, removal and reset truthful', () => {
        const state = createActionOperationStore();
        const scope = { serverId: SERVER_ID, accountId: 'account-a' };
        const changed = vi.fn();
        const stop = state.subscribeWorkerStatus(scope, ['machine-a'], changed);
        const finite = operation({ actionId: 'projects.script.run', state: 'running' });
        try {
            for (let index = 0; index < 20; index++) merge(state, [operation({ operationId: `other-${index}`,
                actionId: 'projects.script.run', scope: { accountId: scope.accountId, machineId: `other-${index}` } })]);
            merge(state, [{ ...finite, operationId: 'other-account', scope: { ...finite.scope, accountId: 'other' } }]);
            state.mergeSnapshots({ serverId: 'other-home', snapshots: [finite] });
            expect(changed).not.toHaveBeenCalled();
            merge(state, [finite, { ...finite, operationId: 'second' }]);
            expect(changed).toHaveBeenCalledTimes(1);
            expect(state.readWorkerStatusRevision(scope, 'machine-a')).toBe(1);
            merge(state, [{ ...finite, revision: 2, title: 'Label only' }]);
            expect(changed).toHaveBeenCalledTimes(1);
            merge(state, [{ ...finite, revision: 3, progress: { kind: 'phase', phase: 'preparing', label: 'Preparing' } }]);
            expect(changed).toHaveBeenCalledTimes(2);
            merge(state, [{ ...finite, revision: 4, state: 'succeeded', settledAt: 200 }]);
            expect(changed).toHaveBeenCalledTimes(3);
            state.reconcileMachineProjection({ ...scope, machineId: 'machine-a', snapshots: [], knownOperationKeys: new Set([
                actionOperationAddressKey(operationAddress(finite.operationId)),
            ]) });
            expect(changed).toHaveBeenCalledTimes(4);
            state.retainAccountMachines({ ...scope, machineIds: new Set() });
            expect(changed).toHaveBeenCalledTimes(5);
            merge(state, [finite]);
            expect(changed).toHaveBeenCalledTimes(6);
            state.reset();
            expect(changed).toHaveBeenCalledTimes(7);
            expect(state.readWorkerStatusRevision(scope, 'machine-a')).toBe(7);
        } finally { stop(); }
    });
    it('restores terminal acknowledgements before replay without sharing them across Homes or Accounts', () => {
        const selectors = createActionOperationSelectors();
        const failed = operation({ state: 'failed', settledAt: 200 });
        const first = createActionOperationStore();
        merge(first, [failed]);
        first.markTerminalSeen(operationAddress(failed.operationId), 250);
        const replay = createActionOperationStore();
        const observedAttention: boolean[] = [];
        replay.subscribe(() => observedAttention.push(selectors.selectHasUnseenTerminal(replay.getSnapshot())));
        merge(replay, [failed]);
        expect(observedAttention).toEqual([false]);
        replay.mergeSnapshots({ serverId: 'home-b', snapshots: [failed] });
        expect(selectors.selectHasUnseenTerminal(replay.getSnapshot())).toBe(true);
        const otherAccount = createActionOperationStore();
        merge(otherAccount, [{ ...failed, scope: { ...failed.scope, accountId: 'account-b' } }]);
        expect(selectors.selectHasUnseenTerminal(otherAccount.getSnapshot())).toBe(true);
        merge(replay, [{ ...failed, revision: 2 }]);
        expect(selectors.selectHasUnseenTerminal(replay.getSnapshot())).toBe(true);
    });

    it('dismisses a seen failure from both ledgers durably while retaining its failed snapshot and held reviews', () => {
        const store = createActionOperationStore();
        const failed = operation({ state: 'failed', settledAt: 200 });
        merge(store, [failed]);
        store.markAllTerminalSeen();
        expect(store.dismissOperation(operationAddress(failed.operationId))).toBe(true);
        const replay = createActionOperationStore();
        merge(replay, [failed]);
        const selectors = createActionOperationSelectors();
        expect(selectors.selectAll(replay.getSnapshot())).toEqual([]);
        expect(selectors.selectInbox(replay.getSnapshot())).toEqual([]);
        expect(selectors.selectById(replay.getSnapshot(), operationAddress(failed.operationId))?.snapshot).toBe(failed);
        const review = operation({ operationId: 'held-review', state: 'running', observation: {
            kind: 'review_required', code: 'action_review_required',
        } });
        merge(replay, [review]);
        replay.reconcileMachineProjection({ serverId: SERVER_ID, accountId: 'account-a', machineId: 'machine-a', snapshots: [failed],
            knownOperationKeys: new Set([actionOperationAddressKey(operationAddress(review.operationId))]) });
        expect(replay.dismissOperation(operationAddress(review.operationId))).toBe(false);
        expect(replay.dismissUnavailable(operationAddress(review.operationId))).toBe(false);
    });

    it('does not record Clear recent for success that still needs follow-up attention', () => {
        const store = createActionOperationStore();
        const success = operation({ operationId: 'followup', requestId: 'request-followup', state: 'succeeded', settledAt: 200 });
        merge(store, [success]);
        store.markFollowUpNeedsAttention({ serverId: SERVER_ID, accountId: 'account-a', requestId: 'request-followup', message: 'Setup needs attention' });
        expect(store.dismissRecentSucceeded()).toBe(false);
        const replay = createActionOperationStore();
        merge(replay, [success]);
        expect(createActionOperationSelectors().selectAll(replay.getSnapshot())).toHaveLength(1);
    });

    it('accepts the predecessor acknowledgement shape and binds its seen revision to first replay', () => {
        // Current ../0.2 writes this v1 shape without a revision field.
        const key = serverAccountScopedStorageKey('action-operation-acknowledgements-v1', { serverId: SERVER_ID, accountId: 'account-a' });
        getPersistenceStorage().set(key, JSON.stringify({ version: 1, entries: [
            { operationId: 'legacy', machineId: 'machine-a', seenAt: 250 },
            { operationId: 'removed', machineId: 'machine-a', seenAt: 250 },
        ] }));
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const settled = operation({ operationId: 'legacy', revision: 4, state: 'failed', settledAt: 200 });
        store.reconcileMachineProjection({ serverId: SERVER_ID, accountId: 'account-a', machineId: 'machine-a',
            snapshots: [settled], knownOperationKeys: new Set() });
        expect(selectors.selectHasUnseenTerminal(store.getSnapshot())).toBe(false);
        const restarted = createActionOperationStore();
        merge(restarted, [{ ...settled, revision: 5 }]);
        expect(selectors.selectHasUnseenTerminal(restarted.getSnapshot())).toBe(true);
    });

    it('prunes restored decisions from a complete machine list before snapshot replay', () => {
        const first = createActionOperationStore();
        const success = operation({ state: 'succeeded', settledAt: 200 });
        merge(first, [success]);
        first.dismissRecentSucceeded();
        const reconciled = createActionOperationStore();
        reconciled.reconcileMachineProjection({ serverId: SERVER_ID, accountId: 'account-a', machineId: 'machine-a',
            snapshots: [], knownOperationKeys: new Set() });
        const replay = createActionOperationStore();
        merge(replay, [success]);
        expect(createActionOperationSelectors().selectAll(replay.getSnapshot())).toHaveLength(1);
    });

    it('records corrupt storage and failed persistence in the default diagnostic ring', () => {
        const key = serverAccountScopedStorageKey('action-operation-acknowledgements-v1', { serverId: SERVER_ID, accountId: 'account-a' });
        getPersistenceStorage().set(key, '{corrupt');
        log.clear();
        const store = createActionOperationStore();
        merge(store, [operation({ state: 'failed', settledAt: 200 })]);
        expect(log.getLogs()).toContain('[actionOperations] Could not load local acknowledgements (SyntaxError)');
        const write = vi.spyOn(getPersistenceStorage(), 'set').mockImplementation(() => { throw new Error('disk'); });
        try {
            store.markTerminalSeen(operationAddress('operation-a'));
            expect(log.getLogs()).toContain('[actionOperations] Could not save local acknowledgements (Error)');
        } finally { write.mockRestore(); }
    });

    it('keeps Clear recent acknowledged after restart without persisting unavailable active suppression', () => {
        const selectors = createActionOperationSelectors();
        const success = operation({ operationId: 'cleared-success', state: 'succeeded', settledAt: 200 });
        const active = operation({ operationId: 'unavailable-active', state: 'running' });
        const store = createActionOperationStore();
        merge(store, [success, active]);
        store.dismissRecentSucceeded();
        store.reconcileMachineProjection({ serverId: SERVER_ID, accountId: 'account-a', machineId: 'machine-a',
            snapshots: [success], knownOperationKeys: new Set([actionOperationAddressKey(operationAddress(active.operationId))]) });
        store.dismissUnavailable(operationAddress(active.operationId));
        const replay = createActionOperationStore();
        merge(replay, [success, active]);
        expect(selectors.selectAll(replay.getSnapshot()).map(item => item.snapshot.operationId)).toEqual([active.operationId]);
    });


    it('keeps a live sudo question in Needs-you until its current operation clears it', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const held = operation({ actionId: 'machines.setup.adminAccess.set', state: 'running',
            domainRef: { kind: 'machineSetup', serverId: SERVER_ID, machineId: 'machine-a', setupTask: {
                id: 'actual-task', taskKind: 'machine.setup.apply.v1', prompt: { kind: 'sudo.password', adminUsername: 'ops.admin' },
            } } });
        merge(store, [held]);
        expect(selectors.selectInbox(store.getSnapshot())).toMatchObject([{ reason: 'attendance_required' }]);
        const stable = selectors.selectInbox(store.getSnapshot());
        expect(selectors.selectInbox(store.getSnapshot())).toBe(stable);
        expect(readActionOperationSudoPrompt(held)).toMatchObject({ id: 'actual-task', prompt: { kind: 'sudo.password' } });
        merge(store, [{ ...held, revision: 2, domainRef: { kind: 'machineSetup', serverId: SERVER_ID,
            machineId: 'machine-a', setupTask: { id: 'actual-task', taskKind: 'machine.setup.apply.v1' } } }]);
        expect(selectors.selectInbox(store.getSnapshot())).toEqual([]);
        expect(readActionOperationSudoPrompt({ ...held, state: 'succeeded', settledAt: 200 })).toBeNull();
        const reboot = operation({ actionId: 'machines.reboot', state: 'running', domainRef: {
            kind: 'machineReboot', serverId: SERVER_ID, machineId: 'machine-a', installationId: 'installation',
            task: { id: 'reboot-task', taskKind: 'machine.reboot.v1', prompt: { kind: 'sudo.password', adminUsername: 'ops.admin' } },
        } });
        expect(readActionOperationSudoPrompt(reboot)).toMatchObject({ id: 'reboot-task' });
    });

    it('reads one qualified operation without traversing unrelated inventory and preserves its observation identity', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const selectedOperation = operation();
        merge(store, [selectedOperation, ...Array.from({ length: 1000 }, (_, index) => operation({ operationId: `unrelated-${index}` }))]);
        let traversals = 0;
        const instrument = () => {
            const state = store.getSnapshot();
            // Instrument the real admitted map's iteration boundary; lookup and selector logic stay real.
            const operationsByKey = new Proxy(state.operationsByKey, { get(target, key) {
                const value: unknown = Reflect.get(target, key, target);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                    if (key === Symbol.iterator || key === 'entries' || key === 'keys' || key === 'values' || key === 'forEach') traversals++;
                    return Reflect.apply(value, target, args);
                };
            } });
            return { ...state, operationsByKey };
        };
        const selected = selectors.selectById(instrument(), operationAddress(selectedOperation.operationId));
        expect(selected?.snapshot).toBe(selectedOperation);
        expect(traversals).toBe(0);
        merge(store, [operation({ operationId: 'another' })]);
        expect(selectors.selectById(instrument(), operationAddress(selectedOperation.operationId))).toBe(selected);
        store.setMachineObservation({ serverId: SERVER_ID, machineId: selectedOperation.scope.machineId }, 'reconnecting');
        const reconnecting = selectors.selectById(instrument(), operationAddress(selectedOperation.operationId));
        expect(reconnecting?.snapshot).toBe(selectedOperation);
        expect(reconnecting?.observation).toBe('reconnecting');
        expect(traversals).toBe(0);
        store.reset();
        expect(selectors.selectById(instrument(), operationAddress(selectedOperation.operationId))).toBeNull();
    });

    it('selects the latest Delete success over an older failure and retains a genuinely later failure', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const query = { serverId: SERVER_ID, accountId: 'account-a', machineId: 'controller', managedId: 'managed' };
        const failed = operation({ operationId: 'earlier-failure', actionId: 'machines.managed.power.set',
            scope: { accountId: 'account-a', machineId: 'controller' },
            domainRef: { kind: 'managedMachine', id: 'managed' }, state: 'failed', createdAt: 100, settledAt: 300,
            error: { errorCode: 'managed_controller_request_failed', error: 'managed_controller_request_failed' } });
        const deleted = { ...failed, operationId: 'successful-delete', actionId: 'machines.managed.delete' as const,
            state: 'succeeded' as const, createdAt: 200, settledAt: 250, error: undefined };
        merge(store, [failed, deleted]);
        expect(selectors.selectForManagedMachine(store.getSnapshot(), query)?.snapshot).toEqual(deleted);
        merge(store, [{ ...failed, operationId: 'later-failure', createdAt: 350, settledAt: 400 }]);
        expect(selectors.selectForManagedMachine(store.getSnapshot(), query)?.snapshot.operationId).toBe('later-failure');
    });
    it.each([{ actionId: 'machines.setup.apply', scopeMachineId: 'joined-guest', presetOrigin: true },
        { actionId: 'machines.setup.apply', scopeMachineId: 'joined-guest', presetOrigin: false },
        { actionId: 'machines.managed.acquire', scopeMachineId: 'controller', presetOrigin: true }] as const)(
        'selects retained $actionId output (preset=$presetOrigin) only for the same Account, joined machine and managed row', ({ actionId, scopeMachineId, presetOrigin }) => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const homeId = 'portable-home';
        const setup = operation({ actionId, operationId: 'setup', state: 'failed', settledAt: 150,
            scope: { accountId: 'account-a', machineId: scopeMachineId },
            domainRef: { kind: 'machineSetup', serverId: homeId, machineId: 'joined-guest',
                ...(presetOrigin ? { preset: { id: 'preset', revision: 4 } } : {}), managedId: 'paid', terminalId: 'output' } });
        merge(store, [setup, { ...setup, operationId: 'other-managed', createdAt: 300,
            domainRef: { kind: 'machineSetup', serverId: homeId, machineId: 'joined-guest',
                preset: { id: 'preset', revision: 4 }, managedId: 'other' } },
            { ...setup, operationId: 'other-account', createdAt: 300, scope: { accountId: 'other', machineId: 'joined-guest' } }]);
        const query = { serverId: SERVER_ID, homeId, accountId: 'account-a', machineId: 'controller', enrolledMachineId: 'joined-guest', managedId: 'paid' };
        expect(selectors.selectForManagedMachine(store.getSnapshot(), query)?.snapshot.operationId).toBe('setup');
        expect(selectTerminalActionOperation(store.getSnapshot(), { serverId: homeId, accountId: 'account-a',
            machineId: 'joined-guest', terminalId: 'output' })?.snapshot.operationId).toBe('setup');
        expect(selectors.selectForManagedMachine(store.getSnapshot(), { ...query, enrolledMachineId: 'other-guest' })).toBeNull();
        expect(selectors.selectForManagedMachine(store.getSnapshot(), { ...query, homeId: 'other-home' })).toBeNull();
    });
    it('selects the current or last named Script from every client by authenticated Source, including dismissed success', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const workspace: WorkspaceAddressV1 = { serverId: SERVER_ID, machineId: 'source-machine', workspaceId: 'source-workspace', rootPath: '/source' };
        const attachment: ProjectCommandAttachmentV1 = { kind: 'projectCommand', purpose: 'setup', serverId: 'execution-home', machineId: 'execution-machine',
                workspaceRefId: 'execution-workspace', cwd: '/execution', sourceWorkspace: workspace,
                script: { name: 'build', source: { kind: 'command', command: 'old-build-command' } } };
        const script = operation({ actionId: 'projects.script.run', operationId: 'external-active', createdAt: 90, domainRef: attachment });
        const last = { ...script, operationId: 'last', state: 'succeeded' as const, startedAt: 100, settledAt: 200,
            domainRef: { ...attachment, purpose: 'script' as const, terminalId: 'terminal-last' } };
        merge(store, [last, script, { ...script, operationId: 'foreign-account', createdAt: 999, scope: { ...script.scope, accountId: 'account-b' } },
            { ...script, operationId: 'foreign-source', createdAt: 999, domainRef: { ...attachment, sourceWorkspace: { ...workspace, machineId: 'other-source' } } },
            { ...script, operationId: 'foreign-root', createdAt: 999, domainRef: { ...attachment, sourceWorkspace: { ...workspace, rootPath: '/other' } } }]);
        store.mergeSnapshots({ serverId: 'other-home', snapshots: [{ ...script, operationId: 'foreign-home', createdAt: 999 }] });
        expect(store.getSnapshot().operationsByKey.size).toBe(6);
        const read = (query: ActionOperationProjectScriptQuery) => selectors.selectForProjectScript(store.getSnapshot(), query);
        const query = { accountId: 'account-a', workspace, selection: { kind: 'named' as const, name: 'build' } };
        expect(read(query)?.snapshot.operationId).toBe('external-active');
        expect(read({ ...query, accountId: null })).toBeNull();
        merge(store, [{ ...script, revision: 2, state: 'failed', startedAt: 100, settledAt: 150, error: { errorCode: 'project_setup_step_failed', error: 'Setup failed' } }]);
        expect(store.dismissRecentSucceeded()).toBe(true);
        expect(selectors.selectAll(store.getSnapshot()).some(item => item.snapshot.operationId === 'last')).toBe(false);
        const selected = read(query);
        expect(selected?.snapshot.operationId).toBe('last');
        merge(store, [operation({ operationId: 'unrelated' })]);
        selectors.selectAll(store.getSnapshot());
        expect(read(query)).toBe(selected);
        expect(selectors.selectById(store.getSnapshot(), operationAddress('last'))?.snapshot.operationId).toBe('last');
        const windowsWorkspace = { ...workspace, rootPath: 'C:\\PROJECT\\' };
        merge(store, [{ ...script, operationId: 'windows-script', domainRef: { ...attachment, sourceWorkspace: windowsWorkspace, script: { ...attachment.script!, name: 'windows-build' } } }]);
        expect(read({ ...query, workspace: { ...windowsWorkspace, rootPath: 'c:/project' }, selection: { kind: 'named', name: 'windows-build' } })?.snapshot.operationId).toBe('windows-script');
    });

    it('selects unnamed native Scripts by the entire source reference rather than target text', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const workspace: WorkspaceAddressV1 = { serverId: SERVER_ID, machineId: 'machine-a', workspaceId: 'workspace', rootPath: '/repo' };
        const source: ProjectCommandSourceV1 = { kind: 'native', tool: 'package_script', file: 'package.json', target: 'build' };
        const attachment: ProjectCommandAttachmentV1 = { kind: 'projectCommand', purpose: 'script',
            serverId: SERVER_ID, machineId: 'machine-a', workspaceRefId: 'workspace', cwd: '/repo', sourceWorkspace: workspace, script: { source } };
        const script = operation({ actionId: 'projects.script.run', operationId: 'native', domainRef: attachment });
        merge(store, [script, { ...script, operationId: 'different-file', createdAt: 999, domainRef: { ...attachment, script: { source: { ...source, file: 'nested/package.json' } } } },
            { ...script, operationId: 'named', createdAt: 999, domainRef: { ...attachment, script: { name: 'build', source } } }]);
        expect(store.getSnapshot().operationsByKey.size).toBe(3);
        expect(selectors.selectForProjectScript(store.getSnapshot(), { accountId: 'account-a', workspace, selection: { kind: 'native', source } })?.snapshot.operationId).toBe('native');
        const pluginSource = { kind: 'pluginNative' as const, adapter: { pluginId: 'dev.example.scripts', localId: 'runner' }, file: 'tasks.json', target: 'build' };
        merge(store, [{ ...script, operationId: 'plugin-native', domainRef: { ...attachment, script: { source: pluginSource } } },
            { ...script, operationId: 'other-adapter', createdAt: 999, domainRef: { ...attachment, script: { source: { ...pluginSource, adapter: { ...pluginSource.adapter, pluginId: 'dev.other.scripts' } } } } }]);
        expect(selectors.selectForProjectScript(store.getSnapshot(), { accountId: 'account-a', workspace, selection: { kind: 'native', source: pluginSource } })?.snapshot.operationId).toBe('plugin-native');
    });

    it('selects Session operations for the authenticated Account without sharing the selector cache', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation(), operation({ operationId: 'other-account', scope: {
            accountId: 'account-b', machineId: 'machine-a', sessionId: 'session-a',
        } })]);
        const address = { ...sessionAddress('session-a'), accountId: 'account-a' };
        const selected = selectors.selectForSession(store.getSnapshot(), address);
        expect(selected.map((item) => item.snapshot.operationId)).toEqual(['operation-a']);
        expect(selectors.selectForSession(store.getSnapshot(), { ...address, accountId: 'account-b' }).map((item) => item.snapshot.operationId))
            .toEqual(['other-account']);
        expect(selectors.selectForSession(store.getSnapshot(), address)).toBe(selected);
        expect(selectors.selectForSession(store.getSnapshot(), { ...address, accountId: null })).toEqual([]);
    });
    it('keeps identical operation, machine, session, and request IDs isolated by exact Home', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const shared = operation({
            operationId: 'shared-operation',
            requestId: 'shared-request',
            revision: 2,
            state: 'succeeded',
            settledAt: 120,
            scope: { accountId: 'account-a', machineId: 'shared-machine', sessionId: 'shared-session' },
        });

        store.mergeSnapshots({ serverId: 'home-a', snapshots: [shared] });
        store.mergeSnapshots({
            serverId: 'home-b',
            snapshots: [{ ...shared, title: 'Home B operation' }],
        });

        const state = store.getSnapshot();
        expect(state.operationsByKey.size).toBe(2);
        expect(selectors.selectById(state, { serverId: 'home-a', operationId: shared.operationId })?.serverId)
            .toBe('home-a');
        expect(selectors.selectById(state, { serverId: 'home-b', operationId: shared.operationId })?.snapshot.title)
            .toBe('Home B operation');
        expect(selectors.selectForSession(state, { serverId: 'home-a', sessionId: 'shared-session' })).toHaveLength(1);
        expect(selectors.selectForSession(state, { serverId: 'home-b', sessionId: 'shared-session' })).toHaveLength(1);
        expect(selectors.selectSnapshotByRequestId(state, 'shared-request', 'home-a', 'account-a')?.title)
            .toBe('Create session');
        expect(selectors.selectSnapshotByRequestId(state, 'shared-request', 'home-b', 'account-a')?.title)
            .toBe('Home B operation');

        store.setMachineObservation({ serverId: 'home-a', machineId: 'shared-machine' }, 'unavailable');
        expect(selectors.selectById(store.getSnapshot(), {
            serverId: 'home-a',
            operationId: shared.operationId,
        })?.observation).toBe('unavailable');
        expect(selectors.selectById(store.getSnapshot(), {
            serverId: 'home-b',
            operationId: shared.operationId,
        })?.observation).toBe('available');

        store.markFollowUpNeedsAttention({
            serverId: 'home-a',
            accountId: 'account-a',
            requestId: 'shared-request',
            message: 'Home A follow-up',
        });
        expect(selectors.selectById(store.getSnapshot(), { serverId: 'home-a', operationId: shared.operationId })?.followUpAttention)
            .toBe('Home A follow-up');
        expect(selectors.selectById(store.getSnapshot(), { serverId: 'home-b', operationId: shared.operationId })?.followUpAttention)
            .toBeNull();

        expect(store.markTerminalSeen({ serverId: 'home-a', operationId: shared.operationId }, 200)).toBe(true);
        expect(store.getSnapshot().seenAtByOperationKey.has(actionOperationAddressKey({
            serverId: 'home-a',
            operationId: shared.operationId,
        }))).toBe(true);
        expect(store.getSnapshot().seenAtByOperationKey.has(actionOperationAddressKey({
            serverId: 'home-b',
            operationId: shared.operationId,
        }))).toBe(false);
        expect(state.operationsByKey.has(actionOperationAddressKey({ serverId: 'home-a', operationId: shared.operationId })))
            .toBe(true);
    });

    it('rejects an unqualified legacy operation instead of exposing or relabeling it', () => {
        const store = createActionOperationStore();
        const shared = operation({ operationId: 'shared-operation' });

        store.mergeSnapshots({ serverId: null, snapshots: [shared] });
        store.mergeSnapshots({ serverId: 'home-a', snapshots: [{ ...shared, revision: 2, state: 'running', startedAt: 110 }] });

        const selectors = createActionOperationSelectors();
        expect(store.getSnapshot().operationsByKey.size).toBe(1);
        expect(selectors.selectById(
            store.getSnapshot(),
            { serverId: null, operationId: shared.operationId },
        )).toBeNull();
        expect(selectors.selectAll(store.getSnapshot()).map((operation) => operation.serverId))
            .toEqual(['home-a']);
    });

    it('rejects blank Home ingress instead of treating it as the legacy null Home', () => {
        const store = createActionOperationStore();

        store.mergeSnapshots({ serverId: '   ', snapshots: [operation()] });

        expect(store.getSnapshot().operationsByKey.size).toBe(0);
    });

    it('marks only the requested terminal operation seen', () => {
        const store = createActionOperationStore();
        const first = operation({ operationId: 'operation-1', revision: 3, state: 'succeeded', settledAt: 130, result: { sessionId: 'session-1' } });
        const second = operation({ operationId: 'operation-2', revision: 4, state: 'failed', settledAt: 140, error: { errorCode: 'failed', error: 'Failed' } });
        merge(store, [first, second]);

        expect(store.markTerminalSeen(operationAddress(first.operationId), 200)).toBe(true);
        expect(store.getSnapshot().seenAtByOperationKey.get(actionOperationAddressKey(operationAddress(first.operationId)))).toEqual({ seenAt: 200, revision: 3 });
        expect(store.getSnapshot().seenAtByOperationKey.has(actionOperationAddressKey(operationAddress(second.operationId)))).toBe(false);
        expect(store.markTerminalSeen(operationAddress(first.operationId), 300)).toBe(false);
    });

    it('keeps one row per operation ID across global and session selectors', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const accepted = operation();

        merge(store, [accepted, accepted]);

        const state = store.getSnapshot();
        expect(selectors.selectAll(state).map((row) => row.snapshot.operationId)).toEqual(['operation-a']);
        expect(selectors.selectForSession(state, sessionAddress('session-a')).map((row) => row.snapshot.operationId)).toEqual(['operation-a']);
        expect(selectors.selectForSession(state, sessionAddress('session-b'))).toEqual([]);
    });

    it('keeps lifecycle monotonic and terminal snapshots immutable', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation()]);
        merge(store, [operation({ revision: 2, state: 'running', startedAt: 110 })]);
        merge(store, [operation({ revision: 3, state: 'succeeded', startedAt: 110, settledAt: 150, result: { sessionId: 'child' } })]);

        const terminal = selectors.selectAll(store.getSnapshot())[0]!.snapshot;

        merge(store, [operation({ revision: 4, state: 'running', startedAt: 110 })]);
        merge(store, [operation({ revision: 5, state: 'failed', startedAt: 110, settledAt: 160 })]);

        expect(selectors.selectAll(store.getSnapshot())[0]!.snapshot).toBe(terminal);
        expect(selectors.selectActive(store.getSnapshot())).toEqual([]);
    });

    it('projects unavailable observation without overwriting the canonical snapshot', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation({ revision: 2, state: 'running', startedAt: 110 })]);
        const canonical = selectors.selectAll(store.getSnapshot())[0]!.snapshot;

        store.setMachineObservation({ serverId: SERVER_ID, machineId: 'machine-a' }, 'unavailable');

        const projected = selectors.selectAll(store.getSnapshot())[0]!;
        expect(projected.observation).toBe('unavailable');
        expect(projected.snapshot).toBe(canonical);
        expect(projected.snapshot.state).toBe('running');
    });

    it('dismisses only an unavailable nonterminal projection while retaining daemon truth', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const canonical = operation({ revision: 2, state: 'running', startedAt: 110 });
        merge(store, [canonical]);

        expect(store.dismissUnavailable(operationAddress('operation-a'))).toBe(false);
        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [],
            knownOperationKeys: new Set([actionOperationAddressKey(operationAddress('operation-a'))]),
        });
        expect(store.dismissUnavailable(operationAddress('operation-a'))).toBe(true);

        expect(selectors.selectAll(store.getSnapshot())).toEqual([]);
        expect(store.getSnapshot().operationsByKey.get(actionOperationAddressKey(operationAddress('operation-a')))?.snapshot).toBe(canonical);
        expect(store.getSnapshot().unavailableOperationKeys.has(actionOperationAddressKey(operationAddress('operation-a')))).toBe(true);
        expect(store.dismissUnavailable(operationAddress('operation-a'))).toBe(false);

        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [canonical],
            knownOperationKeys: new Set([actionOperationAddressKey(operationAddress('operation-a'))]),
        });
        expect(selectors.selectAll(store.getSnapshot()).map((row) => row.snapshot.operationId))
            .toEqual(['operation-a']);
    });

    it('restores availability when a newer canonical snapshot arrives', () => {
        const store = createActionOperationStore();
        merge(store, [operation()]);
        store.setMachineObservation({ serverId: SERVER_ID, machineId: 'machine-a' }, 'unavailable');

        merge(store, [operation({ revision: 2, state: 'running', startedAt: 110 })]);

        expect(store.getSnapshot().machineObservationByKey.get(actionOperationMachineAddressKey({ serverId: SERVER_ID, machineId: 'machine-a' }))).toBe('available');
    });

    it('keeps selector references stable while their structural inputs are unchanged', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation()]);
        const before = store.getSnapshot();
        const allBefore = selectors.selectAll(before);
        const sessionBefore = selectors.selectForSession(before, sessionAddress('session-a'));

        merge(store, [operation()]);

        const after = store.getSnapshot();
        expect(after).toBe(before);
        expect(selectors.selectAll(after)).toBe(allBefore);
        expect(selectors.selectForSession(after, sessionAddress('session-a'))).toBe(sessionBefore);
    });

    it('keeps unchanged row and scoped-list references stable across unrelated store updates', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation()]);
        const rowBefore = selectors.selectAll(store.getSnapshot())[0];
        const sessionBefore = selectors.selectForSession(store.getSnapshot(), sessionAddress('session-a'));

        merge(store, [operation({
            operationId: 'operation-b',
            scope: {
                accountId: 'account-a',
                machineId: 'machine-b',
                sessionId: 'session-b',
            },
        })]);

        const allAfterMerge = selectors.selectAll(store.getSnapshot());
        expect(allAfterMerge.find((row) => row.snapshot.operationId === 'operation-a')).toBe(rowBefore);
        expect(selectors.selectForSession(store.getSnapshot(), sessionAddress('session-a'))).toBe(sessionBefore);

        store.markAllTerminalSeen(200);
        expect(selectors.selectAll(store.getSnapshot())).toBe(allAfterMerge);
    });

    it('marks current terminal rows seen but treats later settlement as unseen', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation({ revision: 2, state: 'succeeded', settledAt: 150 })]);

        expect(selectors.selectHasUnseenTerminal(store.getSnapshot())).toBe(true);
        store.markAllTerminalSeen(200);
        expect(selectors.selectHasUnseenTerminal(store.getSnapshot())).toBe(false);

        merge(store, [
            operation({ operationId: 'operation-b', revision: 1, state: 'running', createdAt: 210 }),
        ]);
        store.markAllTerminalSeen(220);
        merge(store, [
            operation({ operationId: 'operation-b', revision: 2, state: 'failed', createdAt: 210, settledAt: 230 }),
        ]);

        expect(selectors.selectHasUnseenTerminal(store.getSnapshot())).toBe(true);
        expect(selectors.selectHasAttention(store.getSnapshot())).toBe(true);
    });

    it('reconciles a complete daemon machine projection by retaining absent active rows as unavailable and pruning terminal rows', () => {
        const store = createActionOperationStore();
        const active = operation({ operationId: 'operation-active' });
        const terminal = operation({
            operationId: 'operation-terminal',
            revision: 2,
            state: 'succeeded',
            settledAt: 150,
        });
        merge(store, [active, terminal]);

        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [],
            knownOperationKeys: new Set([active.operationId, terminal.operationId].map((operationId) => (
                actionOperationAddressKey(operationAddress(operationId))
            ))),
        });

        expect([...store.getSnapshot().operationsByKey.values()].map((operation) => operation.snapshot.operationId)).toEqual([active.operationId]);
        expect(store.getSnapshot().machineObservationByKey.get(actionOperationMachineAddressKey({ serverId: SERVER_ID, machineId: 'machine-a' }))).toBe('available');
        expect(createActionOperationSelectors().selectById(store.getSnapshot(), operationAddress(active.operationId))?.observation)
            .toBe('unavailable');
    });

    it('marks only an omitted active row unavailable when another active row is listed on the same machine', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const listed = operation({ operationId: 'operation-listed', state: 'running', revision: 2, startedAt: 110 });
        const omitted = operation({ operationId: 'operation-omitted', state: 'running', revision: 2, startedAt: 110 });
        merge(store, [listed, omitted]);

        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [listed],
            knownOperationKeys: new Set([listed.operationId, omitted.operationId].map((operationId) => (
                actionOperationAddressKey(operationAddress(operationId))
            ))),
        });

        expect(selectors.selectById(store.getSnapshot(), operationAddress(listed.operationId))?.observation).toBe('available');
        expect(selectors.selectById(store.getSnapshot(), operationAddress(omitted.operationId))?.observation).toBe('unavailable');
        expect(store.dismissUnavailable(operationAddress(listed.operationId))).toBe(false);
        expect(store.dismissUnavailable(operationAddress(omitted.operationId))).toBe(true);
    });

    it('does not prune a concurrently accepted row that was not present when listing began', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const cached = operation({ operationId: 'operation-cached' });
        merge(store, [cached]);
        const knownOperationKeys = new Set(store.getSnapshot().operationsByKey.keys());
        const concurrent = operation({ operationId: 'operation-concurrent', state: 'failed', settledAt: 200 });
        merge(store, [concurrent]);
        store.markTerminalSeen(operationAddress(concurrent.operationId), 250);

        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [],
            knownOperationKeys,
        });

        expect([...store.getSnapshot().operationsByKey.values()].map((operation) => operation.snapshot.operationId)).toEqual([
            cached.operationId,
            concurrent.operationId,
        ]);
        expect(selectors.selectById(store.getSnapshot(), operationAddress(cached.operationId))?.observation).toBe('unavailable');
        expect(selectors.selectById(store.getSnapshot(), operationAddress(concurrent.operationId))?.observation).toBe('available');
        expect(selectors.selectHasUnseenTerminal(store.getSnapshot())).toBe(false);
        const replay = createActionOperationStore();
        merge(replay, [concurrent]);
        expect(selectors.selectHasUnseenTerminal(replay.getSnapshot())).toBe(false);
    });

    it('removes operation rows when their machine leaves the active account projection', () => {
        const store = createActionOperationStore();
        merge(store, [
            operation({ operationId: 'removed-machine' }),
            operation({
                operationId: 'retained-machine',
                scope: { accountId: 'account-a', machineId: 'machine-b' },
            }),
        ]);

        store.retainAccountMachines({ serverId: SERVER_ID, accountId: 'account-a', machineIds: new Set(['machine-b']) });

        expect([...store.getSnapshot().operationsByKey.values()].map((operation) => operation.snapshot.operationId)).toEqual(['retained-machine']);
        expect(store.getSnapshot().machineObservationByKey.has(actionOperationMachineAddressKey({ serverId: SERVER_ID, machineId: 'machine-a' }))).toBe(false);
    });

    it('dismisses only successful recent rows while retaining active and attention rows', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [
            operation({ operationId: 'active' }),
            operation({ operationId: 'success', revision: 2, state: 'succeeded', startedAt: 110, settledAt: 150 }),
            operation({ operationId: 'failed', revision: 2, state: 'failed', startedAt: 110, settledAt: 150, error: { errorCode: 'failed', error: 'Failed' } }),
        ]);

        expect(store.dismissRecentSucceeded()).toBe(true);

        expect(selectors.selectAll(store.getSnapshot()).map((row) => row.snapshot.operationId))
            .toEqual(['active', 'failed']);
        expect(store.getSnapshot().operationsByKey.has(actionOperationAddressKey(operationAddress('success')))).toBe(true);
        expect(store.dismissRecentSucceeded()).toBe(false);
    });

    it('overlays UI follow-up attention on daemon success without changing its canonical lifecycle', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation({
            revision: 2,
            requestId: 'spawn-request',
            state: 'succeeded',
            startedAt: 110,
            settledAt: 150,
            result: { sessionId: 'created-session' },
        })]);

        store.markFollowUpNeedsAttention({
            serverId: SERVER_ID,
            accountId: 'account-a',
            requestId: 'spawn-request',
            message: 'Session created; setup needs attention',
        });

        const projected = selectors.selectAll(store.getSnapshot())[0]!;
        expect(projected.snapshot.state).toBe('succeeded');
        expect(projected.followUpAttention).toBe('Session created; setup needs attention');
        expect(selectors.selectHasAttention(store.getSnapshot())).toBe(true);
    });

    it('projects only response-required operations into Inbox and resolves them through existing lifecycle owners', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [
            operation({ operationId: 'routine-active', requestId: 'routine-request' }),
            operation({
                operationId: 'failed',
                revision: 2,
                state: 'failed',
                settledAt: 150,
                error: { errorCode: 'failed', error: 'Failed' },
            }),
            operation({
                operationId: 'setup',
                requestId: 'setup-request',
                revision: 2,
                state: 'succeeded',
                settledAt: 150,
                result: { sessionId: 'created-session' },
            }),
            operation({ operationId: 'cancelled', revision: 2, state: 'cancelled', settledAt: 150 }),
            operation({ operationId: 'unavailable', revision: 2, state: 'running', startedAt: 110 }),
        ]);
        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [
                operation({ operationId: 'routine-active' }),
                operation({
                    operationId: 'failed',
                    revision: 2,
                    state: 'failed',
                    settledAt: 150,
                    error: { errorCode: 'failed', error: 'Failed' },
                }),
                operation({
                    operationId: 'setup',
                    requestId: 'setup-request',
                    revision: 2,
                    state: 'succeeded',
                    settledAt: 150,
                    result: { sessionId: 'created-session' },
                }),
                operation({ operationId: 'cancelled', revision: 2, state: 'cancelled', settledAt: 150 }),
            ],
            knownOperationKeys: new Set(store.getSnapshot().operationsByKey.keys()),
        });

        expect(selectors.selectAll(store.getSnapshot()).map((entry) => entry.snapshot.operationId))
            .toEqual(expect.arrayContaining(['routine-active', 'failed', 'setup', 'cancelled', 'unavailable']));
        expect(selectors.selectInbox(store.getSnapshot()).map(({ operation: entry, reason }) => [entry.snapshot.operationId, reason]))
            .toEqual(expect.arrayContaining([
                ['failed', 'failed'],
                ['unavailable', 'status_unavailable'],
            ]));
        expect(selectors.selectInbox(store.getSnapshot()).map(({ operation: entry }) => entry.snapshot.operationId))
            .not.toEqual(expect.arrayContaining(['routine-active', 'setup', 'cancelled']));

        store.markFollowUpNeedsAttention({
            serverId: SERVER_ID,
            accountId: 'account-a',
            requestId: 'routine-request',
            message: 'An early follow-up must wait for terminal success',
        });
        expect(selectors.selectInbox(store.getSnapshot()).map(({ operation: entry }) => entry.snapshot.operationId))
            .not.toContain('routine-active');

        expect(store.dismissRecentSucceeded()).toBe(true);
        store.markTerminalSeen(operationAddress('setup'), 175);
        const seenBeforeLateFollowUp = store.getSnapshot().seenAtByOperationKey;
        store.markFollowUpNeedsAttention({
            serverId: SERVER_ID,
            accountId: 'account-a',
            requestId: 'setup-request',
            message: 'Session created; setup needs attention',
        });
        expect(selectors.selectInbox(store.getSnapshot()).map(({ operation: entry, reason }) => [entry.snapshot.operationId, reason]))
            .toContainEqual(['setup', 'setup_needs_attention']);
        expect(store.getSnapshot().seenAtByOperationKey).toBe(seenBeforeLateFollowUp);

        expect(store.markTerminalSeen(operationAddress('failed'), 200)).toBe(true);
        expect(store.dismissUnavailable(operationAddress('unavailable'))).toBe(true);
        // Already-seen terminal acknowledgement still clears a later follow-up.
        expect(store.markTerminalSeen(operationAddress('setup'), 200)).toBe(true);
        expect(selectors.selectInbox(store.getSnapshot())).toEqual([]);
    });

    it('projects closed Activity and Inbox state without requiring detail row collections', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [
            operation({ operationId: 'available-active', state: 'running', startedAt: 110 }),
            operation({ operationId: 'unavailable-active', state: 'running', startedAt: 110 }),
            operation({
                operationId: 'failed',
                revision: 2,
                state: 'failed',
                settledAt: 150,
                error: { errorCode: 'failed', error: 'Failed' },
            }),
        ]);
        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [
                operation({ operationId: 'available-active', state: 'running', startedAt: 110 }),
                operation({
                    operationId: 'failed',
                    revision: 2,
                    state: 'failed',
                    settledAt: 150,
                    error: { errorCode: 'failed', error: 'Failed' },
                }),
            ],
            knownOperationKeys: new Set(store.getSnapshot().operationsByKey.keys()),
        });

        expect(selectors.selectActivitySummary(store.getSnapshot())).toEqual({
            activeCount: 1,
            hasAttention: true,
        });
        expect(selectors.selectInboxSummary(store.getSnapshot())).toEqual({
            count: 2,
            hasAttention: true,
        });

        store.markTerminalSeen(operationAddress('failed'), 200);
        store.dismissUnavailable(operationAddress('unavailable-active'));
        expect(selectors.selectInboxSummary(store.getSnapshot())).toEqual({
            count: 0,
            hasAttention: false,
        });
    });
    it('accepts a newer settled receipt refinement without reviving the lifecycle', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const cancelled = operation({ actionId: 'sessions.external.materialize.start', state: 'cancelled', startedAt: 100, settledAt: 150,
            revision: 4, progress: { kind: 'phase', phase: 'staging', label: 'Cancelled' } });
        merge(store, [cancelled]);
        merge(store, [{ ...cancelled, revision: 5, settledAt: 160, progress: { kind: 'phase', phase: 'staging', label: 'Discarded' } }]);
        expect(selectors.selectAll(store.getSnapshot())[0]!.snapshot.progress?.label).toBe('Discarded');
        merge(store, [{ ...cancelled, revision: 6, state: 'running', settledAt: undefined }]);
        expect(selectors.selectAll(store.getSnapshot())[0]!.snapshot.state).toBe('cancelled');
    });

});
