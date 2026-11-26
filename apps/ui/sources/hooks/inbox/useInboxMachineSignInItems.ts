import * as React from 'react';
import {
    buildInboxMachineSignInItems, type InboxMachineSignInItem, type InboxMachineSignInTarget,
} from '@/components/inbox/inboxItems';
import { approveManagedMachineEnrollment } from '@/components/settings/machines/managed/managedMachineCreation';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { readManagedInstallationPromptSnapshot } from '@/sync/domains/actionOperations/managedMachineOperation';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute, type FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ACTION_OPERATION_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { MACHINE_MANAGED_INSTALLATION_ACTION_IDS } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { MANAGED_GET_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import {
    MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1, MANAGED_MACHINE_SIGN_IN_OCCURRENCES_PATH_V1,
    ManagedGetActionOutputV1Schema, ManagedMachineSignInOccurrencesV1Schema, unwrapManagedMachineReadV1,
    type ManagedMachineSignInOccurrenceV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';

const emptyItems: readonly InboxMachineSignInItem[] = Object.freeze([]);
const [managedInstallationRespond] = MACHINE_MANAGED_INSTALLATION_ACTION_IDS;

type ReadOccurrences = (scope: ServerAccountScope, signal: AbortSignal) => Promise<
    { ok: true; value: { occurrences: readonly ManagedMachineSignInOccurrenceV1[] } }
    | { ok: false; failure: { httpStatus?: number } }
>;

const readOccurrences: ReadOccurrences = (scope, signal) => requestHomeDomain({
    scope, path: MANAGED_MACHINE_SIGN_IN_OCCURRENCES_PATH_V1, method: 'GET', input: undefined,
    schema: ManagedMachineSignInOccurrencesV1Schema, effect: 'read', signal,
});

export function observeInboxMachineSignInItems(params: Readonly<{
    binding: ServerAccountScopeLifetime;
    publish: (items: readonly InboxMachineSignInItem[]) => void;
    read?: ReadOccurrences;
}>): () => void {
    if (!params.binding.isCurrent()) return () => {};
    const { scope } = params.binding;
    const controller = new AbortController();
    let items = emptyItems;
    let reading = false;
    let invalidated = false;
    let current = false;
    const read = params.read ?? readOccurrences;
    const publish = (next: readonly InboxMachineSignInItem[]) => {
        if (items === next) return;
        items = next;
        params.publish(items);
    };
    const invalidate = () => {
        invalidated = true;
        current = false;
        if (reading || controller.signal.aborted) return;
        reading = true;
        fireAndForget((async () => {
            try {
                while (invalidated && !controller.signal.aborted) {
                    invalidated = false;
                    const response = await read(scope, controller.signal);
                    if (controller.signal.aborted || !params.binding.isCurrent()) return;
                    if (invalidated) continue;
                    current = response.ok || response.failure.httpStatus === 404;
                    if (response.ok) publish(buildInboxMachineSignInItems(scope, response.value.occurrences, items));
                    else if (response.failure.httpStatus === 404) publish(emptyItems);
                }
            } finally {
                reading = false;
            }
        })(), { tag: 'Inbox.machineSignIn.refresh' });
    };
    const unsubscribe = subscribeHomeAccountChange(event => {
        if (event.source === 'snapshot' || event.source === 'connected'
            || (event.entityIds && event.changeKinds?.includes('account') && event.entityIds.some(
                id => id.startsWith(MANAGED_MACHINE_SIGN_IN_OCCURRENCE_ENTITY_PREFIX_V1)))
            || (event.changeKinds === undefined && event.entityIds === undefined)) invalidate();
    }, {
        serverIds: [scope.serverId], includeCatchUpPending: 'recovery',
        reconnect: { readNotCurrent: () => !current },
    });
    const stop = () => {
        controller.abort();
        unsubscribe();
    };
    const retirement = params.binding.onRetire(() => {
        stop();
        publish(emptyItems);
    });
    invalidate();
    return () => {
        stop();
        retirement.dispose();
    };
}

/** Reads each occurrence from its bound Home and follows the existing Account wake. */
export function useInboxMachineSignInItems(binding: ServerAccountScopeLifetime | null): readonly InboxMachineSignInItem[] {
    const [snapshot, setSnapshot] = React.useState<Readonly<{ binding: ServerAccountScopeLifetime;
        items: readonly InboxMachineSignInItem[] }> | null>(null);
    React.useEffect(() => binding ? observeInboxMachineSignInItems({
        binding,
        publish: items => setSnapshot({ binding, items }),
    }) : undefined, [binding]);
    return snapshot && snapshot.binding === binding && binding.isCurrent() ? snapshot.items : emptyItems;
}

export async function openInboxMachineSignInTarget(params: Readonly<{
    target: InboxMachineSignInTarget;
    binding: ServerAccountScopeLifetime;
    executeAction?: FrontDoorActionExecute;
}>): Promise<ActionExecuteResult> {
    const { target, binding } = params;
    const { serverId, requesterAccountId, homeId, managedId, operationId, taskId } = target;
    const fail = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
    if (binding.scope.serverId !== serverId || binding.scope.accountId !== requesterAccountId || !binding.isCurrent()) {
        return fail('action_account_scope_changed');
    }
    const execute = params.executeAction ?? createFrontDoorActionExecute();
    const context = { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: requesterAccountId } as const;
    const managed = { homeId, managedId };
    const read = await execute(MANAGED_GET_ACTION_ID_V1, managed, context);
    if (!read.ok) return read;
    const parsedMachine = ManagedGetActionOutputV1Schema.safeParse(read.result);
    if (!parsedMachine.success) return fail('managed_response_invalid');
    const machine = unwrapManagedMachineReadV1(parsedMachine.data);
    if (machine.id !== managedId || machine.homeId !== homeId || !machine.controller) return fail('no_prompt');
    const response = await execute(ACTION_OPERATION_GET_ACTION_ID_V1, {
        serverId, machineId: machine.controller.machineId, managed, operationId,
    }, context);
    if (!response.ok) return response;
    const parsed = ActionOperationGetV1ResponseSchema.safeParse(response.result);
    if (!parsed.success) return fail('managed_response_invalid');
    if (parsed.data.kind !== 'found') return fail('no_prompt');
    const snapshot = parsed.data.operation;
    // Preset rows can be opaque. The existing answering client opens the
    // private resource and enforces the current installation binding.
    if (snapshot.operationId !== operationId || snapshot.scope.accountId !== requesterAccountId
        || snapshot.scope.machineId !== machine.controller.machineId
        || snapshot.domainRef?.kind !== 'managedMachine' || snapshot.domainRef.id !== managedId) return fail('no_prompt');
    const question = readManagedInstallationPromptSnapshot(snapshot);
    if (question?.kind !== 'auth.approveRemoteProvisioning' || question.taskId !== taskId) return fail('no_prompt');
    if (!binding.isCurrent()) return fail('action_account_scope_changed');
    const { taskId: _, ...prompt } = question;
    return approveManagedMachineEnrollment({
        prompt, correlation: { ...managed, serverId, operationId, taskId },
        respond: answer => execute(managedInstallationRespond, answer, context),
    });
}
