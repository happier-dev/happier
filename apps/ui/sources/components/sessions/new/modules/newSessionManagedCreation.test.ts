import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createDeferred } from '@/dev/testkit';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createManagedMachineSelectionDraft, type ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
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

function transport(input: Readonly<{ current?: () => boolean; wait?: () => Promise<void>; enrolled?: boolean; failed?: boolean; custodianAccountId?: string }> = {}) {
    const actions: Array<{ actionId: string; input: unknown }> = [];
    let machine = { ...baseMachine, custodianAccountId: input.custodianAccountId ?? baseMachine.custodianAccountId,
        ...(input.enrolled ? { enrolledMachineId: 'guest' } : {}) };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        // These ports are the controller socket and Account HTTP boundaries;
        // real Action admission, strict schemas, output validation and continuation remain active.
        managedMachineAction: async request => {
            actions.push(request);
            if (request.actionId === 'machines.managed.get') return machine;
            if (request.actionId === 'machines.managed.acquire' || request.actionId === 'machines.managed.bootstrap.retry') {
                return { managedId: machine.id, operation: { operationId: 'install' } };
            }
            throw new Error('unexpected_machine_action');
        },
        actionOperationAction: async request => {
            actions.push(request);
            await input.wait?.();
            if (!input.failed) machine = { ...machine, enrolledMachineId: 'guest' };
            return { kind: 'found', operation: { version: 1, operationId: 'install', revision: 2,
                actionId: 'machines.managed.acquire', state: input.failed ? 'failed' : 'succeeded',
                scope: { accountId: 'account', machineId: 'controller' }, title: 'Install',
                createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
                ...(input.failed ? { error: { errorCode: 'installation_failed', error: 'Installation failed' } } : {}) } };
        },
    }));
    let acquisition = initial;
    const progress: unknown[] = [];
    const run = (options: Readonly<{ retryInstallation?: boolean; acquisition?: ManagedMachineAcquisitionDraft; draft?: typeof draft }> = {}) => runNewSessionManagedCreation({
        draft: options.draft ?? draft, acquisition: options.acquisition ?? acquisition, scope: { serverId: 'server', accountId: 'account' },
        signal: new AbortController().signal, isCurrent: input.current ?? (() => true),
        executeAction: createFrontDoorActionExecute(executor),
        onAcquisitionChange: value => { acquisition = value; }, onProgress: value => progress.push(value),
        onApprovalPending: () => { throw new Error('unexpected_approval'); }, ...options,
    });
    return { run, actions, progress, getAcquisition: () => acquisition };
}

describe('ordinary managed creation continuation', () => {
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
