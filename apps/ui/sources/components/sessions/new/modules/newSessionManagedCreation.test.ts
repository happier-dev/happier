import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createDeferred } from '@/dev/testkit';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createManagedMachineSelectionDraft, type ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedAcquireAgentStartV1 } from '@happier-dev/protocol/machines/managed/agentStartV1';
import type { MachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { readMachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { loadProfileCatalogV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { MachinePoolListOutputV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { AutomationTriggerDetailSchema } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import type { AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';
import { createWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';
import { runNewSessionManagedCreation } from './newSessionManagedCreation';
import { bindNewManagedMachineCreationScope } from '@/sync/ops/actions/managedCreationScopeBinding';

const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} };
const controller = { machineId: 'controller', installationId: 'installation' };
const draft = createManagedMachineSelectionDraft({
    selection: { kind: 'one-off', homeId: 'home', launch, controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    receipt: { launch, controller, optionStatus: 'current', prerequisites: [],
        billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
});
const initial: ManagedMachineAcquisitionDraft = { requestId: 'send-1', selection: draft.selection };
const baseMachine: ManagedMachineV1 = { id: 'paid', homeId: 'home', custodianAccountId: 'account', launch, controller,
    allocation: 'bound', resource: { contributionRef: launch.provider, schemaVersion: 1, value: { nativeId: 'same-native-id' } },
    creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };

function bindingTransport(options: Readonly<{ beforeWrite?: () => Promise<void>; custodianAccountId?: string }> = {}) {
    const rows = new Map<string, AutomationDefinitionDetail>();
    const machine = { ...baseMachine, custodianAccountId: options.custodianAccountId ?? baseMachine.custodianAccountId,
        enrolledMachineId: 'guest', reviewedFacts: draft.receipt };
    let identity = 0;
    const triggers = createWorkflowTriggerActions({
        newId: kind => `${kind}-${++identity}`,
        resolveSession: async () => ({ project: { machineId: 'guest', directory: '/work' }, nativeGoalOwner: false }),
        resolveRunSource: async () => ({ terminal: false }),
        resolveWorkflow: async () => { throw new Error('unexpected_workflow_read'); },
        resolveManagedMachine: async () => machine,
        openContext: async row => row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain' ? row.executionRecipe.workflow.v : null,
        sealContext: async ({ context, templateVersion }) => ({ v: 2, templateVersion, workflow: { t: 'plain', v: context }, triggerEvidence: null }),
        // These operations are the Account's persistent Automation transport.
        automations: {
            list: async () => ({ automations: [...rows.values()], nextCursor: null }),
            get: async id => rows.get(id) ?? null,
            create: async input => {
                await options.beforeWrite?.();
                const row: AutomationDefinitionDetail = { id: input.automationId, name: input.name, description: input.description ?? null,
                    enabled: input.enabled, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
                    workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
                    assignments: (input.assignments ?? []).map(value => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: 0, updatedAt: 1 })),
                    triggers: input.triggers.map(value => AutomationTriggerDetailSchema.parse({ ...value.trigger, id: value.triggerId,
                        revision: 0, createdAt: 1, updatedAt: 1, remainingOccurrences: 1,
                        status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null })), executionRecipe: input.executionRecipe };
                rows.set(row.id, row);
                return row;
            },
            reconcile: async (id, input) => {
                const row = rows.get(id)!;
                const retained = row.triggers.filter(value => !input.removedTriggers.some(item => item.triggerId === value.id));
                const updated = { ...row, enabled: input.enabled, triggers: retained,
                    assignments: input.assignments.map(value => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: 0, updatedAt: 1 })),
                    ...(input.executionRecipe ? { executionRecipe: input.executionRecipe, templateVersion: row.templateVersion + 1 } : {}) };
                rows.set(id, updated);
                return updated;
            },
            delete: async id => { rows.delete(id); },
        },
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        managedMachineAction: async request => {
            if (request.actionId === 'machines.managed.get') return machine;
            throw new Error('unexpected_power_effect');
        },
        workflowAction: async request => {
            if (request.actionId === 'session.trigger.list') return triggers.sessionList(request.input, request.context);
            if (request.actionId === 'workflow.trigger.list') return triggers.list(request.input, request.context);
            if (request.actionId === 'session.trigger.add') return triggers.sessionAdd(request.input, request.context);
            if (request.actionId === 'session.trigger.remove') return triggers.sessionRemove(request.input, request.context);
            if (request.actionId === 'session.trigger.update') return triggers.sessionUpdate(request.input, request.context);
            if (request.actionId === 'workflow.trigger.add') return triggers.add(request.input, request.context);
            if (request.actionId === 'workflow.trigger.update') return triggers.update(request.input, request.context);
            throw new Error('unexpected_trigger_action');
        },
    }));
    return { rows, machine, executeAction: createFrontDoorActionExecute(executor) };
}

function transport(input: Readonly<{ current?: () => boolean; wait?: () => Promise<void>; enrolled?: boolean; failed?: boolean; setupFails?: boolean; setupSucceeds?: boolean; custodianAccountId?: string; denyCrossMachine?: boolean;
    environmentSetup?: ManagedMachineV1['environmentSetup'] }> = {}) {
    // Persisted actor policy is fixture input, not a mocked policy decision or production waiver.
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
        'machines.environment.apply': ['ui'], 'machines.managed.setup.skip': ['ui'],
        'machines.managed.acquire': ['ui', 'agent'], 'machines.managed.bootstrap.retry': ['ui'],
        'machines.managed.delete': ['ui'],
    } });
    const actions: Array<{ actionId: string; input: unknown }> = [];
    let machine = { ...baseMachine, custodianAccountId: input.custodianAccountId ?? baseMachine.custodianAccountId,
        ...(input.enrolled ? { enrolledMachineId: 'guest' } : {}),
        ...(input.environmentSetup ? { preset: { id: 'preset', revision: 4 }, environmentSetup: input.environmentSetup } : {}) };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        resolveAgentStartContext: async () => ({ caller: { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 },
            baseline: { machineId: 'parent-machine', directory: '/work' }, roles: {}, ledSubtreeSessionIds: [],
            workDepthLimit: 4, callerPermissionCeiling: 'yolo' }),
        isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context, getActionSpec(actionId).safety),
        managedMachineReferences: async ({ input: request, signal }) => readMachineReferenceCensusV1({
            homeId: request.homeId, machineId: machine.enrolledMachineId ?? null, signal,
        }, {
            // Genuine Account persistence ports; requester census and Profile authority remain real.
            artifacts: { list: async () => ({ items: [], coverage: 'complete' }), read: async () => null },
            readSettings: async () => ({}),
            readProfileCatalog: () => loadProfileCatalogV1({ mode: 'plain', material: null,
                readPage: async () => ({ status: 'listed', rows: [], nextCursor: null, complete: true,
                    referenceGuardRevision: 'absent', transferControl: { status: 'absent' }, diagnostics: [] }),
                readReferenceGuard: async () => ({ status: 'ready', revision: 'absent' }),
                readTransfer: async () => ({ status: 'absent' }), readSource: async () => ({}), signal }),
            readPools: async () => MachinePoolListOutputV1Schema.parse({ pools: [{
                pool: { id: '00000000-0000-4000-8000-000000000001', name: 'Guest pool', description: null,
                    revision: 1, createdAt: 1, updatedAt: 1,
                    members: [{ machineId: 'guest', enabled: true, priorityTier: 0, state: 'connected' }] },
                availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
            }] }),
            readAssignments: async () => ({ automations: [], nextCursor: null }),
        }),
        // These ports are the controller socket and Account HTTP boundaries;
        // real Action admission, strict schemas, output validation and continuation remain active.
        managedMachineAction: async request => {
            actions.push(request);
            if (request.actionId === 'machines.managed.get') return machine;
            if (request.actionId === 'machines.managed.delete') return {
                kind: 'accepted', managedId: machine.id, intentRevision: machine.intentRevision + 1,
                operation: { operationId: 'delete' }, machineReferences: {
                    homeId: machine.homeId, machineId: machine.enrolledMachineId ?? null, coverage: 'complete',
                    references: [{ kind: 'machine_pool', id: 'pool', name: 'Guest pool' }], unavailable: [],
                },
            };
            if (request.actionId === 'machines.managed.acquire' || request.actionId === 'machines.managed.bootstrap.retry') {
                return { managedId: machine.id, operation: { operationId: 'install' } };
            }
            if (request.actionId === 'machines.managed.setup.skip' && machine.environmentSetup) {
                machine = { ...machine, environmentSetup: { ...machine.environmentSetup, state: 'skipped', errorCode: undefined } };
                return machine;
            }
            throw new Error('unexpected_machine_action');
        },
        machineEnvironmentApply: async request => {
            actions.push({ actionId: 'machines.environment.apply', input: request.input });
            if (!machine.environmentSetup) throw new Error('unexpected_environment_setup');
            machine = { ...machine, environmentSetup: { ...machine.environmentSetup, state: 'running', errorCode: undefined,
                operation: { operationId: 'setup' } } };
            return { operationId: 'setup' };
        },
        actionOperationAction: async request => {
            actions.push(request);
            await input.wait?.();
            if ('operationId' in request.input && request.input.operationId === 'setup') {
                if (machine.environmentSetup) machine = { ...machine, environmentSetup: { ...machine.environmentSetup, state: 'succeeded' } };
                return { kind: 'found', operation: { version: 1, operationId: 'setup', revision: 2,
                    actionId: 'machines.environment.apply', state: 'succeeded',
                    scope: { accountId: 'account', machineId: 'guest' }, title: 'Set up',
                    createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported' } };
            }
            if (!input.failed) machine = { ...machine, enrolledMachineId: 'guest' };
            if (input.setupFails && machine.environmentSetup) machine = { ...machine,
                environmentSetup: { ...machine.environmentSetup, state: 'failed', errorCode: 'setup_failed' } };
            if (input.setupSucceeds && machine.environmentSetup) machine = { ...machine,
                environmentSetup: { ...machine.environmentSetup, state: 'succeeded', errorCode: undefined } };
            return { kind: 'found', operation: { version: 1, operationId: 'install', revision: 2,
                actionId: 'machines.managed.acquire', state: input.failed || input.setupFails ? 'failed' : 'succeeded',
                scope: { accountId: 'account', machineId: 'controller' }, title: 'Install',
                createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
                ...(input.failed || input.setupFails ? { error: { errorCode: input.setupFails ? 'setup_failed' : 'installation_failed', error: 'Creation stage failed' } } : {}) } };
        },
    }));
    let acquisition = initial;
    const progress: unknown[] = [];
    const run = (options: Readonly<{ retryInstallation?: boolean; setupRecovery?: 'retry' | 'skip' | 'delete';
        reviewDelete?: (census: MachineReferenceCensusV1) => Promise<boolean>;
        acquisition?: ManagedMachineAcquisitionDraft; draft?: typeof draft; agentStart?: ManagedAcquireAgentStartV1 }> = {}) => runNewSessionManagedCreation({
        draft: options.draft ?? draft, acquisition: options.acquisition ?? acquisition, scope: { serverId: 'server', accountId: 'account' },
        signal: new AbortController().signal, isCurrent: input.current ?? (() => true),
        executeAction: createFrontDoorActionExecute(input.denyCrossMachine ? {
            execute: (actionId, value, context) => executor.execute(actionId, value, { ...context,
                surface: 'agent', authority: 'account_automation', defaultSessionId: 'parent', callerPermissionMode: 'yolo',
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
                sessionInputSource: { sourceSessionId: 'parent', sourceTurnId: 'turn', via: 'action' },
                sessionAgentSpawnPolicyV1: { allowCrossMachine: false },
            }),
        } : executor),
        onAcquisitionChange: value => { acquisition = value; }, onProgress: value => progress.push(value),
        onApprovalPending: () => { throw new Error('unexpected_approval'); }, ...options,
    });
    return { run, actions, progress, getAcquisition: () => acquisition,
        changeIntentRevision: (intentRevision: number) => { machine = { ...machine, intentRevision }; } };
}

describe('ordinary managed creation continuation', () => {
    it('refuses a denied authored Agent continuation before controller admission while bare compute remains allowed', async () => {
        const boundary = transport({ denyCrossMachine: true });
        const agentStart: ManagedAcquireAgentStartV1 = { directory: { kind: 'path', path: '/work' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'native.agent', localId: 'agent' } },
            initialInput: { text: 'Do the submitted work' } };
        expect(await boundary.run({ agentStart })).toEqual({ kind: 'failed', code: 'policy_denied_field' });
        expect(boundary.actions).toEqual([]);
        expect(boundary.getAcquisition()).not.toHaveProperty('managedId');
        expect(await boundary.run()).toMatchObject({ kind: 'enrolled', machine: { id: 'paid' } });
        expect(boundary.actions.filter(value => value.actionId === 'machines.managed.acquire')).toHaveLength(1);
        expect(boundary.actions.find(value => value.actionId === 'machines.managed.acquire')?.input).not.toHaveProperty('agentStart');
    });
    it('deletes the same failed-setup row only after reviewing its references, without reacquiring or continuing enrollment', async () => {
        const boundary = transport({ enrolled: true,
            environmentSetup: { environment: { setupScript: 'echo ready' }, state: 'failed', errorCode: 'setup_failed' } });
        const reviewed: MachineReferenceCensusV1[] = [];
        const result = await boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'delete',
            reviewDelete: async census => { reviewed.push(census); return true; } });
        expect(result, JSON.stringify(result)).toEqual({ kind: 'delete_requested', managedId: 'paid' });
        expect(reviewed).toEqual([{ homeId: 'home', machineId: 'guest', coverage: 'complete',
            references: [{ kind: 'machine_pool', id: '00000000-0000-4000-8000-000000000001', name: 'Guest pool' }], unavailable: [] }]);
        expect(boundary.actions.filter(value => value.actionId === 'machines.managed.delete').map(value => value.input))
            .toEqual([{ homeId: 'home', managedId: 'paid', when: 'now', expectedRevision: 1,
                intent: 'delete', reviewedDependencies: true }]);
        expect(boundary.actions.some(value => ['machines.managed.acquire', 'machines.managed.bootstrap.retry',
            'machines.environment.apply', 'machines.managed.setup.skip'].includes(value.actionId))).toBe(false);
    });
    it('keeps failed-setup recovery when the Delete review is declined', async () => {
        const boundary = transport({ enrolled: true,
            environmentSetup: { environment: { setupScript: 'echo ready' }, state: 'failed', errorCode: 'setup_failed' } });
        expect(await boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'delete',
            reviewDelete: async () => false })).toEqual({ kind: 'failed', code: 'setup_failed' });
        expect(boundary.actions.some(value => value.actionId === 'machines.managed.delete')).toBe(false);
        expect(boundary.progress).toContainEqual(expect.objectContaining({ kind: 'failed', retrySetupAvailable: true }));
    });
    it('requires a fresh Delete review when the retained row intent changes during confirmation', async () => {
        const boundary = transport({ enrolled: true,
            environmentSetup: { environment: { setupScript: 'echo ready' }, state: 'failed', errorCode: 'setup_failed' } });
        expect(await boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'delete',
            reviewDelete: async () => { boundary.changeIntentRevision(2); return true; } }))
            .toEqual({ kind: 'failed', code: 'intent_changed' });
        expect(boundary.actions.some(value => value.actionId === 'machines.managed.delete')).toBe(false);
        expect(boundary.progress).toContainEqual(expect.objectContaining({ kind: 'failed', retrySetupAvailable: true }));
    });
    it('rejoins the retained acquisition while an enrolled target awaits setup without a guest operation', async () => {
        const boundary = transport({ enrolled: true, setupSucceeds: true,
            environmentSetup: { environment: { setupScript: 'echo ready' }, state: 'pending' } });
        expect(await boundary.run({ acquisition: { ...initial, managedId: 'paid', operation: { operationId: 'install' } } }))
            .toMatchObject({ kind: 'enrolled', machine: { id: 'paid', enrolledMachineId: 'guest', environmentSetup: { state: 'succeeded' } } });
        expect(boundary.actions.some(value => value.actionId === 'machines.managed.acquire')).toBe(false);
    });
    it('holds the enrolled target until setup succeeds or is explicitly skipped without reacquisition', async () => {
        for (const state of ['pending', 'running', 'failed', 'succeeded', 'skipped'] as const) {
            const boundary = transport({ enrolled: true, environmentSetup: { environment: { setupScript: 'echo ready' }, state,
                ...(state === 'failed' ? { errorCode: 'setup_failed' } : {}) } });
            const result = await boundary.run({ acquisition: { ...initial, managedId: 'paid' } });
            expect(result.kind).toBe(state === 'succeeded' || state === 'skipped' ? 'enrolled' : state === 'failed' ? 'failed' : 'pending');
            if (state === 'pending' || state === 'running') expect(boundary.progress).toContainEqual(expect.objectContaining({ kind: 'setup_pending', state }));
            if (state === 'failed') expect(boundary.progress).toContainEqual(expect.objectContaining({ kind: 'failed',
                code: 'setup_failed', retrySetupAvailable: true, environmentSetup: expect.objectContaining({ state: 'failed' }) }));
            expect(boundary.actions.map(value => value.actionId)).not.toContain('machines.managed.acquire');
        }
    });
    it('retries the admitted preset setup on the joined machine and waits its operation before returning the target', async () => {
        const boundary = transport({ enrolled: true, environmentSetup: { environment: { setupScript: 'echo ready' }, state: 'failed', errorCode: 'setup_failed' } });
        const result = await boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'retry' });
        expect(result, JSON.stringify(result))
            .toMatchObject({ kind: 'enrolled', machine: { id: 'paid', environmentSetup: { state: 'succeeded' } } });
        expect(boundary.actions.filter(value => value.actionId === 'machines.environment.apply').map(value => value.input))
            .toEqual([{ homeId: 'home', machineId: 'guest', presetId: 'preset', presetRevision: 4 }]);
        expect(boundary.actions.find(value => value.actionId === 'action.operations.get')?.input)
            .toMatchObject({ machineId: 'guest', operationId: 'setup', waitForTerminal: true });
        expect(boundary.actions.some(value => value.actionId === 'machines.managed.acquire' || value.actionId === 'machines.managed.bootstrap.retry')).toBe(false);
    });
    it('continues only after the ordinary skip Action records setup skipped on the same creation row', async () => {
        const boundary = transport({ enrolled: true, environmentSetup: { environment: { setupScript: 'echo ready' }, state: 'failed', errorCode: 'setup_failed' } });
        const result = await boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'skip' });
        expect(result, JSON.stringify(result))
            .toMatchObject({ kind: 'enrolled', machine: { id: 'paid', environmentSetup: { state: 'skipped' } } });
        expect(boundary.actions.find(value => value.actionId === 'machines.managed.setup.skip')?.input)
            .toEqual({ homeId: 'home', managedId: 'paid', expectedIntentRevision: 1 });
        expect(boundary.actions.some(value => value.actionId === 'machines.environment.apply' || value.actionId === 'machines.managed.acquire')).toBe(false);
    });
    it('observes the admitted retry running on its actual row while its guest operation is still pending', async () => {
        const waiting = createDeferred<void>();
        const finish = createDeferred<void>();
        const boundary = transport({ enrolled: true, wait: () => { waiting.resolve(); return finish.promise; },
            environmentSetup: { environment: { setupScript: 'echo ready' }, state: 'failed', errorCode: 'setup_failed' } });
        const run = boundary.run({ acquisition: { ...initial, managedId: 'paid' }, setupRecovery: 'retry' });
        await waiting.promise;
        const progressWhilePending = boundary.progress.slice();
        finish.resolve();
        await run;
        expect(progressWhilePending).toContainEqual(expect.objectContaining({ kind: 'setup_pending', state: 'running',
            environmentSetup: expect.objectContaining({ state: 'running', operation: { operationId: 'setup' } }) }));
    });
    it('offers setup recovery after a newly admitted creation joins but its setup stage fails', async () => {
        const boundary = transport({ setupFails: true,
            environmentSetup: { environment: { setupScript: 'echo ready' }, state: 'pending' } });
        expect(await boundary.run()).toEqual({ kind: 'failed', code: 'setup_failed' });
        expect(boundary.progress).toContainEqual(expect.objectContaining({ kind: 'failed', managedId: 'paid',
            environmentSetup: expect.objectContaining({ state: 'failed' }), retrySetupAvailable: true, retryInstallationAvailable: false }));
    });
    it('keeps foreign-controller acquisition usable but makes automatic archive rules owner-only before any FIN write', async () => {
        const created = transport({ custodianAccountId: 'alice' });
        expect(await created.run()).toMatchObject({ kind: 'enrolled', machine: { enrolledMachineId: 'guest' } });
        const boundary = bindingTransport({ custodianAccountId: 'alice' });
        for (const selected of [{ ...draft, archiveEffect: 'stop' as const }, { ...draft, archiveEffect: 'delete' as const },
            { ...draft, archiveEffect: 'delete' as const, receipt: { ...draft.receipt,
                retentionCapabilities: { supportedIntents: ['stop'] as ['stop'] } } }]) {
            expect(await bindNewManagedMachineCreationScope({ draft: selected,
                // The fresh admitted read wins over an earlier controller ownership snapshot.
                machine: { ...boundary.machine, custodianAccountId: 'account' },
                source: { kind: 'session', sessionId: 'created-session' }, scope: { serverId: 'server', accountId: 'account' },
                signal: new AbortController().signal, isCurrent: () => true, executeAction: boundary.executeAction }))
                .toMatchObject({ kind: 'unavailable', availability: { supportedEffects: ['keep'],
                    reason: 'shared_unsupported', controllerMachineId: 'controller' } });
        }
        expect(boundary.rows.size).toBe(0);
        expect(await bindNewManagedMachineCreationScope({ draft, machine: boundary.machine,
            source: { kind: 'session', sessionId: 'created-session' }, scope: { serverId: 'server', accountId: 'account' },
            signal: new AbortController().signal, isCurrent: () => true, executeAction: boundary.executeAction })).toEqual({ kind: 'kept' });
    });

    it('installs only the accepted Session rule on its controller with selected idle interval and no future revision', async () => {
        for (const archiveEffect of ['stop', 'delete'] as const) {
            const boundary = bindingTransport();
            const selected = { ...draft, archiveEffect, receipt: { ...draft.receipt,
                retention: { kind: 'unused' as const, afterMs: 12345, effect: archiveEffect } } };
            const result = await bindNewManagedMachineCreationScope({ draft: selected, machine: boundary.machine,
                source: { kind: 'session', sessionId: 'created-session' }, scope: { serverId: 'server', accountId: 'account' },
                signal: new AbortController().signal, isCurrent: () => true, executeAction: boundary.executeAction });
            expect(result).toMatchObject({ kind: 'bound' });
            const row = [...boundary.rows.values()][0]!;
            expect(row.scopeSessionId).toBe('created-session');
            expect(row.assignments.map(value => value.machineId)).toEqual(['controller']);
            const context = row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain' ? row.executionRecipe.workflow.v : null;
            expect(context).toMatchObject({ executionTarget: { kind: 'detached_run' }, inlineDefinition: { blocks: [{
                actionId: archiveEffect === 'stop' ? 'machines.managed.power.set' : 'machines.managed.delete',
                input: { managedId: { kind: 'literal', value: 'paid' }, when: { kind: 'literal', value: 'after-idle' },
                    afterMs: { kind: 'literal', value: 12345 } },
            }] } });
            expect(JSON.stringify(context)).not.toContain('expectedRevision');
        }
    });

    it('Keep writes no rule, and a retired creation cannot write a selected rule', async () => {
        const boundary = bindingTransport();
        const input = { draft, machine: boundary.machine, source: { kind: 'session' as const, sessionId: 'created-session' },
            scope: { serverId: 'server', accountId: 'account' }, signal: new AbortController().signal,
            isCurrent: () => true, executeAction: boundary.executeAction };
        expect(await bindNewManagedMachineCreationScope(input)).toEqual({ kind: 'kept' });
        expect(boundary.rows.size).toBe(0);
        expect(await bindNewManagedMachineCreationScope({ ...input, draft: { ...draft, archiveEffect: 'stop' }, isCurrent: () => false }))
            .toEqual({ kind: 'incomplete', code: 'continuation_retired' });
        expect(boundary.rows.size).toBe(0);
    });

    it('rejoins the same selected binding and Keep clears it without a power effect', async () => {
        const boundary = bindingTransport();
        const input = { draft: { ...draft, archiveEffect: 'stop' as const }, machine: boundary.machine,
            source: { kind: 'session' as const, sessionId: 'created-session' }, scope: { serverId: 'server', accountId: 'account' },
            signal: new AbortController().signal, isCurrent: () => true, executeAction: boundary.executeAction };
        const bound = await bindNewManagedMachineCreationScope(input);
        expect(bound).toMatchObject({ kind: 'bound' });
        if (bound.kind !== 'bound') throw new Error('Expected selected binding');
        expect(await bindNewManagedMachineCreationScope(input)).toEqual(bound);
        expect(boundary.rows.size).toBe(1);
        expect(await bindNewManagedMachineCreationScope({ ...input, draft, existingBinding: bound.binding })).toEqual({ kind: 'kept' });
        expect([...boundary.rows.values()].flatMap(row => row.triggers)).toEqual([]);
    });

    it('uses the committed durable Run source, while unsupported Stop remains refused', async () => {
        const boundary = bindingTransport();
        const input = { draft: { ...draft, archiveEffect: 'stop' as const }, machine: boundary.machine,
            source: { kind: 'run' as const, source: { kind: 'workflow_run' as const, runId: 'actual-run' } },
            scope: { serverId: 'server', accountId: 'account' }, signal: new AbortController().signal,
            isCurrent: () => true, executeAction: boundary.executeAction };
        expect(await bindNewManagedMachineCreationScope({ ...input, draft: { ...input.draft,
            receipt: { ...draft.receipt, retentionCapabilities: { supportedIntents: ['delete'] } } } }))
            .toEqual({ kind: 'incomplete', code: 'native_intent_unsupported' });
        expect(boundary.rows.size).toBe(0);
        expect(await bindNewManagedMachineCreationScope(input)).toMatchObject({ kind: 'bound' });
        expect([...boundary.rows.values()][0]?.triggers[0]).toMatchObject({ kind: 'runLifecycle', condition: 'terminal',
            source: { kind: 'workflow_run', runId: 'actual-run' } });
    });

    it('keeps a failed or unacknowledged FIN write visibly incomplete', async () => {
        const boundary = bindingTransport({ beforeWrite: async () => { throw Object.assign(new Error('Unknown transport delivery'), { code: 'outcome_unknown' }); } });
        const result = await bindNewManagedMachineCreationScope({ draft: { ...draft, archiveEffect: 'stop' }, machine: boundary.machine,
            source: { kind: 'session', sessionId: 'created-session' }, scope: { serverId: 'server', accountId: 'account' },
            signal: new AbortController().signal, isCurrent: () => true, executeAction: boundary.executeAction });
        expect(result).toMatchObject({ kind: 'incomplete' });
        expect(boundary.rows.size).toBe(0);
    });

    it('changing the selected effect updates the same FIN binding instead of leaving two future effects', async () => {
        const boundary = bindingTransport();
        const input = { machine: boundary.machine, source: { kind: 'session' as const, sessionId: 'created-session' },
            scope: { serverId: 'server', accountId: 'account' }, signal: new AbortController().signal,
            isCurrent: () => true, executeAction: boundary.executeAction };
        expect(await bindNewManagedMachineCreationScope({ ...input, draft: { ...draft, archiveEffect: 'stop' } })).toMatchObject({ kind: 'bound' });
        expect(await bindNewManagedMachineCreationScope({ ...input, draft: { ...draft, archiveEffect: 'delete' } })).toMatchObject({ kind: 'bound' });
        expect(boundary.rows.size).toBe(1);
        expect([...boundary.rows.values()][0]?.executionRecipe).toMatchObject({ workflow: { t: 'plain', v: {
            inlineDefinition: { blocks: [{ actionId: 'machines.managed.delete' }] },
        } } });
    });

    it('admits a supported reviewed archive effect without binding before a Session exists', async () => {
        const boundary = transport();
        expect(await boundary.run({ draft: { ...draft, archiveEffect: 'stop' } })).toMatchObject({
            kind: 'enrolled', machine: { id: 'paid', enrolledMachineId: 'guest' },
        });
        expect(boundary.actions.filter(value => value.actionId === 'machines.managed.acquire')).toHaveLength(1);
        expect(boundary.actions.some(value => value.actionId === 'session.trigger.add')).toBe(false);
    });

    it('acquires only on explicit submission, waits installation, and reuses the paid reference after reload', async () => {
        const boundary = transport();
        expect(boundary.actions).toEqual([]);
        expect(await boundary.run()).toMatchObject({ kind: 'enrolled', machine: { id: 'paid', enrolledMachineId: 'guest' } });
        const reloaded = transport({ enrolled: true });
        expect(await reloaded.run({ acquisition: boundary.getAcquisition() })).toMatchObject({ kind: 'enrolled', machine: { id: 'paid' } });
        expect([...boundary.actions, ...reloaded.actions].filter(value => value.actionId === 'machines.managed.acquire')).toHaveLength(1);
        const acquire = boundary.actions.find(value => value.actionId === 'machines.managed.acquire')!;
        expect(acquire.input).not.toHaveProperty('agentStart');
    });

    it('retains the same resource across failed installation and explicit installation retry', async () => {
        const failed = transport({ failed: true });
        expect(await failed.run()).toEqual({ kind: 'failed', code: 'installation_failed' });
        expect(failed.getAcquisition().managedId).toBe('paid');
        expect(failed.progress).toContainEqual(expect.objectContaining({
            kind: 'failed', managedId: 'paid', retryInstallationAvailable: true,
            operation: expect.objectContaining({ operationId: 'install', state: 'failed' }),
        }));
        const retry = transport();
        expect(await retry.run({ acquisition: failed.getAcquisition(), retryInstallation: true })).toMatchObject({ kind: 'enrolled', machine: { id: 'paid' } });
        expect(retry.actions.filter(value => value.actionId === 'machines.managed.acquire')).toEqual([]);
        expect(retry.actions.find(value => value.actionId === 'machines.managed.bootstrap.retry')?.input).toEqual({ homeId: 'home', managedId: 'paid', expectedIntentRevision: 1 });
    });

    it('retires a replaced local continuation even when its original operation later enrolls', async () => {
        const waiting = createDeferred<void>();
        let current = true;
        const boundary = transport({ current: () => current, wait: () => waiting.promise });
        const pending = boundary.run();
        await expect.poll(() => boundary.actions.some(value => value.actionId === 'action.operations.get')).toBe(true);
        current = false;
        waiting.resolve();
        expect(await pending).toEqual({ kind: 'failed', code: 'continuation_retired' });
        expect(boundary.getAcquisition().managedId).toBe('paid');
        expect(boundary.progress.some(value => typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'ready')).toBe(false);
    });
});
