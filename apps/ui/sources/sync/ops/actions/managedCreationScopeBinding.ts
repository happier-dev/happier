import type { AutomationRunLifecycleSource } from '@happier-dev/protocol/automations/automationRunLifecycle';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { readManagedMachineTriggerAction } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';
import { ManagedGetOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { SessionTriggerAddRequestV1Schema, SessionTriggerUpdateRequestV1Schema, SessionTriggerListResultV1Schema, WorkflowTriggerAddRequestV1Schema, WorkflowTriggerUpdateRequestV1Schema, WorkflowTriggerListResultV1Schema,
    WorkflowTriggerWriteResultV1Schema, type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { resolveManagedMachineArchiveChoiceAvailability, type ManagedMachineArchiveChoiceAvailability } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';

export type ManagedCreationScopeSource = Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'run'; source: AutomationRunLifecycleSource }>;
export type ManagedCreationScopeBinding = Readonly<{ automationId: string; triggerId: string; source: ManagedCreationScopeSource }>;
export type ManagedCreationScopeBindingResult = Readonly<{ kind: 'kept' }>
    | Readonly<{ kind: 'bound'; binding: ManagedCreationScopeBinding }>
    | Readonly<{ kind: 'unavailable'; availability: ManagedMachineArchiveChoiceAvailability }>
    | Readonly<{ kind: 'incomplete'; code: string; artifactId?: string }>;

/**
 * The one recognizer of a managed creation-scope rule inside FIN's trigger sets: an inline Stop/Delete
 * of this exact managed row, with its single enabled session-archived or run-terminal trigger. The
 * binder below writes through it and the Machine page reads through it, so both agree on what counts.
 */
function matchManagedCreationScopeTrigger(set: WorkflowTriggerSetV1, machine: Readonly<{ homeId: string; id: string }>) {
    const managed = set.target && readManagedMachineTriggerAction(set.target);
    if (!managed || managed.input.homeId !== machine.homeId || managed.input.managedId !== machine.id
        || set.triggers.length !== 1) return null;
    const trigger = set.triggers[0]!;
    if (!trigger.enabled) return null;
    const source: ManagedCreationScopeSource | null = trigger.kind === 'sessionLifecycle' && trigger.events.includes('sessionArchived')
        ? { kind: 'session', sessionId: trigger.sourceSessionId }
        : trigger.kind === 'runLifecycle' && trigger.condition === 'terminal' ? { kind: 'run', source: trigger.source } : null;
    return source ? { managed, trigger, source } : null;
}

/** What a created machine's page shows about its scope rule; FIN's trigger stays the only editor. */
export type ManagedCreationScopeRule = Readonly<{
    binding: ManagedCreationScopeBinding;
    effect: 'stop' | 'delete';
    afterMs?: number;
    /** The source ended and the rule's run is waiting for work on the machine to finish. */
    waiting: boolean;
}>;

/** Reads the creation-scope rule FIN holds for this managed row, if the owner chose Stop or Delete. */
export function readManagedCreationScopeRule(sets: readonly WorkflowTriggerSetV1[],
    machine: Readonly<{ homeId: string; id: string }>): ManagedCreationScopeRule | null {
    for (const set of sets) {
        if (!set.enabled) continue;
        const match = matchManagedCreationScopeTrigger(set, machine);
        if (!match) continue;
        const status = 'status' in match.trigger ? match.trigger.status : null;
        const afterMs = 'afterMs' in match.managed.input ? match.managed.input.afterMs : undefined;
        return { binding: { automationId: set.automationId, triggerId: match.trigger.id, source: match.source },
            effect: match.managed.actionId === 'machines.managed.delete' ? 'delete' : 'stop',
            ...(afterMs === undefined ? {} : { afterMs }),
            waiting: status?.state === 'triggered' || status?.state === 'running' };
    }
    return null;
}

/** After real creation acceptance, FIN alone stores and executes the selected scope rule. */
export async function bindNewManagedMachineCreationScope(input: Readonly<{
    draft: ManagedMachineSelectionDraft;
    machine: ManagedMachineV1;
    source: ManagedCreationScopeSource;
    scope: ServerAccountScope;
    signal: AbortSignal;
    isCurrent: () => boolean;
    existingBinding?: ManagedCreationScopeBinding;
    executeAction?: ReturnType<typeof createFrontDoorActionExecute>;
    onApprovalPending?: (value: ActionApprovalRegistration) => void;
}>): Promise<ManagedCreationScopeBindingResult> {
    const current = () => input.isCurrent() && !input.signal.aborted;
    const incomplete = (code: string): ManagedCreationScopeBindingResult => ({ kind: 'incomplete', code });
    if (!current()) return incomplete('continuation_retired');
    if (input.draft.archiveEffect === 'keep' && !input.existingBinding) return { kind: 'kept' };
    const execute = input.executeAction ?? createFrontDoorActionExecute();
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
        serverId: input.scope.serverId, expectedAccountId: input.scope.accountId, signal: input.signal };
    const mutate = (actionId: ActionId, request: unknown, completed: (value: unknown) => ManagedCreationScopeBindingResult) =>
        awaitActionApprovalResult<unknown, ManagedCreationScopeBindingResult>({
            signal: input.signal,
            execute: async callbacks => {
                if (!current()) return incomplete('continuation_retired');
                const outcome = classifyHomeActionOutcome(await execute(actionId, request, context));
                if (!current()) return incomplete('continuation_retired');
                if (outcome.kind === 'failed') return incomplete(homeDomainFailureCode(outcome.failure));
                if (outcome.kind === 'approval_pending') {
                    if (!input.onApprovalPending) return { kind: 'incomplete', code: 'approval_required', artifactId: outcome.artifactId };
                    input.onApprovalPending(createActionApprovalContinuation({ artifactId: outcome.artifactId, actionId,
                        scope: input.scope, expectedInput: request, signal: input.signal,
                        onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed }));
                    return { approvalPending: true };
                }
                return completed(outcome.result);
            },
            succeeded: result => current() ? completed(result) : incomplete('continuation_retired'),
            failed: incomplete, aborted: () => incomplete('continuation_retired'),
        });
    try {
        if (input.draft.archiveEffect === 'keep') {
            const binding = input.existingBinding!;
            if (!sameStrictJsonValue(binding.source, input.source)) return incomplete('binding_scope_mismatch');
            const actionId = input.source.kind === 'session' ? 'session.trigger.remove' as const : 'workflow.trigger.remove' as const;
            const request = input.source.kind === 'session' ? { sessionId: input.source.sessionId, triggerId: binding.triggerId }
                : { automationId: binding.automationId, triggerId: binding.triggerId };
            return await mutate(actionId, request, value => {
                WorkflowTriggerWriteResultV1Schema.parse(value);
                return { kind: 'kept' };
            });
        }
        const read = classifyHomeActionOutcome(await execute('machines.managed.get', { homeId: input.machine.homeId, managedId: input.machine.id }, context));
        if (!current()) return incomplete('continuation_retired');
        if (read.kind !== 'completed') return incomplete(read.kind === 'failed' ? homeDomainFailureCode(read.failure) : 'approval_required');
        const machine = ManagedGetOutputV1Schema.parse(read.result);
        if (machine.homeId !== input.draft.selection.homeId || machine.id !== input.machine.id || machine.creationState !== 'active'
            || machine.allocation !== 'bound' || !machine.enrolledMachineId
            || !sameStrictJsonValue(machine.controller, input.machine.controller)) return incomplete('managed_target_scope_changed');
        const availability = resolveManagedMachineArchiveChoiceAvailability({ draft: input.draft,
            controllerOwnership: machine.custodianAccountId === input.scope.accountId ? 'owned' : 'shared',
            custodianAccountId: machine.custodianAccountId });
        if (availability.reason) return { kind: 'unavailable', availability };
        if (!availability.supportedEffects.includes(input.draft.archiveEffect)) return incomplete('native_intent_unsupported');
        const listed = classifyHomeActionOutcome(await execute(input.source.kind === 'session' ? 'session.trigger.list' : 'workflow.trigger.list',
            input.source.kind === 'session' ? { sessionId: input.source.sessionId } : { scope: 'account_inline' }, context));
        if (!current()) return incomplete('continuation_retired');
        if (listed.kind !== 'completed') return incomplete(listed.kind === 'failed' ? homeDomainFailureCode(listed.failure) : 'approval_required');
        const sets = (input.source.kind === 'session' ? SessionTriggerListResultV1Schema : WorkflowTriggerListResultV1Schema).parse(listed.result).sets;
        const effect = input.draft.archiveEffect;
        const afterMs = input.draft.receipt.retention.kind === 'unused' ? input.draft.receipt.retention.afterMs : undefined;
        const definition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [], blocks: [{
            kind: 'action', id: 'managed-scope-end', actionId: effect === 'stop' ? 'machines.managed.power.set' : 'machines.managed.delete',
            input: { homeId: { kind: 'literal', value: machine.homeId }, managedId: { kind: 'literal', value: machine.id },
                when: { kind: 'literal', value: 'after-idle' }, intent: { kind: 'literal', value: effect },
                ...(afterMs === undefined ? {} : { afterMs: { kind: 'literal', value: afterMs } }),
                ...(effect === 'delete' ? { reviewedDependencies: { kind: 'literal', value: true } } : {}) },
        }] });
        const project = { machineId: machine.controller.machineId, directory: '~' };
        const common = { project, target: { kind: 'inline' as const, definition }, executionTarget: { kind: 'detached_run' as const } };
        for (const set of sets) {
            const match = matchManagedCreationScopeTrigger(set, machine);
            if (!match || !sameStrictJsonValue(match.source, input.source)) continue;
            const existing = match.trigger;
            if (sameStrictJsonValue(set.target, common.target) && set.project?.machineId === machine.controller.machineId && set.enabled) {
                return { kind: 'bound', binding: { automationId: set.automationId, triggerId: existing.id, source: input.source } };
            }
            const actionId = input.source.kind === 'session' ? 'session.trigger.update' as const : 'workflow.trigger.update' as const;
            const request = input.source.kind === 'session' ? SessionTriggerUpdateRequestV1Schema.parse({ sessionId: input.source.sessionId,
                triggerId: existing.id, expectedRevision: set.revision, patch: common })
                : WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: set.automationId, triggerId: existing.id,
                    expectedRevision: set.revision, patch: common });
            return await mutate(actionId, request, bound);
        }
        const actionId = input.source.kind === 'session' ? 'session.trigger.add' as const : 'workflow.trigger.add' as const;
        const request = input.source.kind === 'session' ? SessionTriggerAddRequestV1Schema.parse({ ...common, sessionId: input.source.sessionId,
            trigger: { kind: 'sessionLifecycle', sourceSessionId: input.source.sessionId, events: ['sessionArchived'], policy: { kind: 'everyMatch' }, enabled: true } })
            : WorkflowTriggerAddRequestV1Schema.parse({ ...common, trigger: { kind: 'runLifecycle', source: input.source.source, condition: 'terminal', enabled: true } });
        if (!current()) return incomplete('continuation_retired');
        return await mutate(actionId, request, bound);
        function bound(value: unknown): ManagedCreationScopeBindingResult {
            const result = WorkflowTriggerWriteResultV1Schema.parse(value);
            if (!result.triggerId || result.set.project?.machineId !== machine.controller.machineId) return incomplete('binding_response_invalid');
            return { kind: 'bound', binding: { automationId: result.set.automationId, triggerId: result.triggerId, source: input.source } };
        }
    } catch (error) {
        return incomplete(!current() ? 'continuation_retired' : error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code : 'binding_outcome_unknown');
    }
}
