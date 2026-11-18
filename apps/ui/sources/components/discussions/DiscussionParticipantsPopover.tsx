import { useShareGrantRowPresentation } from '@/components/sharing/sharePresentationHost';
import type { DiscussionParticipantRoster } from './useDiscussionParticipantManagement';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import * as React from 'react';
import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  DiscussionAnswerPolicyV1,
} from '@happier-dev/protocol/discussions/participants';

import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack, type AvatarStackEntry } from '@/components/ui/avatar/AvatarStack';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import {
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  Popover,
} from '@/components/ui/popover';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { resolveAccountActorAvatar } from '@/sync/domains/account/accountActorPresentation';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import type { useDiscussionParticipantManagement } from './useDiscussionParticipantManagement';
import { ShareRowAction } from '@happier-dev/plugin-ui/components';
import type { SharePrincipalPresentation } from '@/components/sharing/shareSheetTypes';
import { SelectionList, type SelectionListOption, type SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import { useExecutableParticipantSections } from './useExecutableParticipantSections';
import { isDiscussionParticipantMuted, setDiscussionParticipantMuted } from './discussionParticipantMute';
import { useAccountSessionFollowEditorHost } from '@/components/sessions/follow/useAccountSessionFollowEditorHost';
import { useActivityPersonalSessionMembership } from '@/activity/source/activityPersonalSessionMembership';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readComposerSessionSuggestionDisplay } from '@/sync/domains/input/suggestionSession';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import {
  DiscussionParticipantOperationLine,
  DiscussionParticipantsSheet,
  DiscussionSheetHeader,
} from './DiscussionInviteSheet';

const AVATAR_PX = 28;
const NO_MACHINES: readonly never[] = [];
const NO_SECTIONS: readonly SelectionListSectionDescriptor[] = Object.freeze([]);

export function resolveDiscussionOwnerTransferAvatar(
  actor: TranscriptAccountActor | null | undefined,
  accountId: string,
  scope: ServerAccountScope,
) {
  return resolveAccountActorAvatar({ serverId: scope.serverId, accountId }, actor, scope);
}

const styles = StyleSheet.create((theme) => ({
  body: { paddingBottom: theme.space.s4, minWidth: 0 },
  headerSlot: { paddingTop: theme.space.s8 },
  groupNote: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
    textAlign: 'right',
  },
  rowControls: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, flexShrink: 1, minWidth: 0 },
  // The pill gives way before the agent's name does; its menu says each policy in full.
  policyTrigger: { justifyContent: 'center', flexShrink: 1, minWidth: 0, maxWidth: 240 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  footerEnd: { marginLeft: 'auto' },
  panel: { flex: 1, minHeight: 0, minWidth: 0 },
  panelBody: { flex: 1, minHeight: 0, minWidth: 0 },
  resolutionBody: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s4,
  },
  resolutionArchive: { marginTop: theme.space.s8 },
}));

/** What the roster says about this Discussion: who reads it, and who may answer. */
export type DiscussionRosterFacts = Readonly<{
  peopleCount: number;
  agentCount: number;
  /** A Team or Group grant: readers beyond the people invited by name. */
  inherited: boolean;
}>;

/** The faces of who is in this Discussion (lab T2-A header): people first, then each agent's mark. */
const ROSTER_FACE_PX = 20;
const ROSTER_FACE_LIMIT = 6;
export const DiscussionRosterFaces = React.memo(function DiscussionRosterFaces(
  props: Readonly<{
    accountActors: ReadonlyMap<string, TranscriptAccountActor>;
    viewerAccountId: string;
    accessibilityLabel: string;
    /** The Discussion's Home, so a Session participant shows its own Agent's mark. */
    serverId: string;
  }> & (
    | Readonly<{ roster: DiscussionParticipantRoster; members?: undefined }>
    /** A New Discussion's chosen people and agents, before any roster exists. */
    | Readonly<{ roster?: undefined; members: Readonly<{ accountIds: readonly string[]; agents: readonly ('session' | 'model')[] }> }>
  ),
) {
  const { roster, members } = props;
  const isSessionVisible = useSessionRecordingVisibility();
  const entries = React.useMemo(() => {
    const people = roster ? [roster.ownerAccountId] : [...members!.accountIds];
    for (const grant of roster?.grants ?? []) {
      if (grant.principal.kind === 'account' && !people.includes(grant.principal.accountId)) people.push(grant.principal.accountId);
    }
    // The viewer sits last, as in the roster: the others are who you came to see.
    const ordered = [...people.filter((id) => id !== props.viewerAccountId), ...people.filter((id) => id === props.viewerAccountId)];
    const faces: AvatarStackEntry[] = ordered.map((accountId) => {
      const avatar = resolveAccountActorAvatar({ serverId: props.serverId, accountId }, props.accountActors.get(accountId),
        { serverId: props.serverId, accountId: props.viewerAccountId });
      return { key: `account:${accountId}`,
        content: <Avatar id={avatar.id} imageUrl={avatar.imageUrl ?? null} size={ROSTER_FACE_PX} /> };
    });
    // Each agent wears its own Agent's mark, as its rows and answers do; one not yet born (or not on this
    // device) keeps the neutral kind glyph.
    const agentMarks = roster
      ? roster.participants.map((participant) => {
        const sessionId = participant.participant.kind === 'session' ? participant.participant.sessionId
          : 'sessionId' in participant ? participant.sessionId : null;
        const privateSession = Boolean(sessionId && !isSessionVisible({ serverId: props.serverId, sessionId }));
        const display = sessionId && props.serverId && !privateSession ? readComposerSessionSuggestionDisplay({ serverId: props.serverId, sessionId }) : null;
        const launch = !privateSession && 'launch' in participant ? participant.launch : null;
        return {
          agentId: display?.agentId ?? (launch ? resolveBundledAgentIdFromContributionIdentity(launch.agentTarget.identity) : null),
          machineId: display?.machineId ?? launch?.executionTarget.machineId ?? null,
          serverId: display?.serverId ?? props.serverId ?? null,
        };
      })
      : members!.agents.map(() => ({ agentId: null, machineId: null, serverId: null }));
    const agents: AvatarStackEntry[] = agentMarks.map((mark, index) => ({
      key: `agent:${index}`,
      avatar: false,
      content: <View style={rosterFaceStyles.agentMark}>
        <ParticipantAgentMark {...mark} size={ICON_SIZE.xs} />
      </View>,
    }));
    return [...faces, ...agents].slice(0, ROSTER_FACE_LIMIT);
  }, [isSessionVisible, members, props.accountActors, props.serverId, props.viewerAccountId, roster]);
  return <AvatarStack testID="session-discussion-roster-faces" size={ROSTER_FACE_PX} entries={entries} accessibilityLabel={props.accessibilityLabel} />;
});

/**
 * A participant's Agent mark (lab T2-S): its Session's Agent, or the Agent a model slot's launch names, through
 * the catalog owner; a participant whose Agent this device cannot see keeps the catalog's neutral mark.
 */
export function ParticipantAgentMark(props: Readonly<{ agentId: string | null | undefined; machineId: string | null; serverId: string | null; size: number }>) {
  return props.agentId
    ? <SessionAgentCatalogIdentityIcon agentId={props.agentId} machineId={props.machineId} serverId={props.serverId} size={props.size} />
    : <AgentIcon agentId={null} size={props.size} />;
}

const rosterFaceStyles = StyleSheet.create((theme) => ({
  agentMark: {
    width: ROSTER_FACE_PX + 4,
    height: ROSTER_FACE_PX + 4,
    borderRadius: (ROSTER_FACE_PX + 4) / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface.base,
  },
}));

export function summarizeDiscussionRoster(
  roster: DiscussionParticipantRoster,
): DiscussionRosterFacts {
  const invited = new Set<string>([roster.ownerAccountId]);
  let inherited = false;
  for (const grant of roster.grants) {
    if (grant.principal.kind === 'account')
      invited.add(grant.principal.accountId);
    else inherited = true;
  }
  return {
    peopleCount: invited.size,
    agentCount: roster.participants.length,
    inherited,
  };
}

export function formatDiscussionRosterLine(
  facts: DiscussionRosterFacts,
): string {
  return facts.agentCount > 0
    ? t('session.collaboration.discussion.participants.peopleAndAgents', {
        people: facts.peopleCount,
        agents: facts.agentCount,
      })
    : t('session.collaboration.discussion.participants.people', {
        count: facts.peopleCount,
      });
}

const ANSWER_POLICIES: readonly DiscussionAnswerPolicyV1[] = [
  'when_addressed',
  'reads_only',
  'drafts_for_approval',
  'watches_and_speaks_up',
];

export function answerPolicyLabel(policy: DiscussionAnswerPolicyV1): string {
  switch (policy) {
    case 'when_addressed':
      return t(
        'session.collaboration.discussion.participants.policyWhenAddressed',
      );
    case 'reads_only':
      return t('session.collaboration.discussion.participants.policyReadsOnly');
    case 'drafts_for_approval':
      return t('session.collaboration.discussion.participants.policyDrafts');
    case 'watches_and_speaks_up':
      return t('session.collaboration.discussion.participants.policyWatches');
  }
}

/** What each answer policy does, said where it is chosen (lab T2-S); watching names its turn cost. */
export function answerPolicyDescription(policy: DiscussionAnswerPolicyV1): string {
  switch (policy) {
    case 'when_addressed':
      return t('session.collaboration.discussion.manage.policyWhenAddressedBody');
    case 'reads_only':
      return t('session.collaboration.discussion.manage.policyReadsOnlyBody');
    case 'drafts_for_approval':
      return t('session.collaboration.discussion.manage.policyDraftsBody');
    case 'watches_and_speaks_up':
      return t('session.collaboration.discussion.manage.policyWatchesBody');
  }
}

export type DiscussionParticipantManagement = ReturnType<
  typeof useDiscussionParticipantManagement
>;
type RosterParticipant =
  DiscussionParticipantRoster['participants'][number];

/**
 * Who is in a Discussion (lab T2-S): the people who can read it, then the agents and how each answers,
 * and what the audience means. Opened from the header's people control; the roster is the Discussion's
 * own grants, never the source Session's readers. A manager changes how an agent answers, opens its
 * session or removes it from each agent's row; the owner's Leave first asks who keeps it.
 */
export const DiscussionParticipantsPopover = React.memo(
  function DiscussionParticipantsPopover(
    props: Readonly<{
      scope: ServerAccountScope;
      accountLifetime?: ServerAccountScopeLifetime;
      discussionId: string;
      discussionTitle: string;
      serverId: string;
      viewerAccountId: string;
      roster: DiscussionParticipantRoster | null;
      /** A roster write landed (an invitation from the search). */
      onChanged?: () => void;
      /** Captured-Home display facts; composition uses the shared Account byline presentation owner. */
      accountActors: ReadonlyMap<string, TranscriptAccountActor>;
      /** Accounts present in the Discussion right now (live presence). */
      presentAccountIds: ReadonlySet<string>;
      resolveAccountLabel: (accountId: string) => string | null;
      onLeave?: () => void;
      /** The participant writes (C's management owner); absent leaves the roster read-only. */
      management?: DiscussionParticipantManagement | null;
      /** Whether this viewer may change who answers here (manage access on an unarchived Discussion). */
      canManage?: boolean;
      /** The owner handed the Discussion over and left. */
      onLeft?: () => void;
    }>,
  ) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);
    const management = props.management ?? null;
    const resolving = management?.ownerLeave.kind === 'transfer_or_archive';
    const close = React.useCallback(() => {
      management?.cancelLeave();
      setOpen(false);
    }, [management]);
    const viewerIsOwner =
      props.roster !== null &&
      props.roster.ownerAccountId === props.viewerAccountId;
    const subtitle = props.roster
      ? `${props.discussionTitle} · ${formatDiscussionRosterLine(summarizeDiscussionRoster(props.roster))}`
      : props.discussionTitle;
    return (
      <>
        <View ref={anchorRef} collapsable={false}>
          <IconButton
            testID="discussion-participants-toggle"
            iconName="users"
            variant="plain"
            iconSize={ICON_SIZE.sm}
            size={34}
            accessibilityLabel={t(
              'session.collaboration.discussion.participants.title',
            )}
            tooltip={t('session.collaboration.discussion.participants.title')}
            tooltipHidden={open}
            expanded={open}
            hasPopup="dialog"
            onPress={() => (open ? close() : setOpen(true))}
          />
        </View>
        {open ? (
          <Popover
            open={open}
            anchorRef={anchorRef}
            placement="bottom"
            gap={6}
            maxHeightCap={720}
            maxWidthCap={480}
            onRequestClose={close}
            backdrop={{ enabled: false }}
            portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
          >
            {({ maxHeight }) => (
              <FloatingOverlay
                maxHeight={maxHeight}
                surfaceChrome="theme"
                // The sheet's title and its Leave/Done stay put while a long roster scrolls.
                header={<View style={styles.headerSlot}>
                    <DiscussionSheetHeader
                      icon={resolving ? 'sign-out' : 'users'}
                      title={
                        resolving
                          ? t('session.collaboration.discussion.manage.leaveTitle')
                          : t('session.collaboration.discussion.participants.title')
                      }
                      subtitle={subtitle}
                    />
                </View>}
                footer={<View style={styles.footer}>
                    {resolving ? (
                      <View style={styles.footerEnd}>
                        <RoundButton
                          testID="discussion-participants-cancel-leave"
                          size="small"
                          display="secondary"
                          title={t('common.cancel')}
                          disabled={
                            management?.ownerLeave.kind ===
                              'transfer_or_archive' &&
                            !management.ownerLeave.canCancel
                          }
                          onPress={() => management?.cancelLeave()}
                        />
                      </View>
                    ) : (
                      <>
                        {props.onLeave && props.roster ? (
                          <RoundButton
                            testID="discussion-participants-leave"
                            size="small"
                            display="secondary"
                            title={t(
                              'session.collaboration.discussion.participants.leave',
                            )}
                            onPress={() => {
                              // The owner first chooses who keeps it, here in the same sheet.
                              if (!viewerIsOwner) setOpen(false);
                              props.onLeave?.();
                            }}
                          />
                        ) : null}
                        <View style={styles.footerEnd}>
                          <RoundButton
                            testID="discussion-participants-done"
                            size="small"
                            title={t('common.done')}
                            onPress={close}
                          />
                        </View>
                      </>
                    )}
                  </View>}
              >
                <View
                  testID="discussion-participants-panel"
                  style={styles.body}
                >
                  {resolving && management && props.roster ? (
                    <DiscussionOwnerLeaveResolution
                      management={management}
                      accountActors={props.accountActors}
                      scope={props.scope}
                      resolveAccountLabel={props.resolveAccountLabel}
                      onLeft={() => {
                        setOpen(false);
                        props.onLeft?.();
                      }}
                    />
                  ) : props.roster ? (
                    <DiscussionRoster
                      scope={props.scope}
                      {...(props.accountLifetime ? { accountLifetime: props.accountLifetime } : {})}
                      discussionId={props.discussionId}
                      discussionTitle={props.discussionTitle}
                      serverId={props.serverId}
                      viewerAccountId={props.viewerAccountId}
                      roster={props.roster}
                      presentAccountIds={props.presentAccountIds}
                      management={management}
                      canManage={props.canManage === true && management !== null}
                      {...(props.onChanged ? { onChanged: props.onChanged } : {})}
                      onRequestClose={close}
                    />
                  ) : (
                    <EmptyState
                      layout="line"
                      lineLoading
                      title={t(
                        'session.collaboration.discussion.participants.loading',
                      )}
                    />
                  )}
                  {management ? (
                    <DiscussionParticipantOperationLine
                      management={management}
                      serverId={props.serverId}
                    />
                  ) : null}
                </View>
              </FloatingOverlay>
            )}
          </Popover>
        ) : null}
      </>
    );
  },
);

/** The owner's Leave: hand the Discussion to someone already here, or archive it. Cancel keeps all. */
function DiscussionOwnerLeaveResolution(
  props: Readonly<{
    management: DiscussionParticipantManagement;
    accountActors: ReadonlyMap<string, TranscriptAccountActor>;
    scope: ServerAccountScope;
    resolveAccountLabel: (accountId: string) => string | null;
    onLeft: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { management } = props;
  const resolution = management.ownerLeave;
  if (resolution.kind !== 'transfer_or_archive') return null;
  const busy = management.operation.kind === 'working';
  return (
    <View testID="discussion-owner-leave">
      <Text style={styles.resolutionBody}>
        {t('session.collaboration.discussion.manage.leaveBody')}
      </Text>
      <CollectionListGroupLabel
        title={t('session.collaboration.discussion.manage.transferGroup')}
        presentation="menu"
      />
      {resolution.transferCandidates.length === 0 ? (
        <EmptyState
          layout="line"
          lineDensity="menu"
          title={t('session.collaboration.discussion.manage.noTransferCandidates')}
        />
      ) : (
        resolution.transferCandidates.map((candidate) => {
          const avatar = resolveDiscussionOwnerTransferAvatar(
            props.accountActors.get(candidate.accountId),
            candidate.accountId,
            props.scope,
          );
          return (
            <Item
              key={candidate.accountId}
              testID={`discussion-owner-transfer-${candidate.accountId}`}
              density="compact"
              showChevron={false}
              showDivider={false}
              disabled={busy}
              leftElement={<Avatar id={avatar.id} imageUrl={avatar.imageUrl} size={AVATAR_PX} />}
              title={
                props.resolveAccountLabel(candidate.accountId) ??
                t('session.collaboration.unnamed')
              }
              subtitle={t('session.collaboration.discussion.manage.transferSubtitle')}
              onPress={() => {
                void management
                  .transferAndLeave(candidate.accountId)
                  .then((outcome) => {
                    if (outcome?.kind === 'succeeded') props.onLeft();
                  });
              }}
            />
          );
        })
      )}
      {resolution.canArchive ? (
        <View style={styles.resolutionArchive}>
          <Item
            testID="discussion-owner-archive-instead"
            density="compact"
            showChevron={false}
            showDivider={false}
            disabled={busy}
            leftElement={
              <Icon
                name="archive"
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            }
            title={t('session.collaboration.discussion.manage.archiveInstead')}
            subtitle={t(
              'session.collaboration.discussion.manage.archiveInsteadBody',
            )}
            onPress={() => {
              void management.archiveInsteadOfLeave();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The roster inside the one share sheet (lab T2-S): the search invites, "Who has access" lists the
 * people with their live presence, then the agents that answer here, each with its answer policy as
 * a pill, then the models started for this Discussion with where their session stands.
 */
/**
 * The roster's agents, as the participants sheet and the Discussion's Agents tab both list them: the
 * Sessions taking part, then the models started here, each with its answer policy menu when the viewer
 * manages the Discussion.
 */
function useDiscussionRosterAgentSections(
  props: Readonly<{
    serverId: string;
    roster: DiscussionParticipantRoster;
    management: DiscussionParticipantManagement | null;
    canManage: boolean;
    accountLifetime?: ServerAccountScopeLifetime;
  }>,
): readonly SelectionListSectionDescriptor[] {
  const { theme } = useUnistyles();
  // A phone and the page's side pane have no room beside the heading for the note.
  const surfaceSize = useSurfaceStateSize();
  const phone = surfaceSize === 'phone' || surfaceSize === 'pane';
  const { roster, management } = props;
  const manager = props.canManage ? management : null;
  const agentSessions = React.useMemo(
    () =>
      roster.participants.map((participant) => ({
        serverId: props.serverId,
        sessionId:
          participant.participant.kind === 'session'
            ? participant.participant.sessionId
            : 'launch' in participant ? (participant.sessionId ?? '') : '',
      })),
    [props.serverId, roster.participants],
  );
  const agentTitles = useSessionDisplayTitles(agentSessions);
  const isSessionVisible = useSessionRecordingVisibility();
  const machines = useMachineListForServer(props.serverId) ?? NO_MACHINES;
  const modelViews = management?.modelParticipants;
  // This Account's own mutes, read once for the roster (CR3); unknown until its owner has read them.
  const mutedScopes = useActivityPersonalSessionMembership().accountDeliveryMutesByServerId?.[props.serverId]?.scopes ?? null;
  const accountLifetime = props.accountLifetime;
  const afterAccess = React.useMemo<readonly SelectionListSectionDescriptor[]>(() => {
    const agents: SelectionListOption[] = [];
    const started: SelectionListOption[] = [];
    roster.participants.forEach((participant, index) => {
      const testID = `discussion-agent-participant-${index}`;
      const sessionId = agentSessions[index]?.sessionId || null;
      const privateSession = Boolean(sessionId && !isSessionVisible({ sessionId, serverId: props.serverId }));
      const policy = answerPolicyLabel(participant.answerPolicy);
      if (participant.participant.kind === 'model' && 'launch' in participant) {
        const slotId = participant.participant.participantSlotId;
        const view = modelViews?.find((row) => row.participantSlotId === slotId) ?? null;
        const machineId = participant.launch.executionTarget.machineId;
        // Said inside a sentence: a machine still loading reads "this machine", never "Loading…".
        const shownMachine = view?.display.machineLabel;
        const machine = shownMachine && shownMachine !== t('common.loading')
          ? shownMachine
          : getMachineSentenceName(machines.find((entry) => entry.id === machineId) ?? { id: machineId, absence: 'unlisted' });
        // A model left at its agent's own settings is named by its agent (lab T2-S names the model).
        const namedModel = view !== null && view.display.modelLabel !== t('agentInput.model.useCliSettings');
        const name = namedModel ? view?.display.modelLabel : view?.display.agentLabel;
        const birth = sessionId ? 'started' : view?.birth.kind ?? 'unknown';
        const state =
          birth === 'started'
            ? t('session.collaboration.discussion.manage.modelSessionOn', { machine })
            : birth === 'starting'
              ? t('session.collaboration.discussion.manage.modelStartingOn', { machine })
              : birth === 'failed'
                ? t('session.collaboration.discussion.manage.modelFailedOn', { machine })
                : t('session.collaboration.discussion.manage.modelNotStartedOn', { machine });
        // Try again leads only after a failure seen here; an unstarted slot starts again from its menu.
        const canRetry = manager !== null && !sessionId && birth === 'failed' && view?.canRetry === true;
        const retry = () => {
          void manager?.inviteExecutable(
            { kind: 'model', launch: participant.launch },
            { participantSlotId: slotId, answerPolicy: participant.answerPolicy },
          );
        };
        started.push({
          id: `model:${slotId}`,
          testID,
          label: privateSession ? t('session.collaboration.discussion.participants.session')
            : name ?? agentTitles[index] ?? t('session.collaboration.discussion.participants.model'),
          subtitle: [privateSession ? t('session.collaboration.discussion.participants.session')
            : namedModel ? view?.display.agentLabel : t('session.collaboration.discussion.participants.model'), privateSession ? null : state, manager ? null : policy]
            .filter(Boolean).join(' · '),
          loading: birth === 'starting',
          icon: () => <ParticipantAgentMark
            agentId={privateSession ? null : resolveBundledAgentIdFromContributionIdentity(participant.launch.agentTarget.identity)}
            machineId={privateSession ? null : machineId} serverId={props.serverId ?? null} size={ICON_SIZE.md} />,
          ...(manager || sessionId
            ? {
                rightAccessoryOutsidePressable: true,
                rightAccessory: () => (
                  <View style={styles.rowControls}>
                    {canRetry ? (
                      <ShareRowAction useHost={useShareGrantRowPresentation}
                        testID={`${testID}:retry`}
                        label={t('session.collaboration.discussion.retry')}
                        onPress={retry}
                        disabled={manager.operation.kind === 'working'}
                      />
                    ) : null}
                    <DiscussionAgentMenu
                      testID={testID}
                      participant={participant}
                      title={privateSession ? t('session.collaboration.discussion.participants.session') : name ?? t('session.collaboration.discussion.participants.model')}
                      sessionId={sessionId}
                      serverId={props.serverId}
                      management={manager}
                      muted={sessionId ? isDiscussionParticipantMuted(mutedScopes, sessionId) : null}
                      {...(accountLifetime ? { accountLifetime } : {})}
                    />
                  </View>
                ),
              }
            : {}),
        });
        return;
      }
      const display = sessionId && !privateSession ? readComposerSessionSuggestionDisplay({ serverId: props.serverId, sessionId }) : null;
      const title = (privateSession ? null : agentTitles[index]) ?? display?.title ?? t('session.collaboration.discussion.heldParticipant');
      agents.push({
        id: `session:${sessionId ?? index}`,
        testID,
        label: title,
        subtitle: [t('session.collaboration.discussion.participants.session'), display?.agentLabel, display?.workspaceLabel, manager ? null : policy]
          .filter(Boolean).join(' · '),
        // A session leads with its Agent's own mark, as its answers do in the thread.
        icon: () => <ParticipantAgentMark agentId={display?.agentId} machineId={display?.machineId ?? null}
          serverId={display?.serverId ?? null} size={ICON_SIZE.md} />,
        ...(manager || sessionId
          ? {
              rightAccessoryOutsidePressable: true,
              rightAccessory: () => (
                <DiscussionAgentMenu
                  testID={testID}
                  participant={participant}
                  title={title}
                  sessionId={sessionId}
                  serverId={props.serverId}
                  management={manager}
                  muted={sessionId ? isDiscussionParticipantMuted(mutedScopes, sessionId) : null}
                  {...(accountLifetime ? { accountLifetime } : {})}
                />
              ),
            }
          : {}),
      });
    });
    const sections: SelectionListSectionDescriptor[] = [];
    if (agents.length > 0 || started.length === 0)
      sections.push({
        kind: 'static',
        id: 'agents',
        title: t('session.collaboration.discussion.participants.agentsGroup'),
        // A phone has no room beside the heading, so it keeps the count; a desktop shows the note there
        // instead (lab T2-S), since the header already says how many agents.
        ...(agents.length && phone ? { count: agents.length } : {}),
        ...(phone ? {} : { rightAccessory: () => <Text style={styles.groupNote} numberOfLines={1}>{t('session.collaboration.discussion.participants.agentsNote')}</Text> }),
        options: agents,
        ...(agents.length === 0 ? { resultHint: t('session.collaboration.discussion.participants.noAgents') } : {}),
      });
    if (started.length > 0)
      sections.push({
        kind: 'static',
        id: 'started',
        title: t('session.collaboration.discussion.manage.startedGroup'),
        options: started,
      });
    return sections;
  }, [accountLifetime, agentSessions, agentTitles, isSessionVisible, machines, manager, modelViews, mutedScopes, phone, props.serverId, roster.participants, theme]);
  return afterAccess;
}

function DiscussionRoster(
  props: Readonly<{
    scope: ServerAccountScope;
    accountLifetime?: ServerAccountScopeLifetime;
    discussionId: string;
    discussionTitle: string;
    serverId: string;
    viewerAccountId: string;
    roster: DiscussionParticipantRoster;
    presentAccountIds: ReadonlySet<string>;
    management: DiscussionParticipantManagement | null;
    canManage: boolean;
    onChanged?: () => void;
    onRequestClose: () => void;
    /** False where the Agents tab lists the agents instead. */
    agents?: boolean;
    /** A pane's measured height for the roster's own scroll. */
    maxHeight?: number;
  }>,
) {
  const { roster } = props;
  const facts = summarizeDiscussionRoster(roster);
  const manager = props.canManage ? props.management : null;
  const principalTags = React.useCallback(
    (principal: SharePrincipalPresentation) =>
      principal.ref.kind === 'account' &&
      principal.ref.accountId !== props.viewerAccountId &&
      props.presentAccountIds.has(principal.ref.accountId)
        ? [t('session.collaboration.discussion.participants.hereNow')]
        : [],
    [props.presentAccountIds, props.viewerAccountId],
  );
  const agentSections = useDiscussionRosterAgentSections(props);
  // The Discussion page's rail lists agents in their own tab; the header's sheet keeps them here.
  const afterAccess = props.agents === false ? NO_SECTIONS : agentSections;
  return (
    <DiscussionParticipantsSheet
      scope={props.scope}
      {...(props.accountLifetime ? { accountLifetime: props.accountLifetime } : {})}
      discussionId={props.discussionId}
      discussionTitle={props.discussionTitle}
      roster={roster}
      // Without agents the sheet invites people only; the Agents tab invites agents.
      management={props.agents === false ? null : manager}
      afterAccess={afterAccess}
      principalTags={principalTags}
      notes={[facts.inherited
        ? t('session.collaboration.discussion.participants.inheritedNote')
        : t('session.collaboration.discussion.participants.privateNote')]}
      {...(props.onChanged ? { onChanged: props.onChanged } : {})}
      onRequestClose={props.onRequestClose}
      {...(props.maxHeight === undefined ? {} : { maxHeight: props.maxHeight })}
    />
  );
}

const REMOVE_ID = 'remove';
const OPEN_ID = 'open';
const RESTART_ID = 'restart';
const FOLLOW_ID = 'follow';
const MUTE_ID = 'mute';

/**
 * One agent's row menu (lab T2-S, P2). For whoever manages the Discussion it opens from the answer
 * policy pill and leads with the four policies; for everyone else it is the row's ⋯. Then, in order:
 * Follow… (the shared Follow editor for that Session), Mute its messages (this Account's exact
 * sender mute, with Undo), Open its session, Start it again and Remove. Removing a model started for
 * this Discussion archives that session; removing an existing session only detaches it.
 */
function DiscussionAgentMenu(
  props: Readonly<{
    testID: string;
    participant: RosterParticipant;
    title: string;
    sessionId: string | null;
    serverId: string;
    management: DiscussionParticipantManagement | null;
    /** Whether this Account mutes the Session's messages; null while its mutes are not known. */
    muted: boolean | null;
    accountLifetime?: ServerAccountScopeLifetime;
  }>,
) {
  const { theme } = useUnistyles();
  // A phone row keeps only a short value and its chevron beside the name (lab T2-Sp); a bordered field
  // there squeezed the agent's own subtitle to a few letters.
  const phone = useSurfaceStateSize() === 'phone';
  const navigateToSession = useNavigateToSession();
  const [open, setOpen] = React.useState(false);
  const { participant, management } = props;
  const model = participant.participant.kind === 'model';
  const policy = answerPolicyLabel(participant.answerPolicy);
  const busy = management?.operation.kind === 'working';
  const follow = useAccountSessionFollowEditorHost({
    serverId: props.sessionId ? props.serverId : null,
    sessionId: props.sessionId ?? '',
  });
  // What this menu last changed, until the Account's own mutes catch up.
  const [mutedHere, setMutedHere] = React.useState<boolean | null>(null);
  React.useEffect(() => setMutedHere(null), [props.muted]);
  const muted = mutedHere ?? props.muted ?? false;
  const changeMute = React.useCallback(function change(next: boolean) {
    const sessionId = props.sessionId;
    if (!sessionId) return;
    const key = `discussion-participant-mute:${sessionId}`;
    void setDiscussionParticipantMuted({ sessionId, muted: next, ...(props.accountLifetime ? { accountLifetime: props.accountLifetime } : {}) })
      .then((changed) => {
        if (!changed) {
          publishPresentationNotice({ key, severity: 'error', message: t('session.collaboration.discussion.manage.muteFailed') });
          return;
        }
        setMutedHere(next);
        publishPresentationNotice({
          key,
          severity: 'info',
          message: t(next ? 'session.collaboration.discussion.manage.mutedNotice' : 'session.collaboration.discussion.manage.unmutedNotice', { name: props.title }),
          emphasis: props.title,
          // Undo is the exact inverse: the same sender scope, removed.
          ...(next ? { undo: { label: t('common.undo'), run: () => change(false) } } : {}),
        });
      });
  }, [props.accountLifetime, props.sessionId, props.title]);
  const items = React.useMemo(() => {
    const policies = management ? ANSWER_POLICIES.map((value) => ({
      id: value,
      testID: `${props.testID}:policy:${value}`,
      title: answerPolicyLabel(value),
      subtitle: answerPolicyDescription(value),
      checked: value === participant.answerPolicy,
      category: t('session.collaboration.discussion.manage.answersGroup'),
    })) : [];
    // A model whose session never started keeps its slot; starting again reuses that slot.
    const unstarted = model && !props.sessionId;
    const category = t('session.collaboration.discussion.manage.operationsGroup');
    const iconColor = theme.colors.text.secondary;
    const operations = [
      ...(props.sessionId && follow.enabled
        ? [{
            id: FOLLOW_ID,
            testID: `${props.testID}:follow`,
            title: t('session.collaboration.discussion.manage.followParticipant'),
            icon: <Icon name="bell" size={ICON_SIZE.sm} color={iconColor} />,
            category,
          }]
        : []),
      ...(props.sessionId
        ? [{
            id: MUTE_ID,
            testID: `${props.testID}:mute`,
            title: muted
              ? t('session.collaboration.discussion.manage.unmuteParticipant')
              : t('session.collaboration.discussion.manage.muteParticipant'),
            icon: <Icon name="bell-slash" size={ICON_SIZE.sm} color={iconColor} />,
            category,
          }]
        : []),
      ...(props.sessionId
        ? [{
            id: OPEN_ID,
            testID: `${props.testID}:open`,
            title: t('session.collaboration.discussion.manage.openSession'),
            icon: <Icon name="arrow-square-out" size={ICON_SIZE.sm} color={iconColor} />,
            category,
          }]
        : []),
      ...(management && unstarted
        ? [{
            id: RESTART_ID,
            testID: `${props.testID}:restart`,
            title: t('session.collaboration.discussion.manage.startAgain'),
            subtitle: t('session.collaboration.discussion.manage.startAgainBody'),
            icon: <Icon name="arrow-clockwise" size={ICON_SIZE.sm} color={iconColor} />,
            category,
          }]
        : []),
      ...(management
        ? [{
            id: REMOVE_ID,
            testID: `${props.testID}:remove`,
            // Only a model whose session started has a session to archive.
            title: model && !unstarted
              ? t('session.collaboration.discussion.manage.removeModel')
              : t('session.collaboration.discussion.manage.removeSession'),
            ...(unstarted
              ? {}
              : { subtitle: model
                  ? t('session.collaboration.discussion.manage.removeModelBody')
                  : t('session.collaboration.discussion.manage.removeSessionBody') }),
            destructive: true,
            category,
          }]
        : []),
    ];
    return [...policies, ...operations];
  }, [follow.enabled, management, model, muted, participant.answerPolicy, props.sessionId, props.testID, theme.colors.text.secondary]);
  return (
    <View ref={follow.anchorRef} collapsable={false}>
    <DropdownMenu
      testID={`${props.testID}:menu`}
      open={open}
      onOpenChange={setOpen}
      items={items}
      {...(management ? { selectedId: participant.answerPolicy } : {})}
      separateCategories
      placement="bottom"
      popoverAnchorAlign="end"
      gap={4}
      maxWidthCap={360}
      matchTriggerWidth={false}
      popoverAccessibilityLabel={props.title}
      onSelect={(id) => {
        setOpen(false);
        if (id === OPEN_ID) {
          // The agent's own session, on this Discussion's Home.
          if (props.sessionId) void navigateToSession(props.sessionId, { serverId: props.serverId });
          return;
        }
        if (id === FOLLOW_ID) {
          if (props.sessionId) follow.openEditor({ address: { serverId: props.serverId, sessionId: props.sessionId } });
          return;
        }
        if (id === MUTE_ID) {
          changeMute(!muted);
          return;
        }
        if (!management) return;
        if (id === REMOVE_ID) {
          void management.remove(participant.participant);
          return;
        }
        if (id === RESTART_ID) {
          if ('launch' in participant && participant.participant.kind === 'model')
            void management.inviteExecutable(
              { kind: 'model', launch: participant.launch },
              { participantSlotId: participant.participant.participantSlotId, answerPolicy: participant.answerPolicy },
            );
          return;
        }
        const next = ANSWER_POLICIES.find((value) => value === id);
        if (next && next !== participant.answerPolicy) void management.setPolicy(participant.participant, next);
      }}
      trigger={({ toggle }) => management ? (
        <HappierPressable
          testID={props.testID}
          onPress={toggle}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`${props.title}: ${policy}`}
          accessibilityHint={t('session.collaboration.discussion.manage.rowHint')}
          expanded={open}
          hasPopup="menu"
          style={styles.policyTrigger}
        >
          {renderDropdownItemTriggerRightElement({
            detail: policy,
            open,
            detailColor: theme.colors.text.secondary,
            chevronColor: theme.colors.text.secondary,
            ...(phone ? {} : { field: resolveFieldBoxColors(theme), fieldSpan: 'intrinsic' as const }),
            detailDensity: 'compact',
          })}
        </HappierPressable>
      ) : (
        <IconButton
          testID={`${props.testID}:more`}
          size={28}
          variant="plain"
          icon={<Icon name="dots-three" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
          accessibilityLabel={`${t('common.moreActions')}, ${props.title}`}
          accessibilityHint={t('common.moreActionsHint')}
          onPress={toggle}
        />
      )}
    />
    {follow.editor}
    </View>
  );
}

/**
 * The Discussion page's Participants tab: the same roster sheet as the header's popover, people only
 * (agents have their own tab), with Leave at its foot. The owner's Leave resolves here too.
 */
export function DiscussionParticipantsPanel(
  props: Readonly<{
    scope: ServerAccountScope;
    accountLifetime?: ServerAccountScopeLifetime;
    discussionId: string;
    discussionTitle: string;
    serverId: string;
    viewerAccountId: string;
    roster: DiscussionParticipantRoster | null;
    onChanged?: () => void;
    accountActors: ReadonlyMap<string, TranscriptAccountActor>;
    presentAccountIds: ReadonlySet<string>;
    resolveAccountLabel: (accountId: string) => string | null;
    onLeave?: () => void;
    management?: DiscussionParticipantManagement | null;
    canManage?: boolean;
    onLeft?: () => void;
  }>,
) {
  const management = props.management ?? null;
  const resolving = management?.ownerLeave.kind === 'transfer_or_archive';
  const [bodyHeight, setBodyHeight] = React.useState<number | null>(null);
  return (
    <View testID="discussion-participants-tab" style={styles.panel}>
      <View style={styles.panelBody} onLayout={(event) => {
        // The roster's list owns the scroll; it needs the pane's height to stop at the foot (Leave, phone bar).
        const height = Math.floor(event.nativeEvent.layout.height);
        setBodyHeight(current => current === height ? current : height);
      }}>
        {resolving && management && props.roster ? (
          <DiscussionOwnerLeaveResolution
            management={management}
            accountActors={props.accountActors}
            scope={props.scope}
            resolveAccountLabel={props.resolveAccountLabel}
            onLeft={() => props.onLeft?.()}
          />
        ) : props.roster ? (
          <DiscussionRoster
            scope={props.scope}
            {...(props.accountLifetime ? { accountLifetime: props.accountLifetime } : {})}
            discussionId={props.discussionId}
            discussionTitle={props.discussionTitle}
            serverId={props.serverId}
            viewerAccountId={props.viewerAccountId}
            roster={props.roster}
            presentAccountIds={props.presentAccountIds}
            management={management}
            canManage={props.canManage === true && management !== null}
            {...(props.onChanged ? { onChanged: props.onChanged } : {})}
            onRequestClose={() => undefined}
            agents={false}
            {...(bodyHeight === null ? {} : { maxHeight: bodyHeight })}
          />
        ) : (
          <EmptyState layout="line" lineLoading title={t('session.collaboration.discussion.participants.loading')} />
        )}
      </View>
      {props.onLeave && props.roster ? (
        <View style={styles.footer}>
          {resolving ? (
            <View style={styles.footerEnd}>
              <RoundButton testID="discussion-participants-cancel-leave" size="small" display="secondary" title={t('common.cancel')}
                disabled={management?.ownerLeave.kind === 'transfer_or_archive' && !management.ownerLeave.canCancel}
                onPress={() => management?.cancelLeave()} />
            </View>
          ) : (
            <RoundButton testID="discussion-participants-leave" size="small" display="secondary"
              title={t('session.collaboration.discussion.participants.leave')} onPress={() => props.onLeave?.()} />
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The Discussion page's Agents tab: who answers here (Sessions, then models started here) with each one's
 * answer policy, and, for whoever manages it, the viewer's Sessions and models to add.
 */
export function DiscussionAgentsPanel(
  props: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    serverId: string;
    roster: DiscussionParticipantRoster | null;
    management: DiscussionParticipantManagement | null;
    canManage: boolean;
  }>,
) {
  if (!props.roster) {
    return <View testID="discussion-agents-tab" style={styles.panel}>
      <EmptyState layout="line" lineLoading title={t('session.collaboration.discussion.participants.loading')} />
    </View>;
  }
  return <DiscussionAgentsList {...props} roster={props.roster} />;
}

function DiscussionAgentsList(
  props: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    serverId: string;
    roster: DiscussionParticipantRoster;
    management: DiscussionParticipantManagement | null;
    canManage: boolean;
  }>,
) {
  const manager = props.canManage ? props.management : null;
  const current = useDiscussionRosterAgentSections(props);
  const [readinessSessionId, setReadinessSessionId] = React.useState<string | null>(null);
  const inviteExecutable = manager?.inviteExecutable;
  const onChoose = React.useCallback((selection: ExecutableParticipantSelectionV1) => {
    void inviteExecutable?.(selection);
  }, [inviteExecutable]);
  const { sections: candidates, recipeEditor } = useExecutableParticipantSections({
    accountLifetime: props.accountLifetime,
    roster: props.roster,
    busy: manager?.operation.kind === 'working',
    sessionsContext: t('session.collaboration.discussion.manage.sessionCandidate'),
    onChoose,
    enabled: manager !== null,
    readinessSessionId,
    onReadinessSessionChange: setReadinessSessionId,
  });
  const rootStep = React.useMemo(() => ({
    id: 'root',
    sections: manager ? [...current, ...candidates] : current,
  }), [candidates, current, manager]);
  return recipeEditor ?? (
    <View testID="discussion-agents-tab" style={styles.panel}>
      <SelectionList
        testID="discussion-agents-list"
        rootStep={rootStep}
        listAccessibilityLabel={t('session.collaboration.discussion.participants.agentsGroup')}
        onSelect={() => undefined}
        onRequestClose={() => undefined}
        optionsHostInlineControls
        selectionMark="none"
        surface="none"
        fillAvailableSpace
        disableTransitions
      />
      {props.management ? <DiscussionParticipantOperationLine management={props.management} serverId={props.serverId} /> : null}
    </View>
  );
}
