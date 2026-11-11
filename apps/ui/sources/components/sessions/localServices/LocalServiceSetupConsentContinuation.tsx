import * as React from 'react';
import type { FrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ProjectPrepareNoLaunchResultV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';

import type { ProjectSetupScope } from '@/components/projects/projectSetup/ProjectSetupReview';
import { useProjectSetupMachine } from '@/components/projects/projectSetup/useProjectSetupMachine';
import { useProjectScriptsController } from '@/components/projects/projectSetup/useProjectScriptsController';
import { describeActionOperationStatusLabel, resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { Item } from '@/components/ui/lists/Item';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Modal } from '@/modal';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import type { LocalServiceSetupConsentReview } from './localServiceActionAdmission';
import { LocalServiceSetupConsentCard } from './LocalServiceSetupConsentCard';

const NO_CHANGE = () => {};

/**
 * A Service intent joins the existing Scripts preparation owner and its retained review, and decides
 * it the way the Scripts setup review does (`prepare(digest, scope)`): This time runs setup once and
 * remembers nothing, Until it changes remembers the reviewed effect and resumes the held setup. Only
 * the setup's actual completion releases the original intent.
 * This component is mounted only after an explicit Start/Restart asks for Setup consent.
 */
export function LocalServiceSetupConsentContinuation(props: Readonly<{
    review: LocalServiceSetupConsentReview;
    binding: ServerCredentialAccountScopeBinding;
    runtimeActionExecute: FrontDoorRuntimeActionExecutor;
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
    const router = useRouter();
    const controller = useProjectScriptsController(props.workspace, NO_CHANGE, props.binding,
        { execute: props.runtimeActionExecute.actionExecute });
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
    const stop = useActionOperationStopControl(operation);
    React.useEffect(() => {
        if (!stop.pending && stop.feedback !== null) decline();
    }, [decline, stop.feedback, stop.pending]);
    const attachment = operation?.snapshot.domainRef?.kind === 'projectCommand' ? operation.snapshot.domainRef : null;
    const { machineName, sharedRunAs } = useProjectSetupMachine(
        attachment?.serverId ?? props.workspace.serverId,
        attachment?.machineId ?? props.workspace.machineId,
    );
    const decide = React.useCallback(async (digest: string, scope: ProjectSetupScope) => {
        const result = await controller.prepare(digest, scope);
        if (!props.binding.isCurrent() || props.review.signal?.aborted) return;
        if (result && 'operation' in result) {
            setOperationId(result.operation.operationId);
            return;
        }
        // Remembered results carry an operation and are handled above; continued waits for its completion.
        if (result && 'kind' in result && result.kind === 'continued') return;
        const settled = ProjectPrepareNoLaunchResultV1Schema.safeParse(result);
        if (settled.success) props.onComplete(settled.data.kind !== 'skippedForInvocation');
        else Modal.alert(t('common.error'), t('approvals.decisionError'));
    }, [controller.prepare, props.binding, props.onComplete, props.review.signal]);
    // What waits on the person, with its one way in: the shared approval-pending notice the Service entry's own
    // approvals use (PATTERN-AUDIT-UI-1111 E), not a local banner.
    if (controller.approvalId) return <ActionApprovalPendingNotice
        presentation="line"
        testID={`${props.testID}-setup-approval`}
        message={t('approvals.waitingForYou')}
        summary={controller.approvalSummary}
        onOpenApproval={() => router.push(buildApprovalHref(controller.approvalId!, props.workspace.serverId))}
    />;
    if (!operation) return null;
    const review = operation.snapshot.setupReview;
    if (review) return <LocalServiceSetupConsentCard
        testID={`${props.testID}-setup-review`}
        machineName={machineName}
        sharedRunAs={sharedRunAs}
        reviewedEffect={review.reviewedEffect}
        initialScope={review.consentScope}
        effectChanged={review.code === 'project_setup_effect_changed'}
        deciding={Boolean(controller.pendingKeys.setup) || stop.pending}
        stopping={stop.stopRequested}
        onDecide={scope => { void decide(review.reviewedEffectDigest, scope); }}
        onNotNow={stop.requestStop}
    />;
    return <Item
        testID={`${props.testID}-setup-operation`}
        title={operation.snapshot.title}
        subtitle={describeActionOperationStatusLabel(resolveActionOperationStatus(operation.snapshot, operation.observation).label)}
        onPress={() => openActionOperationDetail({ serverId: operation.serverId, operationId: operation.snapshot.operationId })}
    />;
}
