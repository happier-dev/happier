import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { getAgentCore } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { submitPendingActivationRequest } from '@/components/sessions/pending/pendingActivationRequest';
import { useManagedPendingWakeObservation } from '@/components/sessions/pending/useManagedPendingWakeObservation';
import { useManagedWakeRecovery } from '@/components/sessions/pending/useManagedWakeRecovery';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { readManagedWakeAuthorization } from '@/sync/domains/pending/managedWakeProjection';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { SessionPresentationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useMachineListStatusForServer, useServerScopedMachine, useSocketStatus } from '@/sync/domains/state/storage';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { useActiveServerAccountScopeLifetime, useSessionPendingMessages } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { buildInboxManagedWakeRecovery } from './inboxManagedWakeRecovery';

/** True when an admitted Inbox Session row carries a failed managed wake (52s2): the row says why and offers Retry. */
export function hasFailedManagedWake(session: SessionPresentationRecord): boolean {
    return readManagedWakeAuthorization(session)?.status === 'failed';
}

type RowRender = (wake: Readonly<{ sentence: string | null; retry: React.ReactNode }>) => React.ReactElement;

/**
 * A failed wake's row, lab `b-inbox` I/Ip: the wake owner's reason replaces the context line and one Retry runs
 * the same recovery the Session composer offers. Open stays the row press. Mounted only for that row, on its
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
    const authorization = readManagedWakeAuthorization(session);
    const pending = useSessionPendingMessages(session.id);
    React.useEffect(() => {
        if (!pending.isLoaded) fireAndForget(sync.fetchPendingMessages(session.id), { tag: 'InboxManagedWakeSessionRow.fetchPendingMessages' });
    }, [pending.isLoaded, session.id]);
    const observation = useManagedPendingWakeObservation({ sessionId: session.id, authorization, accountLifetime: lifetime,
        reconnectSignal: useSocketStatus().lastConnectedAt });
    const reachability = useSessionMachineReachability(session.id, serverId);
    const inventory = useMachineListStatusForServer(serverId);
    const controllerName = useServerScopedMachine(serverId,
        observation.machine?.controller?.machineId ?? authorization?.managedWakeTargetV1?.controller?.machineId ?? '',
        machine => machine ? getMachineSentenceName(machine) : null);
    const metadata = readSessionOwnerMetadataView(session);
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    const agentCore = agentId ? getAgentCore(agentId) : null;
    const recovery = buildInboxManagedWakeRecovery({
        authorization, sessionActiveAt: session.activeAt, sessionActive: session.active,
        canWrite: session.access?.capabilities.submitAgentInput === true,
        managed: observation.machine, managedReadState: observation.kind,
        machineInventoryState: inventory === 'loading' ? 'loading' : 'read',
        machineReachable: reachability.machineReachability === 'unknown' ? null : reachability.machineReachable,
        runtimeResumingAt: null,
        pendingMessages: pending.messages, pendingLoaded: pending.isLoaded, pendingReadState: pending.readState,
        names: {
            controllerName: controllerName ?? t('common.machine'),
            machineName: observation.machine?.launch.name ?? t('common.machine'),
            homeName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId),
            agentName: agentCore ? t(agentCore.displayNameKey) : formatAgentLikeIdForDisplay(agentId),
        },
    });
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);
    const approval = useActionApprovalContinuation({ scopeKey: `inbox-wake:${serverId}:${session.id}`, serverId, onExecuted: noop });
    const [busy, setBusy] = React.useState(false);
    const resume = React.useCallback(async () => {
        if (!lifetime?.isCurrent()) return false;
        const result = await actionExecutor.execute('session.open', { sessionId: session.id, serverId, intent: 'resume' }, {
            serverId, expectedAccountId: lifetime.scope.accountId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        });
        if (!result.ok && lifetime.isCurrent()) Modal.alert(t('common.error'), t('session.resumeFailed'));
        return result.ok;
    }, [actionExecutor, lifetime, serverId, session.id]);
    const recover = useManagedWakeRecovery({ accountLifetime: lifetime, authorization, presentation: recovery?.presentation ?? null,
        actionExecutor, busy, setBusy, requestApproval: approval.requestApproval, onResume: resume, onWithdraw: noopWithdraw });
    const rearm = React.useCallback(async () => {
        const row = recovery?.presentation.row;
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
    }, [actionExecutor, approval.requestApproval, busy, lifetime, recovery?.presentation.row, session.id]);
    const retry = recovery?.retry ?? null;
    return props.render({
        sentence: recovery?.sentence ?? null,
        retry: retry === null ? null : (
            <View style={styles.actions}>
                <RoundButton testID={`inbox.session.${session.id}.wake_retry`} size="small" display="secondary"
                    title={t('common.retry')} disabled={busy}
                    action={retry === 'rearm' ? rearm : () => recover(retry)} />
            </View>
        ),
    });
}

const noop = () => {};
const noopWithdraw = async (_row: PendingMessage) => {};

const styles = StyleSheet.create(() => ({
    actions: { flexDirection: 'row', alignItems: 'center' },
}));
