import * as React from 'react';
import { WorkflowConversationBindInputV1Schema, WorkflowConversationBindResultV1Schema } from '@happier-dev/protocol';
import type { EntityDragItemV1, EntityDragScopeV1, EntityDropAdmissionV1, EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { resolveWorkflowSessionBinding, type WorkflowSessionBindingContext } from '@/sync/domains/workflows/workflowAuthoringSessionBinding';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { registerWorkflowConversationBindingOwner } from '@/sync/ops/actions/workflowAuthoringAction';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

export type WorkflowSessionDrop = Readonly<{
    scope: EntityDragScopeV1;
    resolve: (stepId: string | null, item: EntityDragItemV1) => EntityDropAdmissionV1;
    execute: (effect: EntityDropEffectV1) => Promise<EntityDropOutcomeV1>;
    bind: (stepId: string | null, sessionId: string) => Promise<EntityDropOutcomeV1>;
}>;

/** One local presentation of the domain refusal, shared by previews and final replies. */
function refusalMessage(context: WorkflowSessionBindingContext, reason: string, sessionId: string,
    names: Readonly<{ whereName: string | null; machineName: (id: string) => string }>): string {
    const option = context.candidates.find(candidate => candidate.sessionId === sessionId);
    if (reason === 'workflow_where_machine_mismatch' && option && context.whereMachineId !== null) {
        return t('workflows.page.inspector.dropRefused', { session: option.label, machine: names.machineName(option.machineId),
            where: names.whereName ?? names.machineName(context.whereMachineId) });
    }
    return reason === 'workflow_session_unavailable'
        ? t('workflows.conversation.noExistingSessions') : t('entityDragDrop.reasons.generic');
}

export function useWorkflowSessionBinding(input: Readonly<{
    context: WorkflowSessionBindingContext;
    onChange: (draft: WorkflowSessionBindingContext['draft']) => void;
    whereName: string | null;
    machineName: (id: string) => string;
}>): WorkflowSessionDrop | undefined {
    const latest = React.useRef(input);
    latest.current = input;
    const executeAction = React.useMemo(() => createFrontDoorActionExecute(), []);
    React.useLayoutEffect(() => registerWorkflowConversationBindingOwner({
        getContext: () => latest.current.context,
        onChange: draft => latest.current.onChange(draft),
    }), []);
    const scope = input.context.scope;
    return React.useMemo(() => {
        if (!scope) return undefined;
        const resolve = (stepId: string | null, item: EntityDragItemV1): EntityDropAdmissionV1 => {
            const current = latest.current;
            if (item.kind !== 'session') return { status: 'refused', reason: { code: 'workflow_session_unavailable', message: t('workflows.conversation.noExistingSessions') } };
            const request = { scope: item.scope, draftId: current.context.draft.draftId, stepId, address: item.address };
            const admission = resolveWorkflowSessionBinding(current.context, request);
            if (admission.status === 'refused') return { status: 'refused', reason: {
                code: admission.reason, message: refusalMessage(current.context, admission.reason, item.address.sessionId, current),
            } };
            const block = stepId === null ? null : findWorkflowBlock(current.context.draft, stepId);
            return { status: 'allowed', effect: { actionId: 'workflow.authoring.conversation.bind', input: request,
                preview: { glyph: 'add', verb: t('workflows.page.inspector.dropContinue', { session: admission.option.label }),
                    target: block === null ? t('workflows.page.blocks.workflowDefaults') : workflowBlockReferenceLabel(block) },
            } };
        };
        const execute = async (effect: EntityDropEffectV1): Promise<EntityDropOutcomeV1> => {
            const request = WorkflowConversationBindInputV1Schema.safeParse(effect.input);
            if (!request.success) return { status: 'refused', reason: { code: 'invalid_parameters', message: t('entityDragDrop.reasons.generic') } };
            let result: Awaited<ReturnType<typeof executeAction>>;
            try {
                result = await executeAction('workflow.authoring.conversation.bind', request.data, {
                    surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
                });
            } catch {
                return { status: 'unknown', reason: { code: 'action_failed', message: t('entityDragDrop.reasons.generic') } };
            }
            if (!result.ok) return { status: 'refused', reason: { code: result.errorCode ?? 'action_failed', message: t('entityDragDrop.reasons.generic') } };
            const parsed = WorkflowConversationBindResultV1Schema.safeParse(result.result);
            if (!parsed.success) return { status: 'unknown', reason: { code: 'invalid_result', message: t('entityDragDrop.reasons.generic') } };
            const outcome = parsed.data;
            if (outcome.status === 'applied' || outcome.status === 'unchanged') return { status: 'applied' };
            const reason = outcome.status === 'refused' ? outcome.reason : 'workflow_draft_unavailable';
            return { status: 'refused', reason: { code: reason, message: refusalMessage(latest.current.context, reason, request.data.address.sessionId, latest.current) } };
        };
        return { scope, resolve, execute, bind: async (stepId, sessionId) => {
            const admission = resolve(stepId, { kind: 'session', scope, address: { serverId: scope.serverId, sessionId } });
            return admission.status === 'allowed' ? execute(admission.effect) : admission;
        } };
    }, [executeAction, scope?.serverId, scope?.accountId]);
}
