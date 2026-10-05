import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { InboxSessionAttentionEntry } from '@/activity/presentation/buildInboxSessionPresentation';
import type { InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { InboxSessionAttentionGroupCard } from '@/components/inbox/sessionAttention/InboxSessionAttentionGroupCard';
import {
    SessionListIdentity,
    type SessionListIdentityDisplay,
} from '@/components/sessions/shell/SessionListIdentity';
import { SESSION_LIST_ROW_IDENTITY_METRICS } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { formatSessionAttentionReminderDateTime } from '@/components/sessions/shell/row/actionMenu/sessionAttentionReminderAction';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import {
    formatWorkflowRunDisplayName,
    resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { useIsTablet } from '@/utils/platform/responsive';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { readInboxSessionTitle } from '@/components/inbox/sessionAttention/inboxSessionPrivacy';

import { InboxSessionRowMenu } from './InboxSessionRowMenu';
import { buildInboxSessionContextLine, joinFacts } from './inboxSessionContextLine';

export function requiresInboxPromptCard(entry: InboxSessionAttentionEntry): boolean {
    return entry.candidate.personalAttention.reasons.some(
        (reason) => reason === 'permission_required' || reason === 'user_action_required',
    );
}

/** A Session's state word and tone, from the shared work-status owner (INT §5.3); never an Inbox rule. */
export function presentInboxSessionStatus(session: Session, nowMs: number): WorkStatusPresentation {
    return resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(session, nowMs) });
}



function sessionServerId(session: Session): string | null {
    return session.serverId ?? null;
}

type RowProps = Readonly<{
    item: InboxWorkItem;
    model: InboxModel;
    identityDisplay: SessionListIdentityDisplay;
    nowMs: number;
    presentation: 'screen' | 'popover';
    navigate: (route: string) => void;
    onBeforeNavigate?: () => void;
    /** The item the person came to see (`/inbox?item=`): its row is drawn selected. */
    focused?: boolean;
}>;

/**
 * One row of a work group (lab `inbox-I1`). Permission and question requests keep the canonical
 * answer card — the Inbox is one of the three places a request is answered (ORC S-1); every other
 * row states what waits and opens its home. Rows never tint by ancestry.
 */
export const InboxWorkItemRow = React.memo(function InboxWorkItemRow(props: RowProps) {
    const { theme } = useUnistyles();
    const { item, nowMs } = props;
    const page = props.presentation === 'screen';
    // Phones keep only a small control right of a label (lab `phone-P4`); the row press opens.
    const wide = useIsTablet();
    const glyph = (name: IconName, color: string = theme.colors.text.secondary) => (
        <Icon name={name} size={18} color={color} />
    );

    switch (item.kind) {
        case 'session': {
            const { entry } = item;
            const candidate = entry.candidate;
            const serverId = candidate.address?.serverId ?? candidate.serverId ?? null;
            const connected = getSessionStatus(candidate.session, nowMs, { workingTextMode: 'static' }).isConnected;
            if (requiresInboxPromptCard(entry)) {
                return (
                    <InboxSessionAttentionGroupCard
                        session={candidate.session}
                        serverId={serverId}
                        identityDisplay={props.identityDisplay}
                        connected={connected}
                        contextLine={candidate.context?.contextLine ?? null}
                        permissionRequests={entry.pendingPermissions}
                        userActionRequests={entry.pendingUserActions}
                        onBeforeNavigate={props.onBeforeNavigate}
                    />
                );
            }
            const status = presentInboxSessionStatus(candidate.session, nowMs);
            const failed = status.tone === 'danger';
            return (
                <Item
                    testID={`inbox.session.${candidate.sessionId}`}
                    selected={props.focused === true}
                    title={candidate.title}
                    subtitle={joinFacts(
                        item.foldedUnderRunId ? t('inbox.work.rows.step') : null,
                        buildInboxSessionContextLine(candidate),
                        formatShortRelativeTimeAt(candidate.session.updatedAt, nowMs),
                    )}
                    detail={status.word}
                    detailStyle={workStatusWordStyle(status.tone)}
                    density="compact"
                    leftElement={failed
                        ? glyph('warning', theme.colors.status.error)
                        : props.identityDisplay !== 'none' ? (
                            <SessionListIdentity
                                session={candidate.session}
                                display={props.identityDisplay}
                                serverId={serverId}
                                color={theme.colors.text.primary}
                                avatarSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize}
                                agentLogoSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.agentLogoSize}
                                connected={connected}
                                testID={`inbox.session.${candidate.sessionId}.identity`}
                            />
                        ) : undefined}
                    iconBoxSize={failed || props.identityDisplay !== 'none'
                        ? SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize
                        : undefined}
                    rightElement={page ? <InboxSessionRowMenu session={candidate.session} model={props.model} /> : undefined}
                    onPress={() => {
                        if (candidate.route) props.navigate(candidate.route);
                    }}
                />
            );
        }
        case 'workflow_run': {
            const summary = item.row.summary;
            const name = formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(item.row.metadata));
            // Every row here is in the server attention window; that membership sets the tone.
            const status = summary ? resolveWorkStatusTone({
                kind: 'workflow_run',
                facts: { state: summary.state, word: describeWorkflowRunState(summary.state).label, inAttentionWindow: true },
            }) : null;
            const open = () => props.navigate(createWorkflowRunRoute(item.runId));
            return (
                <Item
                    testID={`inbox.run.${item.runId}`}
                    selected={props.focused === true}
                    title={name}
                    subtitle={joinFacts(
                        t('inbox.work.rows.workflowRun'),
                        formatShortRelativeTimeAt(item.row.updatedAt, nowMs),
                    )}
                    detail={status?.word}
                    detailStyle={status ? workStatusWordStyle(status.tone) : null}
                    density="compact"
                    leftElement={glyph('hand')}
                    iconBoxSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize}
                    rightElement={page && wide ? (
                        <RoundButton
                            testID={`inbox.run.${item.runId}.review`}
                            size="small"
                            display="secondary"
                            title={t('inbox.work.rows.review')}
                            onPress={open}
                        />
                    ) : undefined}
                    onPress={open}
                />
            );
        }
        case 'stalled': {
            const session = item.session;
            const status = presentInboxSessionStatus(session, nowMs);
            return (
                <Item
                    testID={`inbox.stalled.${session.id}`}
                    selected={props.focused === true}
                    title={readInboxSessionTitle(session, sessionServerId(session))}
                    subtitle={joinFacts(t('inbox.work.rows.stalled'), t('inbox.work.rows.stalledReason'))}
                    detail={status.word}
                    detailStyle={workStatusWordStyle(status.tone)}
                    density="compact"
                    leftElement={glyph('cloud-slash', theme.colors.state.warning.foreground)}
                    iconBoxSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize}
                    rightElement={page ? <InboxSessionRowMenu session={session} model={props.model} /> : undefined}
                    onPress={() => props.navigate(createActivitySurfaceSessionRoute(session.id, sessionServerId(session)))}
                />
            );
        }
        case 'landing': {
            const { session, link } = item;
            return (
                <Item
                    testID={`inbox.landing.${session.id}`}
                    selected={props.focused === true}
                    title={link.title ? `#${link.number} ${link.title}` : `#${link.number}`}
                    subtitle={joinFacts(t('inbox.work.rows.landing'), readInboxSessionTitle(session, sessionServerId(session)))}
                    density="compact"
                    leftElement={glyph('git-pull-request')}
                    iconBoxSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize}
                    rightElement={(
                        <RoundButton
                            testID={`inbox.landing.${session.id}.settle`}
                            size="small"
                            display="secondary"
                            title={t('inbox.work.rows.settle')}
                            action={() => props.model.settle(session)}
                        />
                    )}
                    onPress={() => props.navigate(createActivitySurfaceSessionRoute(session.id, sessionServerId(session)))}
                />
            );
        }
        case 'snoozed': {
            const session = item.session;
            return (
                <Item
                    testID={`inbox.snoozed.${session.id}`}
                    selected={props.focused === true}
                    title={readInboxSessionTitle(session, sessionServerId(session))}
                    subtitle={t('inbox.work.rows.snoozedUntil', {
                        time: formatSessionAttentionReminderDateTime(item.remindAt, nowMs),
                    })}
                    density="compact"
                    leftElement={glyph('clock', theme.colors.text.tertiary)}
                    iconBoxSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize}
                    rightElement={page ? <InboxSessionRowMenu session={session} model={props.model} /> : undefined}
                    onPress={() => props.navigate(createActivitySurfaceSessionRoute(session.id, sessionServerId(session)))}
                />
            );
        }
    }
});
