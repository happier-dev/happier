import type { ManagedMachineBirthSourceV1 } from '@happier-dev/protocol/machines/managed/birthSourceV1';
import { ManagedGetOutputV1Schema, ManagedMachineBirthResultV1Schema, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { classifyHomeActionOutcome, observeHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { type ManagedMachineArchiveChoiceAvailability } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';

export type ManagedCreationScopeSource = ManagedMachineBirthSourceV1;
export type ManagedCreationScopeBinding = Readonly<{ source: ManagedCreationScopeSource }>;
export type ManagedCreationScopeBindingResult = Readonly<{ kind: 'kept' }>
    | Readonly<{ kind: 'bound'; binding: ManagedCreationScopeBinding }>
    | Readonly<{ kind: 'unavailable'; availability: ManagedMachineArchiveChoiceAvailability }>
    | Readonly<{ kind: 'incomplete'; code: string; artifactId?: string }>;

/**
 * Keep has no retained scope choice to name its source. Read the exact non-content birth relationship
 * from the Run or Session owner without opening content or scanning either inventory.
 */
export async function readManagedCreationScopeBirthSource(input: Readonly<{
    machine: Readonly<{ homeId: string; id: string }>;
    accountLifetime: ServerAccountScopeLifetime;
    signal: AbortSignal;
}>): Promise<ManagedCreationScopeSource | null> {
    const current = () => !input.signal.aborted && input.accountLifetime.isCurrent();
    if (!current()) throw new Error('action_account_scope_changed');
    const actionId = 'machines.managed.birth.get';
    const actionInput = { homeId: input.machine.homeId, managedId: input.machine.id };
    const scope = input.accountLifetime.scope;
    const executeAction = createFrontDoorActionExecute();
    const failed = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    return awaitActionApprovalResult<ReturnType<typeof ManagedMachineBirthResultV1Schema.parse>, ManagedCreationScopeSource | null>({
        signal: input.signal,
        execute: async callbacks => {
            const result = await executeAction(actionId, actionInput, {
                surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId, signal: input.signal,
            });
            if (!current()) return failed('action_account_scope_changed');
            const outcome = observeHomeActionOutcome<ReturnType<typeof ManagedMachineBirthResultV1Schema.parse>, typeof actionId>({
                result, actionId, actionInput, scope, signal: input.signal,
                onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
            });
            if (outcome.kind === 'approval_pending') return { approvalPending: true };
            if (outcome.kind === 'failed') return failed(homeDomainFailureCode(outcome.failure));
            return ManagedMachineBirthResultV1Schema.parse(outcome.result).source;
        },
        succeeded: value => ManagedMachineBirthResultV1Schema.parse(value).source,
        failed, aborted: () => failed('action_account_scope_changed'),
    });
}

/** Home projects the admitted source lifecycle; FIN does not hold a retention decision. */
export type ManagedCreationScopeRule = Readonly<{
    binding: ManagedCreationScopeBinding;
    effect: 'stop' | 'delete';
    afterMs?: number;
    waiting: boolean;
}>;
export function readManagedCreationScopeRule(machine: Pick<ManagedMachineV1, 'creationScopeRetention'>,
    birth?: ManagedCreationScopeSource | null): ManagedCreationScopeRule | null {
    const scope = machine.creationScopeRetention;
    if (!scope?.source || birth && !sameStrictJsonValue(scope.source, birth)) return null;
    return { binding: { source: scope.source }, effect: scope.effect,
        ...(scope.afterMs === undefined ? {} : { afterMs: scope.afterMs }), waiting: scope.endedAt !== undefined };
}

/** Acquisition owns the choice; birth owns its source. This joins their acknowledged Home projection. */
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
    try {
        const read = classifyHomeActionOutcome(await execute('machines.managed.get', { homeId: input.machine.homeId, managedId: input.machine.id }, context));
        if (!current()) return incomplete('continuation_retired');
        if (read.kind !== 'completed') return incomplete(read.kind === 'failed' ? homeDomainFailureCode(read.failure) : 'approval_required');
        const machine = unwrapManagedMachineReadV1(ManagedGetOutputV1Schema.parse(read.result));
        if (machine.homeId !== input.draft.selection.homeId || machine.id !== input.machine.id || machine.creationState !== 'active'
            || machine.allocation !== 'bound' || !machine.enrolledMachineId
            || !sameStrictJsonValue(machine.controller, input.machine.controller)) return incomplete('managed_target_scope_changed');
        const effect = input.draft.archiveEffect;
        const selected = readManagedCreationScopeRule(machine, input.source);
        if (selected?.effect === effect) return { kind: 'bound', binding: selected.binding };
        // A shared controller's admitted creator receives the acquisition choice,
        // not ordinary retention-edit or manual power authority.
        if (machine.custodianAccountId !== input.scope.accountId) return incomplete('permission_denied');
        const actionId = 'machines.managed.retention.update';
        const request = { homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision,
            creationScopeRetention: effect === 'keep' ? null : { effect } };
        const completed = (value: unknown): ManagedCreationScopeBindingResult => {
            const updated = unwrapManagedMachineReadV1(ManagedGetOutputV1Schema.parse(value));
            if (effect === 'keep') return updated.creationScopeRetention ? incomplete('binding_response_invalid') : { kind: 'kept' };
            const rule = readManagedCreationScopeRule(updated, input.source);
            return rule?.effect === effect ? { kind: 'bound', binding: rule.binding } : incomplete('binding_response_invalid');
        };
        return await awaitActionApprovalResult<unknown, ManagedCreationScopeBindingResult>({
            signal: input.signal,
            execute: async callbacks => {
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
            succeeded: value => current() ? completed(value) : incomplete('continuation_retired'),
            failed: incomplete, aborted: () => incomplete('continuation_retired'),
        });
    } catch (error) {
        return incomplete(!current() ? 'continuation_retired' : error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code : 'binding_response_invalid');
    }
}
