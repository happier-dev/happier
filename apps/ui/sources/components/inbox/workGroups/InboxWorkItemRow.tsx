import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { InboxPluginSessionRow } from '@/components/inbox/inboxItemProjection';
import { InboxPluginSessionLines } from '@/components/inbox/InboxPluginSessionLines';
import type { InboxPluginSessionControlInvoker } from '@/hooks/inbox/useInboxPluginSessionControls';

import type { InboxSessionAttentionEntry } from '@/activity/presentation/buildInboxSessionPresentation';
import type { InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { InboxSessionAttentionGroupCard } from '@/components/inbox/sessionAttention/InboxSessionAttentionGroupCard';
import { InboxManagedWakeSessionRow, hasInboxSessionRecovery } from '@/components/inbox/sessionAttention/InboxManagedWakeSessionRow';
import {
    SessionListIdentity,
    type SessionListIdentityDisplay,
} from '@/components/sessions/shell/SessionListIdentity';
import { SESSION_LIST_ROW_IDENTITY_METRICS } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { formatSessionAttentionReminderDateTime } from '@/components/sessions/shell/row/actionMenu/sessionAttentionReminderAction';
import { describeWorkflowRunState, isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
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
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveWorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { Modal } from '@/modal';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { readInboxSessionTitle } from '@/components/inbox/sessionAttention/inboxSessionPrivacy';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { ApprovalInboxCard } from '@/components/inbox/cards/ApprovalInboxCard';
import { formatAutomationRunCauseLabel, formatAutomationRunStateLabel } from '@/components/automations/list/automationListFormatting';
import { useAutomation } from '@/sync/domains/state/storage';
import { readInboxApprovalServerId, resolveInboxItemPageRoute } from '../inboxItemFocus';

import type { InboxItemFocus } from '../inboxItemFocus';
import { InboxSessionRowMenu } from './InboxSessionRowMenu';
import { buildInboxSessionContextLine } from './inboxSessionContextLine';
import { buildInboxWorkflowReasonFacts } from './inboxWorkflowReason';
import { useOpenResource } from '@/utils/url/openResource';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { type SessionListPresentationSource, type SessionPresentationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

export function requiresInboxPromptCard(entry: InboxSessionAttentionEntry): boolean {
    return entry.candidate.personalAttention.reasons.some(
        (reason) => reason === 'permission_required' || reason === 'user_action_required',
    );
}

/** A Session's state word and tone, from the shared work-status owner (INT §5.3); never an Inbox rule. */
export function presentInboxSessionStatus(session: SessionPresentationRecord, nowMs: number,
    source?: SessionListPresentationSource): WorkStatusPresentation {
    return resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(session, nowMs, source) });
}



const NO_SESSION_ADDRESSES: readonly SessionAddress[] = [];

function sessionServerId(session: Pick<Session, 'serverId'>): string | null {
    return session.serverId ?? null;
}

/** Resolve the current held invocation on intent, never with a per-row background read. */
function InboxWorkflowRunRow(props: Readonly<{
    item: Extract<InboxWorkItem, { kind: 'workflow_run' }>;
    serverId: string | null;
    statusColumn: boolean;
    showReview: boolean;
    kindInHeader?: boolean;
    focused?: boolean;
    showDivider?: boolean;
    navigate: RowProps['navigate'];
    onSelectItem?: RowProps['onSelectItem'];
}>) {
    const { theme } = useUnistyles();
    const { item, serverId } = props;
    const pending = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => { pending.current?.abort(); pending.current = null; }, [item.runId, serverId]);
    const open = async () => {
        if (pending.current !== null) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !selectActiveServerAccountScopeForServer(lifetime.scope, serverId)) return;
        const controller = new AbortController();
        pending.current = controller;
        const retirement = lifetime.onRetire(() => controller.abort());
        try {
            const result = await workflowRunDetailActions.listInvocations({
                runId: item.runId, lifecycles: ['waiting_for_review'], limit: 1, includeContent: false,
            }, controller.signal);
            if (controller.signal.aborted || !lifetime.isCurrent()) return;
            const invocationId = result.invocations[0]?.id;
            const focus: InboxItemFocus = { kind: 'workflow_run', serverId: lifetime.scope.serverId, id: item.runId,
                ...(invocationId ? { invocationId } : {}) };
            if (props.onSelectItem) props.onSelectItem(focus);
            else props.navigate(resolveInboxItemPageRoute(focus));
        } catch (error) {
            if (!controller.signal.aborted && lifetime.isCurrent()) {
                const problem = resolveWorkflowProblemPresentation(error);
                await Modal.alert(problem.title, problem.message);
            }
        } finally {
            retirement.dispose();
            if (pending.current === controller) pending.current = null;
        }
    };
    const summary = item.row.summary;
    const status = summary ? resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(summary) }) : null;
    // Only a Run that still waits is reviewed; a stopped or finished one is opened, and says which by its
    // own state mark (the same ended glyph the Run page draws), never the hold's hand (DESIGN-14 D8).
    const settled = summary !== undefined && summary !== null && isTerminalWorkflowRunState(summary.state);
    const settledMarker = settled && summary ? describeWorkflowRunState(summary.state).marker : null;
    // A wide row says its state in the status column and nothing more under the title: "Workflow run"
    // under every sibling repeated one word down the list. A narrow row (no state column, lab
    // `inbox-I2`) keeps the kind on its line beneath, with its age.
    // A held Run names what waits and where (lab `inbox-I1`, DESIGN-15 R5): "Write changelog is
    // waiting for you · Changelog", the same sentence the Run page's Needs-you rows use.
    const holdFacts = buildInboxWorkflowReasonFacts(item);
    const facts = holdFacts.length > 0
        ? holdFacts
        // Under the "Workflow runs" header the kind is already said; a narrow row says its state instead.
        : props.statusColumn ? [] : props.kindInHeader === true ? status ? [status.word] : [] : [t('inbox.work.rows.workflowRun')];
    return <InboxWorkRow testID={`inbox.run.${item.runId}`} selected={props.focused === true} showDivider={props.showDivider}
        title={formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(item.row.metadata))}
        facts={facts}
        // A held line already says it waits for you, so the state column does not say it again (DESIGN-16 D8).
        time={<InboxRelativeTime timestamp={item.row.updatedAt} />} status={holdFacts.length > 0 ? null : status} narrow={!props.statusColumn}
        // A failed run says so by the calm rose dot, like a failed session (owner ruling 2026-11-01); a hold keeps the hand.
        mark={status?.tone === 'danger'
            ? <WorkStatusRowMark status={status} testIDSuffix={`inbox.run.${item.runId}`} />
            : settledMarker?.kind === 'icon'
                ? <Icon name={settledMarker.icon} size={18} color={theme.colors.text.secondary} />
                : <Icon name="hand" size={18} color={theme.colors.text.secondary} />}
        trailingAccessory={props.showReview ? <RoundButton testID={`inbox.run.${item.runId}.review`}
            size="small" display="secondary" title={settled ? t('inbox.work.groups.openRun') : t('inbox.work.rows.review')} action={open} /> : undefined}
        onPress={() => { void open(); }} />;
}

function InboxAutomationRunRow(props: Readonly<{
    item: Extract<InboxWorkItem, { kind: 'automation_run' }>;
    navigate: RowProps['navigate'];
    focused?: boolean;
    showDivider?: boolean;
    serverId?: string | null;
    onSelectItem?: (focus: InboxItemFocus) => void;
}>) {
    const run = props.item.row.automation!;
    const automation = useAutomation(run.automationId, { serverId: props.serverId });
    const state = formatAutomationRunStateLabel(run);
    const cause = formatAutomationRunCauseLabel(run.cause);
    return <InboxWorkRow testID={`inbox.automation_run.${run.id}`} selected={props.focused === true} showDivider={props.showDivider}
        title={automation?.name ?? state} facts={automation?.name ? [state, cause] : [cause]}
        time={<InboxRelativeTime timestamp={run.finishedAt ?? run.startedAt ?? run.createdAt} />}
        mark={<Icon name="timer" size={16} />}
        onPress={() => props.onSelectItem && props.serverId
            ? props.onSelectItem({ kind: 'automation_run', id: run.id, automationId: run.automationId, serverId: props.serverId })
            : props.navigate(createWorkflowRunRoute({ kind: 'occurrence', automationId: run.automationId, runId: run.id }, props.serverId))} />;
}

type RowProps = Readonly<{
    item: InboxWorkItem;
    spansHomes: boolean;
    workflowServerId: string | null;
    automationServerId?: string | null;
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
    /** Passed by the Inbox page's sheet: the row hairline under every row but the last. */
    showDivider?: boolean;
    /** The group header already names this row's kind ("Workflow runs"). */
    kindInHeader?: boolean;
    /** What plugins say about this Session (a watched PR) and their declared controls, under its line. */
    pluginSessionRows?: readonly InboxPluginSessionRow[];
    invokePluginSessionControl?: InboxPluginSessionControlInvoker;
    /** The lead this row's Session reports to (null: it does, but its title is not readable) and its latest update (the item's `reportsTo`, `workerUpdateHeadline`). */
    reportsToTitle?: string | null;
    workerUpdateHeadline?: string;
}>;

const NO_WAKE = Object.freeze({ sentence: null, retry: null });

function readRowWorker(props: Pick<RowProps, 'reportsToTitle' | 'workerUpdateHeadline'>) {
    return props.reportsToTitle === undefined ? undefined : { leadTitle: props.reportsToTitle, headline: props.workerUpdateHeadline };
}

/**
 * One row of a work group (lab `inbox-I1`). Permission and question requests keep the canonical
 * answer card — the Inbox is one of the three places a request is answered (ORC S-1); every other
 * row states what waits and opens its home. Rows never tint by ancestry.
 */
export const InboxWorkItemRow = React.memo(function InboxWorkItemRow(props: RowProps) {
    const { theme } = useUnistyles();
    const { item } = props;
    const { openResourceUrl } = useOpenResource(item.kind === 'landing' ? {
        sessionId: item.session.id,
        serverId: sessionServerId(item.session) ?? undefined,
    } : undefined);
    // The Session this row shows is demanded like a visible list row: an undecided one is not "locked".
    const demanded = item.kind === 'session'
        ? { sessionId: item.entry.candidate.session?.id, serverId: item.entry.candidate.address?.serverId ?? item.entry.candidate.serverId }
        : item.kind === 'stalled' ? { sessionId: item.session.id, serverId: sessionServerId(item.session) } : null;
    const demandedAddress = normalizeSessionAddress(demanded?.serverId, demanded?.sessionId);
    useSessionContentDemand(demandedAddress ? [demandedAddress] : NO_SESSION_ADDRESSES, { tag: 'inbox.hydrateSessionRow', hydrate: 'unsettled' });
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
            const source = candidate.presentationSource;
            const connected = getSessionStatus(candidate.session, nowMs, { presentationSource: source }).isConnected;
            const status = presentInboxSessionStatus(candidate.session, nowMs, source);
            const time = <InboxRelativeTime timestamp={candidate.meaningfulActivityAt ?? resolveSessionListRenderableMeaningfulActivityAt(candidate.session)} />;
            const menu = page ? <InboxSessionRowMenu session={candidate.session} presentationSource={source} settle={props.settle} setReminder={props.setReminder} /> : undefined;
            if (requiresInboxPromptCard(entry)) {
                return (
                    <InboxSessionAttentionGroupCard
                        session={candidate.session}
                        presentationSource={source}
                        serverId={serverId}
                        identityDisplay={props.identityDisplay}
                        connected={connected}
                        // The request is the need; the line says whom the session reports to, else where it runs.
                        contextLine={buildInboxSessionContextLine(candidate, { showHome: props.spansHomes, showNeed: false,
                            // A request's card is about what it asks now; an older update would only mislead.
                            worker: props.reportsToTitle === undefined ? undefined : { leadTitle: props.reportsToTitle } }) ?? null}
                        permissionRequests={entry.pendingPermissions}
                        userActionRequests={entry.pendingUserActions}
                        showDivider={props.showDivider}
                        onBeforeNavigate={props.onBeforeNavigate}
                        selected={props.focused === true}
                        onSelect={props.onSelectItem && serverId ? () => openItem(sessionFocus(candidate.sessionId, serverId), null) : undefined}
                        row={{ status, time, narrow: !statusColumn, trailingAccessory: menu }}
                    />
                );
            }
            const failed = status.tone === 'danger';
            const renderRow = (wake: Readonly<{ sentence: string | null; retry: React.ReactNode }>) => (
                <InboxWorkRow
                    testID={`inbox.session.${candidate.sessionId}`}
                    selected={props.focused === true}
                    showDivider={props.showDivider}
                    title={candidate.title}
                    facts={[
                        item.foldedUnderRunId ? t('inbox.work.rows.step') : null,
                        // A failed wake says why in the wake owner's words instead of where the session runs.
                        wake.sentence ?? buildInboxSessionContextLine(candidate, { showHome: props.spansHomes, worker: readRowWorker(props) }),
                    ]}
                    time={time}
                    status={status}
                    narrow={!statusColumn}
                    mark={failed
                        ? <WorkStatusRowMark status={status} testIDSuffix={`inbox.session.${candidate.sessionId}`} />
                        : props.identityDisplay !== 'none' ? (
                            <SessionListIdentity
                                session={candidate.session}
                                presentationSource={source}
                                display={props.identityDisplay}
                                serverId={serverId}
                                color={theme.colors.text.primary}
                                avatarSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize}
                                agentLogoSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.agentLogoSize}
                                connected={connected}
                                testID={`inbox.session.${candidate.sessionId}.identity`}
                            />
                        ) : undefined}
                    trailingAccessory={menu}
                    belowAccessory={wake.retry ?? (props.pluginSessionRows?.length && props.invokePluginSessionControl ? (
                        <InboxPluginSessionLines rows={props.pluginSessionRows} invoke={props.invokePluginSessionControl}
                            testID={`inbox.session.${candidate.sessionId}.plugin_rows`} />
                    ) : undefined)}
                    onPress={() => openItem(sessionFocus(candidate.sessionId, serverId), candidate.route ?? null)}
                />
            );
            return serverId && hasInboxSessionRecovery(candidate.session)
                ? <InboxManagedWakeSessionRow session={candidate.session} serverId={serverId} render={renderRow} />
                : renderRow(NO_WAKE);
        }
        case 'workflow_run': {
            return <InboxWorkflowRunRow item={item} serverId={props.workflowServerId}
                // The open item needs no Review: it is already beside the list (lab `inbox-I1`).
                statusColumn={statusColumn} showReview={(!page || wide) && props.focused !== true}
                focused={props.focused} showDivider={props.showDivider}
                kindInHeader={props.kindInHeader} navigate={props.navigate} onSelectItem={props.onSelectItem} />;
        }
        case 'automation_run':
            return <InboxAutomationRunRow item={item} navigate={props.navigate} focused={props.focused} showDivider={props.showDivider}
                serverId={props.automationServerId} onSelectItem={props.onSelectItem} />;
        case 'approval': {
            const serverId = readInboxApprovalServerId(item.artifact.header as Readonly<Record<string, unknown>> | undefined);
            const open = () => props.onSelectItem
                ? props.onSelectItem({ kind: 'approval', serverId, id: item.artifact.id })
                : props.navigate(`/inbox/approvals/${encodeURIComponent(item.artifact.id)}${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ''}`);
            return <ApprovalInboxCard artifact={item.artifact}
                selected={props.focused === true} showDivider={props.showDivider} narrow={!statusColumn}
                showHome={props.spansHomes} inlineActionLabel={(!page || wide) && props.focused !== true ? t('inbox.work.rows.review') : undefined}
                decideBelow={page && !wide && props.focused !== true}
                onPress={open} />;
        }
        case 'stalled': {
            const session = item.session;
            const status = presentInboxSessionStatus(session, nowMs);
            return (
                <InboxWorkRow
                    testID={`inbox.stalled.${session.id}`}
                    selected={props.focused === true}
                    showDivider={props.showDivider}
                    title={readInboxSessionTitle(session, sessionServerId(session))}
                    facts={[t('inbox.work.rows.stalled'), t('inbox.work.rows.stalledReason')]}
                    status={status}
                    narrow={!statusColumn}
                    mark={glyph('cloud-slash', theme.colors.state.warning.foreground)}
                    trailingAccessory={page ? <InboxSessionRowMenu session={session} settle={props.settle} setReminder={props.setReminder} /> : undefined}
                    onPress={() => openItem(sessionFocus(session.id, sessionServerId(session)), createActivitySurfaceSessionRoute(session.id, sessionServerId(session)))}
                />
            );
        }
        case 'landing': {
            const { session, link } = item;
            const stateWord = link.state === 'open' ? t('files.sourceControlOperations.update.pullRequests.states.open')
                : link.state === 'merged' ? t('files.sourceControlOperations.update.pullRequests.states.merged')
                : link.state === 'closed' ? t('files.sourceControlOperations.update.pullRequests.states.closed') : '—';
            return (
                <InboxWorkRow
                    testID={`inbox.landing.${session.id}`}
                    selected={props.focused === true}
                    showDivider={props.showDivider}
                    title={link.title ? `#${link.number} ${link.title}` : `#${link.number}`}
                    narrow={!statusColumn}
                    status={{ word: stateWord, tone: 'neutral' }}
                    facts={[t('inbox.work.rows.landing'), ...(!statusColumn ? [stateWord] : []), readInboxSessionTitle(session, sessionServerId(session))]}
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
                    onPress={() => { props.onBeforeNavigate?.(); void openResourceUrl(link.url); }}
                />
            );
        }
        case 'snoozed': {
            const session = item.session;
            return (
                <InboxWorkRow
                    testID={`inbox.snoozed.${session.id}`}
                    selected={props.focused === true}
                    showDivider={props.showDivider}
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
