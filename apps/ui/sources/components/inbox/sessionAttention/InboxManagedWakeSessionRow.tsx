import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { getAgentCore } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { submitPendingActivationRequest } from '@/components/sessions/pending/pendingActivationRequest';
import { sendPendingMessageWithIntent } from '@/components/sessions/pending/pendingMessageSendActions';
import { canUseDirectPendingDeliveryActions, getPendingDeliveryBlockedReasonPresentation,
    resolvePendingMessagesPresentation } from '@/components/sessions/pending/pendingMessageVisualState';
import { useSessionManagedWakePresentation } from '@/components/sessions/pending/useSessionManagedWakePresentation';
import { describeManagedWakeLabel } from '@/components/sessions/pending/ManagedWakePopover';
import { useManagedWakeRecovery } from '@/components/sessions/pending/useManagedWakeRecovery';
import { useSessionPendingActivationPresentation } from '@/components/sessions/pending/useSessionPendingActivationPresentation';
import { presentSessionContinuationFailure } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { readManagedWakeAuthorization } from '@/sync/domains/pending/managedWakeProjection';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { readSessionPresentationControl, type SessionPresentationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { useActiveServerAccountScopeLifetime, useSessionPendingMessages } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

/** Failed pending input, wake and continuation use the shared Session recovery presenters. */
export function hasInboxSessionRecovery(session: SessionPresentationRecord): boolean {
    return (session.pendingBlockedCount ?? 0) > 0
        || readManagedWakeAuthorization(session)?.status === 'failed'
        || session.active === false && presentSessionContinuationFailure(session.lastRuntimeIssue) !== null;
}

type RowRender = (wake: Readonly<{ sentence: string | null; retry: React.ReactNode }>) => React.ReactElement;

/**
 * A failed input's row, lab `b-inbox` I/Ip: the shared owner's reason replaces the context line. Retained input and failed wakes
 * offer Retry; an unavailable continuation offers Open for the composer's new-Session recovery. Mounted only on its
 * own Home, so the reads below (pending input, managed observation) run only while the row is drawn.
 */
export function InboxManagedWakeSessionRow(props: Readonly<{
    session: SessionPresentationRecord;
    serverId: string;
    render: RowRender;
}>) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const sameHome = Boolean(lifetime && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, props.serverId));
    if (!sameHome) return props.render({ sentence: null, retry: null });
    return <ActiveHomeManagedWakeRow {...props} />;
}

function ActiveHomeManagedWakeRow(props: Readonly<{ session: SessionPresentationRecord; serverId: string; render: RowRender }>) {
    const { session, serverId } = props;
    const lifetime = useActiveServerAccountScopeLifetime();
    const pending = useSessionPendingMessages(session.id);
    React.useEffect(() => {
        if (!pending.isLoaded) fireAndForget(sync.fetchPendingMessages(session.id), { tag: 'InboxManagedWakeSessionRow.fetchPendingMessages' });
    }, [pending.isLoaded, session.id]);
    const reachability = useSessionMachineReachability(session.id, serverId);
    const wake = useSessionManagedWakePresentation({ session, accountLifetime: lifetime,
        machineReachable: reachability.machineReachability === 'unknown' ? null : reachability.machineReachable,
        pendingMessages: pending.messages, pendingLoaded: pending.isLoaded, pendingReadState: pending.readState });
    const { authorization, observation } = wake;
    const controllerName = useServerScopedMachine(serverId,
        observation.machine?.controller?.machineId ?? authorization?.managedWakeTargetV1?.controller?.machineId ?? '',
        machine => machine ? getMachineSentenceName(machine) : null);
    const metadata = readSessionOwnerMetadataView(session);
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    const agentCore = agentId ? getAgentCore(agentId) : null;
    const canWrite = session.access?.capabilities.submitAgentInput === true;
    const { presentation, deliveryFailure, managedWakeProjection } = useSessionPendingActivationPresentation({
        sessionId: session.id, session, ownerMetadata: metadata,
        machineReachable: reachability.machineReachability === 'unknown' ? null : reachability.machineReachable,
        canWrite,
        pendingMessages: pending.messages,
        managedWakeProjection: wake.projection,
    });
    const blockedMessage = resolvePendingMessagesPresentation(pending.messages, { session }).blockedMessage;
    const blockedReason = blockedMessage ? getPendingDeliveryBlockedReasonPresentation(blockedMessage, false, session) : null;
    const sentence = deliveryFailure?.message ?? (blockedReason ? blockedReason.message ?? t(blockedReason.labelKey) : null)
        ?? (managedWakeProjection ? describeManagedWakeLabel(managedWakeProjection, {
        controllerName: controllerName ?? t('common.machine'),
        machineName: observation.machine?.launch.name ?? t('common.machine'),
        homeName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId),
        agentName: agentCore ? t(agentCore.displayNameKey) : formatAgentLikeIdForDisplay(agentId),
    }) : null);
    // Both routes consume the retained-input owners: confirmed direct delivery or the wake banner's recovery.
    const retry = presentation?.primaryAction === 'process_when_online' ? 'rearm' as const
        : presentation?.primaryAction === 'retry' || presentation?.primaryAction === 'resume' ? presentation.primaryAction
        : !deliveryFailure && blockedMessage && canWrite
            && canUseDirectPendingDeliveryActions(blockedMessage, undefined, session) ? 'send' as const : null;
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);
    const approval = useActionApprovalContinuation({ scopeKey: `inbox-wake:${serverId}:${session.id}`, serverId, onExecuted: noop });
    const [busy, setBusy] = React.useState(false);
    const open = React.useCallback(async () => {
        if (!lifetime?.isCurrent()) return;
        await actionExecutor.execute('session.open', { sessionId: session.id, serverId }, {
            serverId, expectedAccountId: lifetime.scope.accountId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        });
    }, [actionExecutor, lifetime, serverId, session.id]);
    const resume = React.useCallback(async () => {
        if (!lifetime?.isCurrent()) return false;
        const result = await actionExecutor.execute('session.open', { sessionId: session.id, serverId, intent: 'resume' }, {
            serverId, expectedAccountId: lifetime.scope.accountId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        });
        if (!result.ok && lifetime.isCurrent()) Modal.alert(t('common.error'), t('session.resumeFailed'));
        return result.ok;
    }, [actionExecutor, lifetime, serverId, session.id]);
    const recover = useManagedWakeRecovery({ accountLifetime: lifetime, authorization, presentation,
        actionExecutor, busy, setBusy, requestApproval: approval.requestApproval, onResume: resume, onWithdraw: noopWithdraw });
    const resend = React.useCallback(async () => {
        if (!lifetime?.isCurrent() || !blockedMessage) return;
        await sendPendingMessageWithIntent({ sessionId: session.id, serverId, expectedAccountId: lifetime.scope.accountId,
            executor: actionExecutor, isCurrent: () => lifetime.isCurrent(), session: readSessionPresentationControl(session),
            message: blockedMessage, deliveryIntent: 'interrupt_and_send' });
    }, [actionExecutor, blockedMessage, lifetime, serverId, session]);
    const rearm = React.useCallback(async () => {
        const row = presentation?.row;
        if (!lifetime?.isCurrent() || !row?.localId || busy) return;
        const cancellation = new AbortController();
        const retirement = lifetime.onRetire(() => cancellation.abort());
        setBusy(true);
        try {
            await submitPendingActivationRequest({ actionExecutor, lifetime, sessionId: session.id, row: { ...row, localId: row.localId },
                action: 'process_when_online', signal: cancellation.signal, onApprovalPending: approval.requestApproval });
        } catch {
            if (lifetime.isCurrent()) Modal.alert(t('common.error'), t('session.pendingMessages.errors.sendFailed'));
        } finally {
            retirement.dispose();
            if (lifetime.isCurrent()) setBusy(false);
        }
    }, [actionExecutor, approval.requestApproval, busy, lifetime, presentation?.row, session.id]);
    return props.render({
        sentence,
        retry: deliveryFailure?.recovery === 'new_session' ? (
            <View style={styles.actions}>
                <RoundButton testID={`inbox.session.${session.id}.wake_open`} size="small" display="secondary"
                    title={t('common.open')} action={open} />
            </View>
        ) : retry === null ? null : (
            <View style={styles.actions}>
                <RoundButton testID={`inbox.session.${session.id}.wake_retry`} size="small" display="secondary"
                    title={t('common.retry')} disabled={busy}
                    action={retry === 'send' ? resend : retry === 'rearm' ? rearm : () => recover(retry)} />
            </View>
        ),
    });
}

const noop = () => {};
const noopWithdraw = async (_row: PendingMessage) => {};

const styles = StyleSheet.create(() => ({
    actions: { flexDirection: 'row', alignItems: 'center' },
}));
