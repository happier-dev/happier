import * as React from 'react';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { useBoundBrowserOpenOperation } from '@/components/browser/streamed/useBrowserOpenFirstUse';
import { describeBrowserSandboxAllowance, useBrowserSandboxAllowance } from '@/components/browser/streamed/useBrowserSandboxAllowance';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { Item } from '@/components/ui/lists/Item';
import { allowBrowserSandbox, readBrowserOpenAcceptance, type BrowserOpenFirstUseScope, type BrowserOpenOperationState } from '@/sync/domains/browser/firstUse/browserFirstUse';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { ActionOperationGetV1RequestSchema } from '@happier-dev/protocol/actions/operations/v1';
import { presentFailure as presentActionOperationFailure } from '@/components/inbox/actionOperations/actionOperationDetailPresentation';
import { describeActionOperationStatusLabel, resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { t } from '@/text';

/** What each state of the open reads as: the same words the Session Browser uses for the same state. */
export function describeBrowserOpenOperation(state: BrowserOpenOperationState): Readonly<{ text: string; active: boolean }> {
    switch (state.kind) {
        case 'preparing': return { text: t('browserPresence.stream.preparingTitle'), active: true };
        case 'connecting': return { text: t('browserPresence.stream.openingPage'), active: true };
        case 'opened': return { text: t('browserPresence.stream.pageOpened'), active: false };
        case 'installFailed': return { text: resolveReasonCopy({ reasonCode: 'browser_runtime_provisioning_failed', kind: 'browserLaunchpad' }).body, active: false };
        case 'sandboxUnavailable': return { text: resolveReasonCopy({ reasonCode: 'sandbox_unavailable', kind: 'browserLaunchpad' }).body, active: false };
        case 'failed': return { text: resolveReasonCopy({ reasonCode: state.code, kind: 'browserLaunchpad' }).body, active: false };
    }
}

/** The open an approved request accepted, bound to its Home, Account and Machine; null for any other request. */
function useBrowserOpenOperationOfRequest(request: ApprovalRequest, serverId: string | null): Readonly<{
    state: BrowserOpenOperationState | null;
    /** The exact Home, Account, Machine and Session the open ran for, when the request names them all. */
    scope: BrowserOpenFirstUseScope | null;
}> {
    const acceptance = readBrowserOpenAcceptance(request);
    const origin = request.v === 2 ? request.executionOriginV1 : null;
    // The Machine the open ran on and the Account that asked: the origin names them, else the Home's bound Account.
    const machineId = origin?.machineId ?? (origin?.target?.kind === 'machine' ? origin.target.machineId : null);
    const resolution = useServerCredentialAccountScopeResolution(serverId);
    const accountId = origin?.accountId ?? (resolution.kind === 'bound' ? resolution.scope.accountId : null);
    // Operations are keyed by the Home's scope id, not by this device's profile id for it.
    const operationServerId = serverId ? resolveServerProfileScopeIdForIdentifier(serverId) : null;
    const sessionId = origin?.sessionId ?? request.createdBy.sessionId ?? null;
    const state = useBoundBrowserOpenOperation(acceptance && machineId && accountId && operationServerId
        ? { serverId: operationServerId, accountId, machineId, operationId: acceptance.operationId }
        : null);
    const scope = React.useMemo(() => (operationServerId && accountId && machineId && sessionId
        ? { serverId: operationServerId, accountId, machineId, sessionId } : null),
        [accountId, machineId, operationServerId, sessionId]);
    return { state, scope };
}

const executeSandboxInstall = createFrontDoorActionExecute();

/**
 * The same "Allow the browser sandbox" press the Session Browser offers, as the row that follows the
 * open's sandbox-unavailable reason: one control, one Action, one set of words for its outcome.
 */
function BrowserSandboxAllowRow(props: Readonly<{ scope: BrowserOpenFirstUseScope | null; testID: string }>): React.ReactElement | null {
    const { scope } = props;
    const onAllow = React.useMemo(() => (scope ? () => allowBrowserSandbox(executeSandboxInstall, scope) : undefined), [scope]);
    const { allowance, allow } = useBrowserSandboxAllowance(onAllow);
    if (allowance.kind === 'settled' && allowance.outcome.status === 'installed') {
        return <Item testID={props.testID} title={describeBrowserSandboxAllowance(allowance.outcome).title} mode="info" showChevron={false} />;
    }
    if (!allow) return null;
    const settled = allowance.kind === 'settled' ? describeBrowserSandboxAllowance(allowance.outcome) : null;
    return (
        <Item
            testID={props.testID}
            title={t('browserPresence.stream.sandboxAllow')}
            subtitle={settled?.reason}
            subtitleLines={0}
            loading={allowance.kind === 'working'}
            onPress={allow}
        />
    );
}

/**
 * The live state of an approved Browser open whose receipt carries provisioning acceptance. The
 * request's `executed` only means the open was accepted; this row shows where the open stands:
 * preparing, then connecting, then opened or failed. It renders nothing for any other request.
 */
export function BrowserOpenOperationStatusRow(props: Readonly<{
    request: ApprovalRequest;
    /** The Home the request was made in, as this device knows it. */
    serverId: string | null;
    testID: string;
}>): React.ReactElement | null {
    const { state, scope } = useBrowserOpenOperationOfRequest(props.request, props.serverId);
    if (!state) return null;
    const { text, active } = describeBrowserOpenOperation(state);
    return (
        <>
            <Item
                testID={props.testID}
                // The receipt above reads Executed (the open was accepted); this row is where the open stands.
                title={t('browserSurface.title')}
                subtitle={text}
                subtitleLines={0}
                mode="info"
                showChevron={false}
                rightElement={active ? <ActivitySpinner size="small" /> : undefined}
            />
            {state.kind === 'sandboxUnavailable' ? <BrowserSandboxAllowRow scope={scope} testID={`${props.testID}-allow-sandbox`} /> : null}
        </>
    );
}

/**
 * The detached Action operation an executed request accepted (a managed Create or Delete, for example): its
 * result names the operation, and `executed` then only means the work was admitted. Null for any other request.
 */
export function readApprovalAcceptedOperationId(request: ApprovalRequest): string | null {
    if (request.status !== 'executed' || request.execution?.ok !== true || readBrowserOpenAcceptance(request)) return null;
    const result = request.execution.result;
    const operation = result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Readonly<Record<string, unknown>>).operation : undefined;
    const parsed = ActionOperationGetV1RequestSchema.safeParse(operation);
    return parsed.success ? parsed.data.operationId : null;
}

/** Where that operation stands, in the words the operation's own Activity row uses; null until it is read. */
function useApprovalAcceptedOperation(request: ApprovalRequest, serverId: string | null): Readonly<{
    title: string; text: string; active: boolean;
}> | null {
    const operationId = readApprovalAcceptedOperationId(request);
    // Operations are keyed by the Home's scope id, not by this device's profile id for it.
    const operationServerId = operationId && serverId ? resolveServerProfileScopeIdForIdentifier(serverId) : null;
    const operation = useActionOperation({ serverId: operationServerId, operationId: operationId ?? '' });
    if (!operation) return null;
    const status = resolveActionOperationStatus(operation.snapshot, operation.observation);
    const label = describeActionOperationStatusLabel(status.label);
    const failure = operation.snapshot.state === 'failed' ? presentActionOperationFailure(operation.snapshot) : null;
    return { title: operation.snapshot.title, text: failure ? `${label} · ${failure.reason}` : label, active: status.tone === 'active' };
}

/**
 * The live state of the operation an executed request accepted: the receipt above reads Executed (it was
 * admitted); this row follows the work until it succeeds, fails or is cancelled. Nothing for any other request.
 */
export function ApprovalAcceptedOperationStatusRow(props: Readonly<{
    request: ApprovalRequest;
    serverId: string | null;
    testID: string;
}>): React.ReactElement | null {
    const operation = useApprovalAcceptedOperation(props.request, props.serverId);
    if (!operation) return null;
    return (
        <Item
            testID={props.testID}
            title={operation.title}
            subtitle={operation.text}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            rightElement={operation.active ? <ActivitySpinner size="small" /> : undefined}
        />
    );
}

/**
 * The same open in the transcript: its card stays while the open is preparing, connecting or has
 * failed, and leaves once the page has opened, since the page is then the answer.
 */
export function BrowserOpenApprovalProgress(props: Readonly<{
    request: ApprovalRequest;
    serverId: string | null;
    title: string;
    chrome: 'card' | 'inline';
    headerAccessory?: React.ReactNode;
}>): React.ReactElement | null {
    const { state } = useBrowserOpenOperationOfRequest(props.request, props.serverId);
    if (!state || state.kind === 'opened') return null;
    return (
        <ApprovalPromptChrome
            testID="approval-prompt-browser-open"
            chrome={props.chrome}
            icon="browsers"
            title={props.title}
            subtitle={describeBrowserOpenOperation(state).text}
            titleNumberOfLines={1}
            subtitleNumberOfLines={3}
            headerAccessory={props.headerAccessory}
        />
    );
}
