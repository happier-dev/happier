import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { t } from '@/text';
import { RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES, type ScmOperationErrorCode } from '@happier-dev/protocol/scm/operationError';
import { CheckoutUnreachableState, useAnnouncedCheckoutMachine, useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { MANAGED_POWER_REQUIRED } from '@happier-dev/protocol/machines/managed/managedRefusalCodeV1';
import { ManagedWorkspaceStoppedState } from '@/components/workspaces/reachability/ManagedWorkspaceStoppedState';
import { useManagedMachineName } from '@/components/approvals/approvalReferenceReading';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { formatActionFailureDetails } from '@/utils/errors/alertActionFailure';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

function sanitizeDetails(details: string | null): string | null {
    if (!details) return null;
    const trimmed = details.trim();
    if (!trimmed) return null;
    if (trimmed === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE || trimmed === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND) {
        return null;
    }
    if (trimmed.includes('\n')) {
        return null;
    }
    if (/(^|\s)(fatal:|error:|remote:|hint:|usage:)/i.test(trimmed)) {
        return null;
    }
    return trimmed.length > 220 ? `${trimmed.slice(0, 220)}…` : trimmed;
}

/**
 * Map the snapshot/RPC error onto a user-facing body string.
 *
 * Branch on the structured errorCode first (single source of truth) and only fall back to the
 * raw `details` string for legacy callers that don't pass an errorCode. The previous behavior
 * matched the literal `RPC method not available` string, which mislabelled the "session has no
 * machine binding" case (sessionScm bail-out) as "daemon unreachable".
 */
function resolveBodyKey(errorCode: string | undefined, rawDetails: string): 'errors.sourceControlUnavailableForSession' | 'errors.daemonUnavailableBody' | 'errors.tryAgain' | 'deps.installNotSupported' {
    if (errorCode === SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE) {
        return 'errors.sourceControlUnavailableForSession';
    }
    if (errorCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED) {
        return 'deps.installNotSupported';
    }
    // Legacy: pre-errorCode callers — match the raw string only as a fallback.
    if (rawDetails === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE) {
        return 'errors.daemonUnavailableBody';
    }
    return 'errors.tryAgain';
}

export function SourceControlUnavailableState(props: {
    details?: string | null;
    errorCode?: ScmOperationErrorCode | string | null;
    failure?: ActionExecuteFailure;
    onRetry?: () => void;
    /**
     * Scopes this card's markers, including the Retry button's `${testID}-action`. Callers that can
     * be mounted alongside another source-control surface pass their own so the two Retry controls
     * stay distinguishable — a text locator cannot tell them apart.
     */
    testID?: string;
    /** The checkout this snapshot reads: a stopped attached workspace offers Start, as Files does. */
    workspaceScope?: WorkspaceScopeBase | null;
}): React.ReactElement {
    // Under a checkout whose machine isn't answering, source control waits with it: one state, said by the page.
    const reachability = useCheckoutReachability(useAnnouncedCheckoutMachine());
    const trimmedDetails = typeof props.details === 'string' ? props.details.trim() : '';
    const errorCode = typeof props.errorCode === 'string' && props.errorCode.length > 0 ? props.errorCode : undefined;
    const details = sanitizeDetails(props.details ?? null);

    const workspace = props.workspaceScope?.workspace;
    const workspaceName = useManagedMachineName(workspace ? props.workspaceScope!.serverId : null, workspace?.managedId ?? null);

    if (reachability.unreachable) {
        return <CheckoutUnreachableState reachability={reachability} testID={`${props.testID ?? 'source-control-unavailable'}-unreachable`} />;
    }
    // A stopped workspace is not a source-control failure: the same stopped state and Start as Files (lab project-stopped).
    if (errorCode === MANAGED_POWER_REQUIRED) {
        return <ManagedWorkspaceStoppedState testID={`${props.testID ?? 'source-control-unavailable'}-stopped`}
            workspaceName={workspaceName} reason={t('files.pane.managedStoppedChangesReason')}
            workspaceScope={props.workspaceScope ?? null} onStarted={props.onRetry} />;
    }
    const fallback = t(resolveBodyKey(errorCode, trimmedDetails));
    const reason = errorCode === SCM_OPERATION_ERROR_CODES.INVALID_PATH
        ? getScmUserFacingError({ errorCode, fallback })
        : fallback;
    return (
        <SurfaceStateCard
            testID={props.testID ?? 'source-control-unavailable'}
            kind="error"
            title={t('errors.sourceControlUnavailableTitle')}
            reason={reason}
            diagnosticCode={errorCode ?? details}
            diagnosticDetail={props.failure ? formatActionFailureDetails({ code: props.failure.errorCode,
                context: Object.fromEntries(presentActionExecutionFailure(props.failure).technicalDetails.map(({ key, value }) => [key, value])),
            }) : errorCode ? details : undefined}
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
        />
    );
}
