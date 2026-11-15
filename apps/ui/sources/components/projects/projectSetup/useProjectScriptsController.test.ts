import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance as waitForRequests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ActionOperationActionInputSchemasV1 } from '@happier-dev/protocol/actions/specs/actionOperations';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { ManagedMachineV1, ManagedMachinePublicFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createDeferred } from '@/dev/testkit';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createDelegatedManagedPresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Authenticated remote daemon RPC is a genuine system boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc.machine }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
// Cold loading of the real Sync graph belongs to collection, not the behavior test's budget.
await loadSyncSingletonForTests();

function waitForHomeGovernance(assertion: () => void) {
    return waitForRequests(async () => { await flushHookEffects(); assertion(); });
}

function operation(serverId: string): ActionOperationProjection {
    return { serverId, observation: 'available', isUnavailableProjection: false,
        snapshot: { version: 1, operationId: 'operation-1', revision: 1, actionId: 'projects.prepare',
            state: 'running', scope: { accountId: 'alice', machineId: 'machine-1' },
            title: 'Setup', createdAt: 1, startedAt: 2, cancellation: 'supported' } };
}

describe('Project Scripts Setup controls', () => {
    beforeEach(async () => { await harness.reset(); actionOperationStore.reset(); rpc.machine.mockReset(); });
    afterEach(() => standardCleanup());

    it('discards picker intent for another checkout, Account, or a removed portable Script', async () => {
        const { useProjectScriptsController } = await import('./useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const home = await harness.addHome({ name: 'Picker scope', serverUrl: 'https://picker-scope.test', serverIdentityId: 'srv_picker_scope', accountId: 'alice' });
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        const workspace = { serverId, workspaceId: 'checkout', machineId: 'source', rootPath: '/repo' };
        const homes = [serverId];
        const selected = { kind: 'existing', choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker' } } } as const;
        const hook = await renderHook((props: { workspace: typeof workspace; runChoiceKeys: readonly string[] }) =>
            useProjectScriptsController(props.workspace, () => {}, useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null,
                { runChoiceKeys: props.runChoiceKeys }), { initialProps: { workspace, runChoiceKeys: ['build'] } });
        const choose = async () => { await act(async () => { hook.getCurrent().chooseRunDestination('build', selected); }); };
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            await choose();
            expect(hook.getCurrent().runChoices.build).toEqual(selected);
            await hook.rerender({ workspace, runChoiceKeys: [] });
            expect(hook.getCurrent().runChoices).toEqual({});
            await hook.rerender({ workspace, runChoiceKeys: ['build'] });
            expect(hook.getCurrent().runChoices).toEqual({});
            const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Worker', choices: {} };
            const controller = { machineId: 'controller', installationId: 'installation' };
            const retention = { kind: 'until-delete' } as const;
            const draft = createManagedMachineSelectionDraft({
                selection: { kind: 'one-off', homeId: serverId, launch, controller, retention, wakeOnAcceptedMessage: false },
                receipt: { launch, controller, retention, wakeOnAcceptedMessage: false, optionStatus: 'current', prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] } },
            });
            await act(async () => { hook.getCurrent().chooseRunDestination('build', { kind: 'managed', draft }); });
            // A same-Account credential recheck retires the binding; a label change no longer does.
            await act(async () => { await harness.switchAccount(home, 'alice'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            expect(hook.getCurrent().runChoices).toEqual({});
            expect(hook.getCurrent().managedCreations).toEqual({});
            await choose();
            await hook.rerender({ workspace: { ...workspace, machineId: 'another-source' }, runChoiceKeys: ['build'] });
            expect(hook.getCurrent().runChoices).toEqual({});
            await hook.rerender({ workspace, runChoiceKeys: ['build'] });
            expect(hook.getCurrent().runChoices).toEqual({});
            await choose();
            await act(async () => { await harness.switchAccount(home, 'bob'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().accountId).toBe('bob'));
            expect(hook.getCurrent().runChoices).toEqual({});
            await act(async () => { await harness.switchAccount(home, 'alice'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().accountId).toBe('alice'));
            expect(hook.getCurrent().runChoices).toEqual({});
        } finally { await hook.unmount(); }
    });

    it('decides a worker-held Script on that original target, retaining the Script operation instead of SOURCE preparation', async () => {
        const { useProjectScriptsController } = await import('./useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const home = await harness.addHome({ name: 'Setup Worker', serverUrl: 'https://setup-worker.test', accountId: 'alice' });
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        const workspace = { serverId, workspaceId: 'source', machineId: 'source-machine', rootPath: '/repo' };
        const held = { ...operation(serverId).snapshot, actionId: 'projects.script.run', state: 'accepted' as const,
            scope: { accountId: 'alice', machineId: 'worker' }, startedAt: undefined,
            domainRef: { kind: 'projectCommand' as const, purpose: 'script' as const, serverId, machineId: 'worker',
                workspaceRefId: 'worker-copy', cwd: '/copy', sourceWorkspace: workspace },
            setupReview: { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const,
                reviewedEffectDigest: 'reviewed', reviewedEffect: { commands: ['echo setup'] } },
        };
        const requests: unknown[] = [];
        const execute = createFrontDoorActionExecute(createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: () => false,
            projectAction: async ({ actionId: id, input }) => {
                requests.push({ id, input });
                return { operation: requests.length === 1 ? held : { ...held, revision: 2, setupReview: undefined } };
            },
        }), 'alice'));
        const homes = [serverId];
        const hook = await renderHook(() => useProjectScriptsController(workspace, () => {},
            useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null, { execute }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            await act(async () => { await hook.getCurrent().run('checked', { kind: 'named', name: 'checked' }); });
            expect(hook.getCurrent().retainedOperation?.snapshot.setupReview).toBeDefined();
            await act(async () => { await hook.getCurrent().prepare('reviewed', 'thisTime'); });
            expect(requests[1]).toEqual({ id: 'projects.prepare', input: {
                workspace: { serverId, workspaceId: 'worker-copy', machineId: 'worker', rootPath: '/copy' },
                phase: 'setup', expectedEffectDigest: 'reviewed', consentScope: 'thisTime', heldOperationId: 'operation-1',
            } });
            expect(hook.getCurrent().retainedOperation?.snapshot.operationId).toBe('operation-1');
        } finally { await hook.unmount(); }
    });

    it('finds a review a Script run is holding that this surface did not start', async () => {
        const { useProjectScriptsController } = await import('./useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const home = await harness.addHome({ name: 'Held elsewhere', serverUrl: 'https://held-elsewhere.test', accountId: 'alice' });
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        const workspace = { serverId, workspaceId: 'source', machineId: 'source-machine', rootPath: '/repo' };
        const otherCheckout = { ...workspace, workspaceId: 'elsewhere', rootPath: '/other' };
        const held = { ...operation(serverId).snapshot, actionId: 'projects.script.run', state: 'accepted' as const,
            scope: { accountId: 'alice', machineId: 'source-machine' }, startedAt: undefined,
            domainRef: { kind: 'projectCommand' as const, purpose: 'script' as const, serverId, machineId: 'source-machine',
                workspaceRefId: 'source', cwd: '/repo', sourceWorkspace: workspace, script: { name: 'verify', source: { kind: 'command' as const, command: 'echo ok' } } },
            setupReview: { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const,
                reviewedEffectDigest: 'reviewed', reviewedEffect: { commands: ['echo setup'] } },
        };
        const homes = [serverId];
        const hook = await renderHook((props: { workspace: typeof workspace }) => useProjectScriptsController(props.workspace, () => {},
            useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null), { initialProps: { workspace } });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            expect(hook.getCurrent().consent).toBeNull();
            await act(async () => { actionOperationStore.mergeSnapshots({ serverId, snapshots: [held] }); });
            // The review is the checkout's own, so a reload or another client's Run still surfaces it.
            await waitForHomeGovernance(() => expect(hook.getCurrent().consent?.reviewedEffectDigest).toBe('reviewed'));
            expect(hook.getCurrent().consent?.operation?.snapshot.operationId).toBe('operation-1');
            expect(hook.getCurrent().setupReviewOpen).toBe(true);
            await hook.rerender({ workspace: otherCheckout });
            expect(hook.getCurrent().consent).toBeNull();
        } finally { await hook.unmount(); }
    });

    it('admits independent Scripts while another Run awaits its Action result', async () => {
        const firstGate = createDeferred<void>();
        const { useProjectScriptsController } = await import('./useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const home = await harness.addHome({ name: 'Parallel Home', serverUrl: 'https://parallel-script.test', accountId: 'alice' });
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        const workspace = { serverId, workspaceId: 'checkout', machineId: 'source', rootPath: '/repo' };
        const admissions: string[] = [];
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'projects.script.run': ['ui'] } });
        const execute = createFrontDoorActionExecute(createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context, getActionSpec(id).safety),
            projectAction: async request => {
                const input = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse(request.input);
                const name = input.selection.kind === 'named' ? input.selection.name : '';
                admissions.push(name);
                if (name === 'first') await firstGate.promise;
                return { operation: { version: 1, operationId: `finite-${name}`, revision: 1, actionId: 'projects.script.run', state: 'accepted',
                    scope: { accountId: 'alice', machineId: 'source' }, title: name, createdAt: 2, cancellation: 'supported' } };
            },
        }), 'alice', settings));
        const homes = [serverId];
        const changed = () => {};
        const hook = await renderHook(() => useProjectScriptsController(workspace, changed,
            useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null, { execute }));
        let first: Promise<void> | undefined;
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            act(() => { first = hook.getCurrent().run('first', { kind: 'named', name: 'first' }); });
            await waitForHomeGovernance(() => expect(admissions).toEqual(['first']));
            await act(async () => { await hook.getCurrent().run('second', { kind: 'named', name: 'second' }); });
            expect(admissions).toEqual(['first', 'second']);
            // Completing B cannot clear A's row-local pending state.
            expect(hook.getCurrent().pendingKeys.first).toBe(true);
            expect(hook.getCurrent().pendingKeys.second).toBeUndefined();
        } finally {
            firstGate.resolve();
            await act(async () => { await first; });
            await hook.unmount();
        }
    });

    it('retains both acquired resources and cancels only the selected Script continuation', async () => {
        const { useProjectScriptsController } = await import('./useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const home = await harness.addHome({ name: 'Two Workers', serverUrl: 'https://two-workers.test', serverIdentityId: 'srv_two_workers', accountId: 'alice' });
        const homeId = getServerProfileById(home)!.serverIdentityId!;
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        const workspace = { serverId, workspaceId: 'checkout', machineId: 'source', rootPath: '/repo' };
        const controller = { machineId: 'controller', installationId: 'installation' };
        const retention = { kind: 'until-delete' } as const;
        const launch = (name: string) => ({ provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name, choices: {} });
        const draft = (name: string) => createManagedMachineSelectionDraft({
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
            selection: { kind: 'one-off', homeId, launch: launch(name), controller, retention, wakeOnAcceptedMessage: false },
            receipt: { launch: launch(name), controller, optionStatus: 'current', prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention, wakeOnAcceptedMessage: false },
        });
        let machines: ManagedMachineV1[] = ['first', 'second'].map(id => ({ id, homeId, custodianAccountId: 'alice', launch: launch(id), controller,
            allocation: 'bound', resource: { contributionRef: launch(id).provider, schemaVersion: 1, value: { id } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1, retention, wakeOnAcceptedMessage: false }));
        const purchases: string[] = [];
        const admissions: unknown[] = [];
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.managed.acquire': ['ui'], 'projects.script.run': ['ui'] } });
        const execute = createFrontDoorActionExecute(createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context, getActionSpec(id).safety),
            managedMachineAction: async request => {
                if (request.actionId === 'machines.managed.list') return { machines };
                if (request.actionId === 'machines.managed.get') {
                    const input = ManagedMachineActionInputSchemasV1['machines.managed.get'].parse(request.input);
                    return machines.find(machine => machine.id === input.managedId);
                }
                if (request.actionId === 'machines.managed.acquire') {
                    const input = ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse(request.input);
                    const id = input.selection.kind === 'one-off' ? input.selection.launch.name : '';
                    purchases.push(id);
                    return { managedId: id, operation: { operationId: `install-${id}` } };
                }
                throw new Error('unexpected_managed_transport');
            },
            actionOperationAction: async request => ({ kind: 'found', operation: {
                version: 1, operationId: ActionOperationActionInputSchemasV1['action.operations.get'].parse(request.input).operationId, revision: 2, actionId: 'machines.managed.acquire', state: 'succeeded',
                scope: { accountId: 'alice', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
            } }),
            projectAction: async request => {
                admissions.push(request.input);
                const input = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse(request.input);
                const name = input.selection.kind === 'named' ? input.selection.name : '';
                return { operation: { version: 1, operationId: `finite-${name}`, revision: 1, actionId: 'projects.script.run', state: 'accepted',
                    scope: { accountId: 'alice', machineId: `guest-${name}` }, title: name, createdAt: 2, cancellation: 'supported' } };
            },
        }), 'alice', settings));
        const homes = [serverId];
        const changed = () => {};
        const hook = await renderHook(() => useProjectScriptsController(workspace, changed,
            useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null, { execute }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            await act(async () => { await hook.getCurrent().run('first', { kind: 'named', name: 'first' }, undefined, draft('first')); });
            await act(async () => { await hook.getCurrent().run('second', { kind: 'named', name: 'second' }, undefined, draft('second')); });
            expect(purchases).toEqual(['first', 'second']);
            expect(Object.keys(hook.getCurrent().managedCreations)).toEqual(['first', 'second']);
            act(() => hook.getCurrent().cancelRun('first'));
            machines = machines.map(machine => ({ ...machine, enrolledMachineId: `guest-${machine.id}` }));
            act(() => publishHomeAccountChange(serverId));
            await waitForHomeGovernance(() => expect(admissions).toHaveLength(1));
            expect(admissions[0]).toEqual({ workspace, selection: { kind: 'named', name: 'second' },
                choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'guest-second' } } });
            expect(hook.getCurrent().managedCreations.first?.progress).toMatchObject({ kind: 'failed', code: 'continuation_retired' });
            await act(async () => { await hook.getCurrent().resumeManagedRun('first'); });
            expect(purchases).toEqual(['first', 'second']);
            expect(admissions).toHaveLength(2);
            expect(admissions[1]).toEqual({ workspace, selection: { kind: 'named', name: 'first' },
                choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'guest-first' } } });
        } finally { await hook.unmount(); }
    });

    it.each(['one-off', 'preset', 'cancel', 'enrollment-pending', 'acquiring-pending', 'pending-cancel', 'pending-retire',
        'delegated-approve', 'delegated-decline', 'delegated-cancel', 'delegated-decline-failure', 'delegated-establish'] as const)('keeps %s creation sessionless and continues only the current finite Run after actual enrollment', async mode => {
        const delegated = mode.startsWith('delegated-');
        const kind = mode === 'preset' || delegated ? 'preset' : 'one-off';
        const enrollmentGate = createDeferred<void>();
        const { useProjectScriptsController } = await import('./useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const requesterToken = createAccountTokenForTests('alice');
        const home = await harness.addHome({ name: 'Finite Home', serverUrl: 'https://finite-create.test', serverIdentityId: 'srv_finite_home', accountId: 'alice', credentials: { token: requesterToken } });
        const homeId = getServerProfileById(home)!.serverIdentityId!;
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        const workspace = { serverId, workspaceId: 'checkout', machineId: 'source', rootPath: '/repo' };
        const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Worker', choices: {} };
        const controller = { machineId: 'controller', installationId: 'installation' };
        const retention = { kind: 'until-delete' } as const;
        const secret = 'correct-horse-battery-staple';
        const draft = createManagedMachineSelectionDraft({ enrollmentIdentity: mode === 'delegated-establish'
            ? { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'ask', administrator: { username: 'operator' } }
            : { kind: 'guestProcess', role: 'sandbox' }, selection: kind === 'preset'
            ? { kind: 'preset', homeId, id: 'preset', revision: 1 }
            : { kind: 'one-off', homeId, launch, controller, retention, wakeOnAcceptedMessage: false },
            receipt: { launch, controller, optionStatus: 'current', prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention, wakeOnAcceptedMessage: false } });
        let machine: ManagedMachinePublicFullV1 = { id: 'paid', homeId, custodianAccountId: delegated ? 'company' : 'alice',
            ...(delegated ? { enrollmentAccountId: 'alice' } : {}), launch, controller,
            allocation: 'bound', resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1, retention, wakeOnAcceptedMessage: false };
        const admissions: unknown[] = [];
        const acquisitions: unknown[] = [];
        let approved: boolean | undefined;
        let questionRead = false;
        const { Modal } = await import('@/modal');
        const confirmation = delegated ? vi.spyOn(Modal, 'confirm').mockImplementation(async () => {
            if (mode === 'delegated-cancel') await enrollmentGate.promise;
            return mode === 'delegated-approve' || mode === 'delegated-cancel';
        }) : null;
        const secretPrompt = mode === 'delegated-establish' ? vi.spyOn(Modal, 'prompt').mockResolvedValue(secret) : null;
        const preset = delegated ? createDelegatedManagedPresetFixture({ preset: {
            id: 'preset', homeId, revision: 1, name: 'Team worker', owner: { kind: 'team', teamId: 'team' },
            launch, controller, retention, wakeOnAcceptedMessage: false,
        }, custodianAccountId: 'company', installationPublicKey: 'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY', descriptor: {
            id: 'native', title: 'Compute', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: draft.receipt.billing, retention: draft.receipt.retentionCapabilities,
            actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
        } }) : { id: 'preset', homeId, revision: 1, name: 'Worker', owner: { kind: 'account' as const, accountId: 'alice' }, launch, controller };
        const { installManagedInstallationResponseBoundary } = await import('@/dev/testkit/harness/managedInstallationResponseBoundary');
        const installation = delegated ? installManagedInstallationResponseBoundary({ homes: harness, serverId,
            serverUrl: 'https://finite-create.test', homeId, token: requesterToken, enrollmentAccountId: 'alice', readMachine: () => machine,
            ...(mode === 'delegated-decline-failure' ? { refuseAnswer: 'no_prompt' } : {}),
            onAnswer: response => {
                const answer = response.answer;
                approved = typeof answer === 'object' && answer !== null && 'approved' in answer && typeof answer.approved === 'boolean'
                    ? answer.approved : typeof answer === 'object' && answer !== null && 'password' in answer ? true : undefined;
            },
        }) : null;
        const answers = installation?.answers ?? [];
        const { createManagedMachineInstallationRespond } = await import('@/sync/ops/actions/managedMachineInstallationAction');
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'projects.script.run': ['ui'], 'machines.managed.bootstrap.respond': ['ui'],
        } });
        const execute = createFrontDoorActionExecute(createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context, getActionSpec(id).safety),
            // Actual controller/Account and guest Action transports; all admission and continuation logic stays real.
            machinePresetAction: async () => ({ kind: 'found', preset }),
            machineManagedInstallationRespond: createManagedMachineInstallationRespond(),
            managedMachineAction: async request => {
                if (request.actionId === 'machines.managed.acquire') { acquisitions.push(request.input); return { managedId: 'paid', operation: { operationId: 'install' } }; }
                if (request.actionId === 'machines.managed.get') return machine;
                if (request.actionId === 'machines.managed.list') return { machines: [machine] };
                throw new Error('unexpected_managed_transport');
            },
            actionOperationAction: async () => {
                if (mode === 'cancel') await enrollmentGate.promise;
                if (delegated && approved === undefined) {
                    expect(questionRead, 'A new operation wait must follow a delivered answer to the displayed question').toBe(false);
                    questionRead = true;
                    return { kind: 'found', operation: {
                    version: 1, operationId: 'install', revision: 1, actionId: 'machines.managed.acquire', state: 'running',
                    scope: { accountId: 'alice', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1,
                    cancellation: 'supported', domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller,
                        bootstrapTask: { id: 'requester-pairing', taskKind: 'remote.ssh.bootstrapMachine.v1',
                            prompt: mode === 'delegated-establish'
                                ? { kind: 'administrator.establish', promptId: 'administrator-prompt', administratorUsername: 'operator',
                                    message: 'Your new administrator password passes through setup.' }
                                : { kind: 'auth.approveRemoteProvisioning', message: 'Sign this worker into your Account?' } } },
                    } };
                }
                if (delegated && approved === false) return { kind: 'found', operation: {
                    version: 1, operationId: 'install', revision: 2, actionId: 'machines.managed.acquire', state: 'failed',
                    scope: { accountId: 'alice', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1, settledAt: 2,
                    cancellation: 'supported', error: { errorCode: 'auth_declined', error: 'Enrollment declined' },
                    domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller },
                } };
                const pending = mode === 'acquiring-pending' || mode === 'pending-cancel' || mode === 'pending-retire';
                if (mode !== 'enrollment-pending' && !pending) machine = { ...machine, enrolledMachineId: 'actual-guest' };
                return { kind: 'found', operation: { version: 1, operationId: 'install', revision: 2, actionId: 'machines.managed.acquire', state: 'succeeded',
                    scope: { accountId: 'alice', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1,
                    ...(pending ? { state: 'running' as const } : { settledAt: 2 }), cancellation: 'supported',
                    ...(delegated ? { domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller } } : {}) } };
            },
            projectAction: async request => {
                if (request.actionId !== 'projects.script.run') throw new Error('unexpected_project_transport');
                admissions.push(request.input);
                return { operation: { version: 1, operationId: 'finite', revision: 1, actionId: 'projects.script.run', state: 'accepted',
                    scope: { accountId: 'alice', machineId: 'actual-guest' }, title: 'Test', createdAt: 2, cancellation: 'supported' } };
            },
        }), 'alice', settings));
        const homes = [serverId];
        const changed = () => {};
        const hook = await renderHook(() => useProjectScriptsController(workspace, changed,
            useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null, { execute }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            expect(acquisitions).toEqual([]);
            expect(admissions).toEqual([]);
            if (mode === 'cancel' || mode === 'delegated-cancel') {
                let running: Promise<void> | undefined;
                act(() => { running = hook.getCurrent().run('test', { kind: 'named', name: 'test' }, undefined, draft); });
                await waitForHomeGovernance(() => expect(hook.getCurrent().managedCreations.test?.acquisition.managedId).toBe('paid'));
                if (confirmation) await waitForHomeGovernance(() => expect(confirmation).toHaveBeenCalledTimes(1));
                act(() => hook.getCurrent().cancelRun('test'));
                enrollmentGate.resolve();
                await act(async () => { await running; });
                expect(admissions).toEqual([]);
                expect(acquisitions).toHaveLength(1);
                expect(hook.getCurrent().managedCreations.test?.acquisition.managedId).toBe('paid');
                expect(hook.getCurrent().retainedOperation).toBeNull();
                expect(answers).toEqual([]);
                return;
            }
            await act(async () => { await hook.getCurrent().run('test', { kind: 'named', name: 'test' }, undefined, draft); });
            if (mode === 'delegated-decline' || mode === 'delegated-decline-failure') {
                expect(hook.getCurrent().failure).toMatchObject({ key: 'test', code: mode === 'delegated-decline' ? 'auth_declined' : 'no_prompt' });
                expect(admissions).toEqual([]);
                expect(acquisitions).toHaveLength(1);
                expect(answers).toEqual([expect.objectContaining({ homeId, managedId: 'paid', taskId: 'requester-pairing', answer: { approved: false } })]);
                return;
            }
            if (mode === 'delegated-establish') {
                expect(hook.getCurrent().failure).toBeNull();
                expect(secretPrompt).toHaveBeenCalledTimes(1);
                expect(answers).toEqual([expect.objectContaining({ homeId, managedId: 'paid', taskId: 'requester-pairing',
                    expectedPromptKind: 'administrator.establish', expectedPromptId: 'administrator-prompt', answer: { password: secret } })]);
                expect(harness.requestsFor('/v1/auth/response')).toHaveLength(0);
                expect(JSON.stringify([acquisitions, admissions, hook.getCurrent().managedCreations])).not.toContain(secret);
            }
            if (mode === 'delegated-approve') {
                expect(answers).toEqual([expect.objectContaining({ homeId, managedId: 'paid', taskId: 'requester-pairing', answer: { approved: true } })]);
                expect(harness.requestsFor('/v1/auth/response')).toHaveLength(1);
            }
            if (mode === 'pending-cancel' || mode === 'pending-retire') {
                expect(admissions).toEqual([]);
                expect(hook.getCurrent().managedCreations.test?.progress.kind).toBe('acquiring');
                if (mode === 'pending-cancel') act(() => hook.getCurrent().cancelRun('test'));
                else await act(async () => { await harness.switchAccount(home, 'bob'); });
                machine = { ...machine, enrolledMachineId: 'actual-guest' };
                act(() => publishHomeAccountChange(serverId));
                await flushHookEffects();
                expect(admissions).toEqual([]);
                expect(acquisitions).toHaveLength(1);
                return;
            }
            if (mode === 'enrollment-pending' || mode === 'acquiring-pending') {
                expect(admissions).toEqual([]);
                expect(hook.getCurrent().managedCreations.test?.progress.kind).toBe(mode === 'enrollment-pending' ? 'enrollment_pending' : 'acquiring');
                machine = { ...machine, enrolledMachineId: 'actual-guest' };
                await act(async () => { publishHomeAccountChange(serverId); });
                await flushHookEffects();
                expect(admissions).toHaveLength(1);
            }
            expect(acquisitions).toHaveLength(1);
            expect(acquisitions[0]).not.toHaveProperty('agentStart');
            expect(hook.getCurrent().failure, JSON.stringify(hook.getCurrent().managedCreations.test)).toBeNull();
            expect(admissions).toEqual([{ workspace, selection: { kind: 'named', name: 'test' },
                choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'actual-guest' } } }]);
            await act(async () => { await hook.getCurrent().run('test', { kind: 'named', name: 'test' }, undefined, draft); });
            expect(acquisitions).toHaveLength(1);
            expect(admissions).toHaveLength(2);
        } finally { enrollmentGate.resolve(); confirmation?.mockRestore(); secretPrompt?.mockRestore(); installation?.dispose(); await hook.unmount(); }
    });

    it('exposes the same live Setup Stop and review opener to compact Scripts hosts', async () => {
        const { useProjectScriptsController } = await import('@/components/projects/projectSetup/useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const home = await harness.addHome({ name: 'Setup Home', serverUrl: 'https://setup-stop.test', accountId: 'alice' });
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        harness.answer(home, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'] } },
        } } } });
        const workspace = { serverId, workspaceId: 'setup-workspace', machineId: 'machine-1', rootPath: '/repo' };
        const setup = { ...operation(serverId).snapshot, actionId: 'projects.prepare', scope: { accountId: 'alice', machineId: 'machine-1' },
            domainRef: { kind: 'projectCommand' as const, purpose: 'setup' as const, serverId, machineId: 'machine-1',
                workspaceRefId: workspace.workspaceId, cwd: '/repo', sourceWorkspace: workspace },
        };
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [setup] });
        const homes = [serverId];
        const changed = () => {};
        const hook = await renderHook(() => useProjectScriptsController(workspace, changed,
            useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            expect(hook.getCurrent().setupOperation?.snapshot.operationId).toBe(setup.operationId);
            expect(hook.getCurrent().setupReviewOpen).toBe(false);
            act(() => hook.getCurrent().openSetupReview());
            expect(hook.getCurrent().setupReviewOpen).toBe(true);
            act(() => hook.getCurrent().dismissConsent());
            expect(hook.getCurrent().setupReviewOpen).toBe(false);
            expect(rpc.machine).not.toHaveBeenCalled();
            rpc.machine.mockResolvedValue({ kind: 'requested' });
            act(() => hook.getCurrent().setupStop.requestStop());
            await waitForHomeGovernance(() => expect(hook.getCurrent().setupStop.feedback).toBe('requested'));
            expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine-1',
                method: 'actionOperation.cancel.v1', payload: { operationId: setup.operationId } }));
            expect(hook.getCurrent().setupOperation?.snapshot.state).toBe('running');
            expect(hook.getCurrent().setupStop.stopRequested).toBe(true);
            act(() => hook.getCurrent().openSetupReview());
            await act(async () => { await harness.switchAccount(home, 'bob'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().accountId).toBe('bob'));
            expect(hook.getCurrent().setupOperation).toBeNull();
            expect(hook.getCurrent().setupReviewOpen).toBe(false);
            await act(async () => { await harness.switchAccount(home, 'alice'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().accountId).toBe('alice'));
            expect(hook.getCurrent().setupReviewOpen).toBe(false);
        } finally { await hook.unmount(); }
    });

});
