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
import { InboxWorkRow } from '../InboxWorkRow';
import { InboxRelativeTime } from '../InboxRelativeTime';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { readInboxSessionTitle } from '@/components/inbox/sessionAttention/inboxSessionPrivacy';

import type { InboxItemFocus } from '../inboxItemFocus';
import { InboxSessionRowMenu } from './InboxSessionRowMenu';
import { buildInboxSessionContextLine } from './inboxSessionContextLine';

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
    spansHomes: boolean;
    workflowServerId: string | null;
    settle: InboxModel['settle'];
    setReminder: InboxModel['setReminder'];
    identityDisplay: SessionListIdentityDisplay;
    presentation: 'screen' | 'popover';
    navigate: (route: string) => void;
    onBeforeNavigate?: () => void;
    /** The item the person came to see (`/inbox?item=`): its row is drawn selected. */
    focused?: boolean;
    /** Beside the Inbox's detail pane a row selects its item there instead of leaving the Inbox. */
    onSelectItem?: (focus: InboxItemFocus) => void;
}>;

/**
 * One row of a work group (lab `inbox-I1`). Permission and question requests keep the canonical
 * answer card — the Inbox is one of the three places a request is answered (ORC S-1); every other
 * row states what waits and opens its home. Rows never tint by ancestry.
 */
export const InboxWorkItemRow = React.memo(function InboxWorkItemRow(props: RowProps) {
    const { theme } = useUnistyles();
    const { item } = props;
    const nowMs = Date.now();
    const page = props.presentation === 'screen';
    // Phones keep only a small control right of a label (lab `phone-P4`); the row press opens.
    const wide = useIsTablet();
    // The state word has its own column only on the wide page. A phone and the rail popover give the
    // title the row's width (lab `inbox-I2`): there the state leads the line under it, never
    // truncating the name that tells this row from its siblings.
    const statusColumn = page && wide;
    const glyph = (name: IconName, color: string = theme.colors.text.secondary) => (
        <Icon name={name} size={18} color={color} />
    );
    // One opener per row: select into the detail pane when there is one and the item's Home is known,
    // otherwise open the item's own page.
    const openItem = (focus: InboxItemFocus | null, route: string | null) => {
        if (focus && props.onSelectItem) props.onSelectItem(focus);
        else if (route) props.navigate(route);
    };
    const sessionFocus = (id: string, serverId: string | null): InboxItemFocus | null => (
        serverId ? { kind: 'session', serverId, id } : null
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
                <InboxWorkRow
                    testID={`inbox.session.${candidate.sessionId}`}
                    selected={props.focused === true}
                    title={candidate.title}
                    facts={[
                        item.foldedUnderRunId ? t('inbox.work.rows.step') : null,
                        buildInboxSessionContextLine(candidate, { showHome: props.spansHomes }),
                    ]}
                    time={<InboxRelativeTime timestamp={resolveSessionListRenderableMeaningfulActivityAt(candidate.session)} />}
                    status={status}
                    inlineStatus={!statusColumn}
                    mark={failed
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
                    trailingAccessory={page ? <InboxSessionRowMenu session={candidate.session} settle={props.settle} setReminder={props.setReminder} /> : undefined}
                    onPress={() => openItem(sessionFocus(candidate.sessionId, serverId), candidate.route ?? null)}
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
            const runServerId = props.workflowServerId;
            const open = () => openItem(
                runServerId ? { kind: 'workflow_run', serverId: runServerId, id: item.runId } : null,
                createWorkflowRunRoute(item.runId),
            );
            // The row is titled by the run; its state is the row's one status: in the status column on
            // the wide page, otherwise leading the line under the title in place of the kind label, so
            // the line stays one line and its time is never orphaned on a second.
            return (
                <InboxWorkRow
                    testID={`inbox.run.${item.runId}`}
                    selected={props.focused === true}
                    title={name}
                    facts={statusColumn || !status ? [t('inbox.work.rows.workflowRun')] : []}
                    time={<InboxRelativeTime timestamp={item.row.updatedAt} />}
                    status={status}
                    inlineStatus={!statusColumn}
                    mark={glyph('hand')}
                    // The inline answer (lab `inbox-I2`): a bordered Review wherever there is room for
                    // one beside the title; a phone page keeps the row press.
                    trailingAccessory={!page || wide ? (
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
                <InboxWorkRow
                    testID={`inbox.stalled.${session.id}`}
                    selected={props.focused === true}
                    title={readInboxSessionTitle(session, sessionServerId(session))}
                    facts={[t('inbox.work.rows.stalled'), t('inbox.work.rows.stalledReason')]}
                    status={status}
                    inlineStatus={!statusColumn}
                    mark={glyph('cloud-slash', theme.colors.state.warning.foreground)}
                    trailingAccessory={page ? <InboxSessionRowMenu session={session} settle={props.settle} setReminder={props.setReminder} /> : undefined}
                    onPress={() => openItem(sessionFocus(session.id, sessionServerId(session)), createActivitySurfaceSessionRoute(session.id, sessionServerId(session)))}
                />
            );
        }
        case 'landing': {
            const { session, link } = item;
            return (
                <InboxWorkRow
                    testID={`inbox.landing.${session.id}`}
                    selected={props.focused === true}
                    title={link.title ? `#${link.number} ${link.title}` : `#${link.number}`}
                    facts={[t('inbox.work.rows.landing'), readInboxSessionTitle(session, sessionServerId(session))]}
                    mark={glyph('git-pull-request')}
                    trailingAccessory={(
                        <RoundButton
                            testID={`inbox.landing.${session.id}.settle`}
                            size="small"
                            display="secondary"
                            title={t('inbox.work.rows.settle')}
                            action={() => props.settle(session)}
                        />
                    )}
                    onPress={() => openItem(sessionFocus(session.id, sessionServerId(session)), createActivitySurfaceSessionRoute(session.id, sessionServerId(session)))}
                />
            );
        }
        case 'snoozed': {
            const session = item.session;
            return (
                <InboxWorkRow
                    testID={`inbox.snoozed.${session.id}`}
                    selected={props.focused === true}
                    title={readInboxSessionTitle(session, sessionServerId(session))}
                    phase="finished"
                    facts={[t('inbox.work.rows.snoozedUntil', {
                        time: formatSessionAttentionReminderDateTime(item.remindAt, nowMs),
                    })]}
                    mark={glyph('clock', theme.colors.text.tertiary)}
                    trailingAccessory={page ? <InboxSessionRowMenu session={session} settle={props.settle} setReminder={props.setReminder} /> : undefined}
                    onPress={() => openItem(sessionFocus(session.id, sessionServerId(session)), createActivitySurfaceSessionRoute(session.id, sessionServerId(session)))}
                />
            );
        }
    }
});
