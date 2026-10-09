import * as React from 'react';
import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectPrepareNoLaunchResultV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';

import { ProjectSetupConsentReviewCard } from '@/components/projects/projectSetup/ProjectSetupSessionReview';
import { useProjectScriptsController } from '@/components/projects/projectSetup/useProjectScriptsController';
import { describeActionOperationStatusLabel, resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { Item } from '@/components/ui/lists/Item';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Modal } from '@/modal';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import type { LocalServiceSetupConsentReview } from './localServiceActionAdmission';

const NO_CHANGE = () => {};

/**
 * A Service intent joins the existing Scripts preparation owner and its retained review. Remember
 * resumes that preparation, not the Service; only its actual completion releases the original intent.
 * This component is mounted only after an explicit Start/Restart asks for Setup consent.
 */
export function LocalServiceSetupConsentContinuation(props: Readonly<{
    review: LocalServiceSetupConsentReview;
    binding: ServerCredentialAccountScopeBinding;
    runtimeActionExecute: RuntimeActionExecute;
    onComplete: (accepted: boolean) => void;
    testID: string;
}>): React.ReactElement | null {
    const source = props.review.target.workspace;
    const workspace = React.useMemo(() => source ? { ...source,
        serverId: resolveServerProfileScopeIdForIdentifier(source.serverId) } : null, [source]);
    React.useEffect(() => { if (!workspace) props.onComplete(false); }, [props.onComplete, workspace]);
    if (!workspace) return null;
    return <RetainedSetupContinuation {...props} workspace={workspace} />;
}

function RetainedSetupContinuation(props: Parameters<typeof LocalServiceSetupConsentContinuation>[0] & Readonly<{
    workspace: NonNullable<LocalServiceSetupConsentReview['target']['workspace']>;
}>): React.ReactElement | null {
    // The supplied dispatcher is already the host's Action front door. Preserve its typed failure
    // envelope while adapting its unwrapped success to the established Project Action client.
    const execute = React.useMemo<NonNullable<Parameters<typeof useProjectScriptsController>[3]>['execute']>(() =>
        async (actionId, input, context) => {
            const value = await props.runtimeActionExecute({ actionId, input, context: context ?? {} });
            const failure = ActionExecuteFailureSchema.safeParse(value);
            return failure.success ? failure.data : { ok: true, result: value };
        }, [props.runtimeActionExecute]);
    const controller = useProjectScriptsController(props.workspace, NO_CHANGE, props.binding, { execute });
    const [operationId, setOperationId] = React.useState<string | null>(null);
    const started = React.useRef(false);
    const decline = React.useCallback(() => props.onComplete(false), [props.onComplete]);
    React.useEffect(() => {
        if (started.current) return;
        started.current = true;
        if (!props.binding.isCurrent() || props.review.signal?.aborted || props.binding.serverId !== props.workspace.serverId) {
            decline();
            return;
        }
        void controller.prepare().then(result => {
            if (!props.binding.isCurrent() || props.review.signal?.aborted) return;
            if (result && 'operation' in result) {
                setOperationId(result.operation.operationId);
                return;
            }
            const settled = ProjectPrepareNoLaunchResultV1Schema.safeParse(result);
            if (settled.success) props.onComplete(settled.data.kind !== 'skippedForInvocation');
            else {
                Modal.alert(t('common.error'), t('approvals.decisionError'));
                decline();
            }
        });
    }, [controller.prepare, decline, props.binding, props.onComplete, props.review.signal, props.workspace.serverId]);
    const operation = controller.retainedOperation?.snapshot.operationId === operationId ? controller.retainedOperation : null;
    React.useEffect(() => {
        if (!operation || !props.binding.isCurrent() || props.review.signal?.aborted
            || operation.snapshot.scope.accountId !== props.binding.accountId) return;
        if (operation.snapshot.state === 'failed' || operation.snapshot.state === 'cancelled') {
            decline();
        } else if (operation.snapshot.state === 'succeeded' && operation.observation === 'available') {
            const result = ProjectPrepareNoLaunchResultV1Schema.safeParse(operation.snapshot.result);
            if (result.success) props.onComplete(result.data.kind !== 'skippedForInvocation');
        }
    }, [decline, operation, props.binding, props.onComplete, props.review.signal]);
    if (controller.approvalId) return <AttentionBanner
        testID={`${props.testID}-setup-approval`}
        tone="neutral"
        title={t('approvals.title')}
        description={t('approvals.status.open')}
    />;
    if (!operation) return null;
    if (operation.snapshot.setupReview) return <ProjectSetupConsentReviewCard
        operation={operation}
        scope={{ serverId: props.binding.serverId, accountId: props.binding.accountId }}
        decided={null}
        canApprovePermissions={props.binding.isCurrent()}
        signal={props.review.signal}
        onDecided={NO_CHANGE}
        onDeclined={decline}
        testID={`${props.testID}-setup-review`}
    />;
    return <Item
        testID={`${props.testID}-setup-operation`}
        title={operation.snapshot.title}
        subtitle={describeActionOperationStatusLabel(resolveActionOperationStatus(operation.snapshot, operation.observation).label)}
        onPress={() => openActionOperationDetail({ serverId: operation.serverId, operationId: operation.snapshot.operationId })}
    />;
}
