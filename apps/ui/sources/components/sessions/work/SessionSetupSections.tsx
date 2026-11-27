import * as React from 'react';
import { SessionApprovalProfileSection } from './SessionApprovalProfileSection';
import { SessionTemplateSection } from '@/components/sessions/bots/templates/SessionTemplateSection';
import { View } from 'react-native';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';

import {
  SessionRoleValueRow,
  isSessionRoleSnapshotCopiedAcrossOwners,
} from '@/components/roles/session/sessionRole';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SessionTriggerHistoryScope } from '@/components/workflows/triggers/SessionTriggerHistoryScope';
import { SubjectTriggersSectionContent } from '@/components/workflows/triggers/SubjectTriggersSection';
import { SessionWritesHereSection } from '@/components/workflows/triggers/SessionWritesHereSection';
import { useResourceAutomationsSection } from '@/components/workflows/triggers/useResourceAutomationsSection';
import { useReportSessionInfoSectionSummary } from '@/components/sessions/info/sessionInfoSectionSummaries';
import { parseExactTurnAutomationPrefillRoute } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { projectScheduledWorkflowRows } from '@/components/workflows/triggers/scheduledWorkflowRows';
import type { AccountTriggerRow } from '@/components/workflows/triggers/accountTriggerRows';
import { buildReviewHabitTriggerRequest, findReviewHabitRow, readReviewHabitReviewers } from '@/components/reviews/habit/reviewHabit';
import { ReviewHabitControl, ReviewHabitReviewerSetup, alertReviewHabitWriteFailed } from '@/components/reviews/habit/ReviewHabitSetup';
import type { ReviewReviewerSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { SessionContextSection } from './context/SessionContextSection';
import { SessionContextLayersScope } from './context/SessionContextLayersScope';
import { SessionInstructionsSection } from './instructions/SessionInstructionsSection';
import { SessionMemorySection } from './memory/SessionMemorySection';
import { SessionNotesSection } from './roles/SessionNotesSection';
import { SessionRolesSection } from './roles/SessionRolesSection';
import { SessionVoiceSection } from './voice/SessionVoiceSection';
import {
  WorkSection,
  WorkSectionPlacementProvider,
  WorkSectionSetupDisclosureProvider,
} from './WorkSection';
import { SessionPaneLazyLoader } from '@/components/sessions/panes/SessionPaneLazyLoader';
import { useSessionSetupDisclosure } from './useSessionSetupDisclosure';
import { useSessionSkillCount } from '@/sync/domains/capabilities/session/useSessionCapabilities';

const loadSessionSkillsPane = async () => (await import('@/components/sessions/capabilities/SessionSkillsPane')).SessionSkillsPane;

/**
 * Skills open in place like every Setup row (owner 11-15 C5), on the same Skills component the rail's Skills
 * panel hosts (one component, two hosts). The rail owns pinning, so the row carries no pin.
 */
function SessionSkillsRow(props: Readonly<{ sessionId: string; serverId: string }>) {
  const count = useSessionSkillCount(props.sessionId, props.serverId);
  return (
    <WorkSection testID="session-setup-skills" nativeID="skills" anatomy="page" icon="lightbulb"
      title={t('capabilities.skills.title')} count={count ?? 0} summary={count === null ? '—' : String(count)}
      setupDefaultExpanded={false}>
      <SessionPaneLazyLoader load={loadSessionSkillsPane} props={{ sessionId: props.sessionId, serverId: props.serverId, presentation: 'embedded' }}
        testID="session-setup-skills-loading" />
    </WorkSection>
  );
}

/** Where `/session/[id]/triggers` brings the person: the Triggers section of the Session's Info page. */
export const SESSION_SETUP_TRIGGERS_ANCHOR_ID = 'session-setup-triggers';

/**
 * How this agent is set up (calm-shell lab csinfo I2, P2 R06): the Session's Info answers it in the
 * order you'd ask — Role · Instructions · Memory · Context · Voice · Roles · Notes. Habits (what
 * starts from this session and what writes into it) is its own section, {@link SessionHabitsSection}.
 * The Work pane keeps only what's happening.
 *
 * The sections are the same components the Work pane used to host, moved with their owners; on this
 * page they take the configuration-page section anatomy through `WorkSectionPlacementProvider`.
 */
export const SessionSetupSections = React.memo(function SessionSetupSections(
  props: Readonly<{
    session: Session;
    serverId: string;
  }>,
) {
  const { session, serverId } = props;
  const inheritedFrom =
    readSessionRolesV1(readSessionOwnerMetadataView(session))?.inheritedFrom ??
    '';
  const inheritedLead = useSessionViewShellSession(inheritedFrom, serverId);
  const accountScope = useActiveServerAccountScope();
  const accountId =
    accountScope &&
    areServerProfileIdentifiersEquivalent(accountScope.serverId, serverId)
      ? accountScope.accountId
      : null;
  const copiedAtSpawn = isSessionRoleSnapshotCopiedAcrossOwners(
    session,
    inheritedLead,
    accountId,
  );
  // A Bot reads Instructions · Memory · Voice · Triggers (plan 65, D44), so the Context it inherits
  // follows its Triggers; an ordinary Session keeps Context beside the Memory it reads (lab `c-mem O`).
  const isBot = readSessionBotV1(session.metadata?.bot)?.kind === 'bot';
  const context = (
    <SessionContextSection session={session} serverId={serverId} />
  );
  const disclosure = useSessionSetupDisclosure();
  return (
    <>
    <ItemGroup
      testID="session-setup"
      title={t('sessionPages.info.setupTitle')}
      description={t('sessionPages.info.setupDescription')}
    >
      {/* The role leads, as one value row that opens its picker. */}
      <SessionRoleValueRow
        sessionId={session.id}
        serverId={serverId}
        testID="session-setup-role-value"
        icon={<Icon name="person" />}
      />
      <SessionApprovalProfileSection session={session} serverId={serverId} />
      <SessionContextLayersScope session={session} serverId={serverId}>
        <WorkSectionPlacementProvider value="setup">
          <WorkSectionSetupDisclosureProvider value={disclosure}>
            <SessionInstructionsSection session={session} serverId={serverId} />
            <SessionMemorySection session={session} serverId={serverId} />
            <SessionSkillsRow sessionId={session.id} serverId={serverId} />
            {isBot ? null : context}
            <SessionVoiceSection session={session} serverId={serverId} />
            {isBot ? context : null}
            <SessionRolesSection
              sessionId={session.id}
              serverId={serverId}
              copiedAtSpawn={copiedAtSpawn}
            />
            <SessionNotesSection sessionId={session.id} serverId={serverId} />
          </WorkSectionSetupDisclosureProvider>
        </WorkSectionPlacementProvider>
      </SessionContextLayersScope>
    </ItemGroup>
    {/* Template follows Setup as its own section (r2 Info Template row). */}
    <SessionTemplateSection session={session} serverId={serverId} />
    </>
  );
});

/**
 * Habits (lab csinfo I2): what starts from this session, then what writes into it, as one section,
 * closing on the way to every automation of the session. `?trigger=` deep links land on its anchor.
 */
type SessionHabitsSectionProps = Readonly<{
    sessionId: string;
    serverId: string;
    onOpenAllAutomations?: () => void;
    offlineStatedAbove?: boolean;
}>;

export const SessionHabitsSection = React.memo(function SessionHabitsSection(props: SessionHabitsSectionProps) {
  const scope = useActiveServerAccountScope(props.serverId);
  // The section reads one Session of one Home: its canonical subject names that Home's portable identity.
  const homeId = resolvePortableServerIdentityForRoutingId(props.serverId);
  return scope && homeId && areServerProfileIdentifiersEquivalent(scope.serverId, props.serverId)
    ? <SessionHabitsContent {...props} homeId={homeId} /> : null;
});

const NO_SETS: readonly never[] = [];
const NO_RETRY = () => {};

function SessionHabitsContent(props: SessionHabitsSectionProps & Readonly<{ homeId: string }>) {
  const { sessionId } = props;
  const [title] = useSessionDisplayTitles([{ sessionId, serverId: props.serverId }]);
  const subject = React.useMemo(() => ({ kind: 'session' as const, serverId: props.homeId, sessionId }), [props.homeId, sessionId]);
  // One intake for the section and what writes here: the shared hook owns the Session watcher once.
  const automations = useResourceAutomationsSection({ subject, subjectName: title ?? '' });
  const session = automations.session;
  const sessionSets = session?.sets ?? NO_SETS;
  const destination = useWorkflowRunWindow(`destination:${sessionId}`);
  // Scheduled work that writes here comes from Account-lifetime sets; a row the section already lists stays there.
  const listed = React.useMemo(() => new Set([...automations.rows, ...automations.also].map(row => row.automationId)),
    [automations.rows, automations.also]);
  const scheduledRows = React.useMemo(() => projectScheduledWorkflowRows(sessionSets, sessionId)
    .filter(row => row.set.scopeSessionId !== sessionId && !listed.has(row.set.automationId)), [sessionSets, sessionId, listed]);
  const sessionStatus = session?.status ?? 'ready';
  const sessionRetry = session?.retry;
  const scheduled = React.useMemo(() => ({
    available: true, rows: scheduledRows, status: sessionStatus, retry: sessionRetry ?? NO_RETRY, serverId: props.serverId,
  }), [scheduledRows, sessionStatus, sessionRetry, props.serverId]);
  const read = automations.read;
  const retry = React.useCallback(() => {
    read.retry();
    sessionRetry?.();
    if (destination.loadMoreFailed) destination.loadMore();
    else destination.retry();
  }, [read.retry, sessionRetry, destination.loadMoreFailed, destination.loadMore, destination.retry]);
  const status: typeof read.status = read.status === 'failed' || sessionStatus === 'failed' || destination.status === 'failed' || destination.loadMoreFailed
    ? 'failed' : read.status === 'loading' || sessionStatus === 'loading' || destination.status === 'loading' ? 'loading' : 'ready';
  // A read that failed while the Machine was away is read again when it returns, without a Retry tap.
  const { machineReachable } = useSessionMachineReachability(sessionId, props.serverId);
  const retryRef = React.useRef({ status, retry });
  retryRef.current = { status, retry };
  React.useEffect(() => {
    if (machineReachable && retryRef.current.status === 'failed') retryRef.current.retry();
  }, [machineReachable]);
  // "Review my changes" is one of this Session's own triggers, drawn as its habit control rather than a row.
  const habitRow = React.useMemo(() => findReviewHabitRow(automations.rows), [automations.rows]);
  const triggerRows = React.useMemo(() => habitRow ? automations.rows.filter(row => row !== habitRow) : automations.rows,
    [automations.rows, habitRow]);
  // Retry and the pending/failed treatment cover the section's own read and the readers of what writes here.
  const combined = React.useMemo(() => ({ ...automations, rows: triggerRows, read: { ...read, status, retry } }),
    [automations, triggerRows, read, status, retry]);
  // Who the habit runs is its own saved trigger's reviewers (the Session's lifetime set).
  const habitReviewers = React.useMemo(() => readReviewHabitReviewers(habitRow
    ? sessionSets.find(set => set.automationId === habitRow.automationId) : null), [habitRow, sessionSets]);
  const habit = useSessionReviewHabit({ sessionId, homeId: props.homeId, serverId: props.serverId, automations, habitRow,
    reviewers: habitReviewers, ready: read.status === 'ready' });
  // Session Info folds an empty Habits into "Add to this session" from this read, without another.
  const summaryScope = useActiveServerAccountScope(props.serverId);
  useReportSessionInfoSectionSummary('habits.startsHere', summaryScope ? {
    scope: summaryScope, sessionId, coverage: 'complete',
    status: read.status === 'ready' ? 'ready' : read.status === 'failed' ? 'error' : 'loading',
    count: automations.rows.length + automations.also.length,
  } : null);
  // "When this turn finishes…" and `?trigger=` deep links arrive on the Info route (`/session/[id]/triggers`).
  const params = useLocalSearchParams();
  const exactTurn = parseExactTurnAutomationPrefillRoute(params);
  const exactTurnPrefill = exactTurn.kind === 'valid' && exactTurn.prefill.sourceSessionId === sessionId ? exactTurn.prefill : undefined;
  return (
    // The one editable Automations section, on Info (merged Session lab OQ10; Work shows a read-only Coming up).
    // Its host sets the anatomy: the Info side pane lays it flat; the phone Info page puts it on a sheet.
    <WorkSectionPlacementProvider value="page">
      <SessionTriggerHistoryScope>
        <View nativeID={SESSION_SETUP_TRIGGERS_ANCHOR_ID} collapsable={false}>
          <SubjectTriggersSectionContent subject={subject} subjectName={title ?? ''} automations={combined}
            exactTurnPrefill={exactTurnPrefill}
            // Work's "+" › Add a trigger… lands here (`/session/[id]/triggers?addTrigger=<token>`) and opens the builder once.
            {...(typeof params.addTrigger === 'string' ? { openNewToken: params.addTrigger } : {})}
            offlineStatedAbove={props.offlineStatedAbove}
            {...(typeof params.trigger === 'string' ? { revealAutomationId: params.trigger } : {})}
            leading={habit}
            hasRetainedContent={habitRow !== null || scheduledRows.length > 0 || destination.runIds.length > 0}>
            {props.onOpenAllAutomations ? (
              <Item
                testID="session-habits-all-automations"
                icon={<Icon name="tree-structure" />}
                title={t('sessionPages.info.allAutomations')}
                onPress={props.onOpenAllAutomations}
              />
            ) : null}
          </SubjectTriggersSectionContent>
          {/* What writes into this Session, under its own quiet label as "Also runs here" is (F1): a schedule and the
              Run it started read as two things that write here, not one workflow listed twice. */}
          <SessionWritesHereSection sessionId={sessionId} serverId={props.serverId}
            scheduled={scheduled} read={destination} />
        </View>
      </SessionTriggerHistoryScope>
    </WorkSectionPlacementProvider>
  );
}

/**
 * The Session's review habit (lab `session-habit`): its one trigger switches through the section's trigger editor;
 * the first Each turn opens who reviews, then writes the trigger through the same editor's writer.
 */
function useSessionReviewHabit(params: Readonly<{
  sessionId: string;
  homeId: string;
  automations: ReturnType<typeof useResourceAutomationsSection>;
  habitRow: AccountTriggerRow | null;
  reviewers: ReturnType<typeof readReviewHabitReviewers>;
  serverId: string | null;
  ready: boolean;
}>): React.ReactNode {
  const { sessionId, homeId, habitRow } = params;
  const { editor, accountLifetime } = params.automations;
  const [setupLifetime, setSetupLifetime] = React.useState<ServerAccountScopeLifetime | null>(null);
  const [saving, setSaving] = React.useState(false);
  const toggle = React.useCallback((row: AccountTriggerRow, next: boolean) => { void editor.toggle(row, next); }, [editor]);
  const openReviewers = React.useCallback((row: AccountTriggerRow, anchor: React.RefObject<View | null>) => {
    void editor.open(row, anchor);
  }, [editor]);
  const setUp = React.useCallback(() => {
    const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
    if (lifetime?.isCurrent()) setSetupLifetime(lifetime);
  }, [accountLifetime]);
  const cancel = React.useCallback(() => setSetupLifetime(null), []);
  const choose = React.useCallback(async (reviewer: ReviewReviewerSelectionV1) => {
    const lifetime = setupLifetime;
    setSetupLifetime(null);
    const request = buildReviewHabitTriggerRequest({ kind: 'session', homeId, sessionId }, [reviewer]);
    if (!request || !lifetime?.isCurrent()) return;
    setSaving(true);
    try {
      await editor.add(request, lifetime);
    } catch (error) {
      alertReviewHabitWriteFailed(error);
    } finally {
      setSaving(false);
    }
  }, [editor, homeId, sessionId, setupLifetime]);
  return (
    <ReviewHabitControl status={params.ready ? 'ready' : 'loading'} row={habitRow}
      reviewers={params.reviewers} serverId={params.serverId}
      pending={saving || (habitRow !== null && editor.pending.has(habitRow.automationId))}
      onToggle={toggle} onSetUp={setUp} onOpenReviewers={openReviewers}
      setup={setupLifetime ? <ReviewHabitReviewerSetup accountLifetime={setupLifetime} consumerSessionId={sessionId}
        onChoose={(reviewer) => { void choose(reviewer); }} onCancel={cancel} /> : null} />
  );
}
