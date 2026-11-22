import { SHARE_SHEET_HOST } from '@/components/sharing/shareSheetHost';
import type { DiscussionParticipantRoster } from './useDiscussionParticipantManagement';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { projectDiscussionModelParticipantLaunchV1 } from '@happier-dev/protocol/discussions/participants';
import {
  normalizeExecutableParticipantSelectionV1,
  type ExecutableParticipantSelectionV1,
} from '@happier-dev/protocol/discussions/executableParticipants';
import { SessionServerStartSpawnDraftV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import type { SessionReadinessRepairV1, SessionReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import type { MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import type { ExecutableParticipantPickerOption } from '@/components/sessions/authoring/executableParticipantPicker';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getStorage, useMachineListForServer } from '@/sync/domains/state/storage';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { resolveMachineActionCandidates } from '@/utils/sessions/resolveMachineActionCandidates';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { useDiscussionInviteCandidates } from './useDiscussionInviteCandidates';
import { SharePrincipalVisual } from '@happier-dev/plugin-ui/components';
import type { SharePrincipalPresentation } from '@/components/sharing/shareSheetTypes';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { describeMachineReadinessCause, presentSessionReadiness } from '@/components/sessions/model/sessionReadinessPresentation';
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { SessionServerStartDraftRecipeEditor } from '@/components/sessions/new/SessionServerStartDraftRecipeEditor';
import type { SessionServerStartDraftSeed, SessionServerStartDraftTarget } from '@/components/sessions/new/serverStartDraftComposer';

/**
 * A not-ready choice stays listed and selectable with its one cause in place of the usual hint
 * (C7): an offline Bot or current Machine stays visible, and unknown never reads as ready.
 */
function readinessCause(readiness: ExecutableParticipantSectionOption['readiness']): string | null {
  if (!readiness) return null;
  if ('v' in readiness) {
    const presented = presentSessionReadiness({ readiness, repair: null, demanded: true, loading: false, unavailableReason: null });
    return presented.tone === 'attention' ? (presented.cause ?? presented.title) : null;
  }
  return describeMachineReadinessCause(readiness);
}

function readinessSubtitle(readiness: ExecutableParticipantSectionOption['readiness'], fallback: string): string {
  return readinessCause(readiness) ?? fallback;
}

export type ExecutableParticipantSectionOption = SelectionListOption & Readonly<{
  /** A selected launch/Session has full facts; a not-yet-configured model target has Machine facts only. */
  readiness?: SessionReadinessV1 | MachineSpawnReadiness | null;
  repair?: SessionReadinessRepairV1 | null;
}>;
type ExecutableParticipantSection = Omit<Extract<SelectionListSectionDescriptor, { kind: 'static' }>, 'options'> & Readonly<{
  options: readonly ExecutableParticipantSectionOption[];
}>;

/** The option id of a Session participant; the same id marks it chosen in a multi-choice list. */
export function executableParticipantOptionId(
  selection: ExecutableParticipantSelectionV1,
): string | null {
  return selection.kind === 'session'
    ? `session:${selection.session.sessionId}`
    : null;
}

/**
 * The one presenter of who can take part (lab dpRev): existing Sessions, then Bots from the same
 * exact-Home Session inventory, and models already taking part. Nothing new is listed by default:
 * `addAgent` opens the ordinary session setup (the shared authoring chips and the Where chip) on the
 * consumer's Machine and folder, and its result is chosen like any other row.
 * Mount it only while a participant choice is open: it reads the session listing and machines.
 * Discussion invites and Workflow participant inputs both choose through it.
 */
export function useExecutableParticipantSections(
  input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    enabled: boolean;
    /** Filters rows when the host owns the search field; omit when the list filters itself. */
    query?: string;
    roster?: DiscussionParticipantRoster | null;
    busy?: boolean;
    readinessSessionId?: string | null;
    onReadinessSessionChange?: (sessionId: string | null) => void;
    modelOptions?: readonly ExecutableParticipantPickerOption[];
    requireWorkspaceWriteDenial?: boolean;
    preferredMachineId?: string | null;
    /** The Session this choice is for: an added agent starts on its Machine and folder. */
    consumerSessionId?: string | null;
    /** The launch profile an added agent starts from (the New Session profile intent), still editable in its recipe. */
    seedProfileId?: string | null;
    /** How the viewer's sessions take part here; said once beside the section title, not on every row. */
    sessionsContext: string;
    onChoose: (selection: ExecutableParticipantSelectionV1) => void;
    /**
     * New Discussion: people of this Home lead the list (chosen with `onChoosePerson`), and only existing
     * Sessions follow — a model is started only once a Discussion exists to start it in.
     */
    people?: Readonly<{
      onChoose: (participant: Readonly<{ kind: 'account'; accountId: string }>) => void;
      title: string;
      /** Who is already chosen: listed while nothing is typed, so each can be unchosen. */
      chosen: readonly SharePrincipalPresentation[];
      /** An opinion can invite people and start new reviewers in the same Discussion. */
      includeModels?: boolean;
    }>;
  }>,
) {
  const { theme } = useUnistyles();
  const serverId = input.accountLifetime.scope.serverId;
  const candidates = useDiscussionInviteCandidates({
    accountLifetime: input.accountLifetime,
    availability: 'available',
    enabled: input.enabled,
    roster: input.roster ?? null,
    readinessSessionId: input.readinessSessionId,
    modelOptions: input.modelOptions,
  });
  const machines = useMachineListForServer(serverId, input.enabled);
  const machinesLoaded = machines != null;
  const presence = useMachinePresenceSummaries(serverId, input.enabled ? (machines ?? []).map(machine => machine.id) : [], input.accountLifetime);
  const { onChoose, sessionsContext, onReadinessSessionChange } = input;
  const [recipe, setRecipe] = React.useState<Readonly<{
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
    onChoose: (selection: ExecutableParticipantSelectionV1) => void;
  }> | null>(null);
  const editModel = React.useCallback((selection: Extract<ExecutableParticipantSelectionV1, { kind: 'model' }>,
    onReplace: (selection: ExecutableParticipantSelectionV1) => void) => {
    const existingDraft = SessionServerStartSpawnDraftV1Schema.parse(selection.launch);
    setRecipe({ seed: { existingDraft }, target: existingDraft.executionTarget, onChoose: onReplace });
  }, []);
  const busy = input.busy === true;
  const query = input.query ?? '';
  // Setup remains selectable offline. Start re-admits through the ordinary authoring owner.
  const launchMachines = React.useMemo(() => input.enabled ? resolveMachineActionCandidates(
    input.accountLifetime.scope,
    (machines ?? []).filter(isMachineVisibleForLaunchSelection),
    { onlineOnly: false },
  ) : [], [input.accountLifetime.scope, input.enabled, machines]);
  // The viewer has no Machine and nothing else can join (no Session, Bot or model): agents can't be offered
  // here at all. Decided once: the list says so and how to add a Machine, and the search stops promising them.
  // A Machine list or Session read that has not landed is unknown, not empty.
  const noAgentToOffer = machinesLoaded && launchMachines.length === 0 && candidates.candidates.length === 0
    && candidates.sessions.status === 'ready';
  const router = useRouter();
  const sections = React.useMemo<readonly ExecutableParticipantSection[]>(() => {
    if (!input.enabled) return [];
    // A session leads with its Agent's own mark (identity marks always stay); the catalog decides
    // whether one exists, and a session without a recorded Agent keeps the neutral glyph.
    const sessionMark = (agentId: string | null | undefined, machineId: string | null | undefined) => (
      <SessionAgentCatalogIdentityIcon agentId={agentId ?? ''} machineId={machineId ?? null} serverId={serverId} size={ICON_SIZE.md} />
    );
    const modelMark = (
      <Icon
        name="sparkle"
        size={ICON_SIZE.md}
        color={theme.colors.text.secondary}
      />
    );
    const needle = query.trim().toLocaleLowerCase();
    const matches = (text: string) =>
      needle.length === 0 || text.toLocaleLowerCase().includes(needle);
    const sessions: ExecutableParticipantSectionOption[] = [];
    let listedSessions = 0;
    const bots: ExecutableParticipantSectionOption[] = [];
    for (const candidate of candidates.candidates) {
      if (candidate.kind !== 'session' || !matches(
        [candidate.label ?? t('session.collaboration.discussion.participants.session'), candidate.contextLabel].filter(Boolean).join(' '),
      )) continue;
      if (!candidate.bot) listedSessions += 1;
      (candidate.bot ? bots : sessions).push({
        id: `session:${candidate.selection.session.sessionId}`,
        testID: `discussion-invite-session-${candidate.selection.session.sessionId}`,
        label: candidate.label ?? t('session.collaboration.discussion.participants.session'),
        subtitle: readinessSubtitle(candidate.readiness, [candidate.lastActivityAt == null ? null
          : formatRelativeTimeShort(candidate.lastActivityAt, Date.now()), candidate.contextLabel].filter(Boolean).join(' · ')),
        icon: sessionMark(candidate.agentId, candidate.machineId),
        ...(candidate.bot ? { titleAccessory: (
          <StatusPill variant="neutral" hideDot labelVariant="phrase" label={t('sessionsList.conditionBot')} />
        ) } : {}),
        disabled: busy,
        readiness: candidate.readiness,
        repair: candidate.repair,
        onHighlight: () => onReadinessSessionChange?.(candidate.selection.session.sessionId),
        onPressIn: () => onReadinessSessionChange?.(candidate.selection.session.sessionId),
        onSelect: () => onChoose(candidate.selection),
      });
    }
    const stateRow = (
      id: string,
      label: string,
      icon: React.ReactElement,
      extra: Partial<ExecutableParticipantSectionOption>,
    ): ExecutableParticipantSectionOption => ({
      id: `sessions:${id}`,
      testID: `discussion-invite-sessions-${id}`,
      label,
      subtitle: '',
      icon,
      onHighlight: () => onReadinessSessionChange?.(null),
      onPressIn: () => onReadinessSessionChange?.(null),
      ...extra,
    });
    const spinner = <ActivitySpinner size={iconMatchedSpinnerSize(ICON_SIZE.md)} color={theme.colors.text.tertiary} />;
    const { status, hasMore, loadingMore, pageFailed } = candidates.sessions;
    const retryRow = (label: string) => stateRow(
      'retry',
      label,
      <Icon name="arrow-clockwise" size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
      { subtitle: t('workflows.conversation.retryLoadingSessions'), onSelect: () => { void candidates.sessions.retry(); } },
    );
    // The query owner's real state, in place: a first read that has not landed is neither empty nor
    // pagination; only a held continuation offers More, and a failed page keeps what was loaded.
    if (status === 'loading') {
      sessions.push(stateRow('loading', t('workflows.conversation.sessionsLoading'), spinner, { disabled: true }));
    } else if (status === 'failed') {
      sessions.push(retryRow(t('workflows.conversation.sessionsFailed')));
    } else if (status === 'ready' && needle.length === 0) {
      if (pageFailed) {
        sessions.push(retryRow(t('session.collaboration.discussion.participants.moreSessionsFailed')));
      } else if (loadingMore) {
        sessions.push(stateRow('more', t('session.collaboration.discussion.secondOpinion.moreSessions'), spinner, { disabled: true }));
      } else if (hasMore) {
        sessions.push(stateRow(
          'more',
          t('session.collaboration.discussion.secondOpinion.moreSessions'),
          <Icon name="dots-three" size={ICON_SIZE.md} color={theme.colors.text.tertiary} />,
          { onSelect: () => { void candidates.sessions.loadMore(); } },
        ));
      }
    }
    const machineById = new Map(launchMachines.map((machine) => [machine.id, machine]));
    const readinessByMachineId = new Map(launchMachines.map((machine) => [machine.id,
      resolveMachineSpawnReadiness({ machine, selectedMachineId: machine.id, scope: input.accountLifetime.scope })]));
    const models: ExecutableParticipantSectionOption[] = candidates.candidates.flatMap(candidate => candidate.kind === 'model' && matches(candidate.label)
      ? [{ id: candidate.key, label: candidate.label, subtitle: readinessSubtitle(candidate.readiness, ''), icon: modelMark, disabled: busy,
          readiness: candidate.readiness, repair: candidate.repair, onHighlight: () => onReadinessSessionChange?.(null),
          onPressIn: () => onReadinessSessionChange?.(null), onSelect: () => onChoose(candidate.selection) }] : []);
    // Nothing of the viewer's can answer (lab flOpinion:emptyP): every Machine of theirs is not ready and every
    // listed Session of theirs runs on one of them. Said once, leading the list, from the facts the rows already
    // carry; Bots run with their Team's setup and stay choosable. Unknown readiness never counts as not ready.
    // A viewer with no Machine at all and nothing else to choose gets the same line, naming how to add one; a
    // Machine list that has not loaded is unknown, not empty.
    const noMachineToAnswer = needle.length === 0 && noAgentToOffer;
    const nothingCanAnswer = noMachineToAnswer || (needle.length === 0 && status === 'ready' && launchMachines.length > 0
      && [...readinessByMachineId.values()].every((readiness) => readinessCause(readiness) !== null)
      && candidates.candidates.every((candidate) => candidate.kind === 'session'
        ? candidate.bot === true || (candidate.machineId != null && machineById.has(candidate.machineId))
        : candidate.kind !== 'model' || readinessCause(candidate.readiness) !== null));
    if (nothingCanAnswer) {
      const showModels = models.length > 0 && (!input.people || input.people.includeModels);
      (showModels ? models : sessions).unshift(stateRow(
        'unavailable',
        t('session.collaboration.discussion.secondOpinion.nothingCanAnswer'),
        <Icon name="cloud-slash" size={ICON_SIZE.md} color={theme.colors.text.tertiary} />,
        noMachineToAnswer
          ? { subtitle: t('addFlows.addMachineDescription'),
            onSelect: () => router.push(buildMachineAddHref({ serverId }) as never),
            // The next step reads as one, as "Find friends" does for people.
            rightAccessoryOutsidePressable: true,
            rightAccessory: <TextLinkButton testID="discussion-invite-add-machine" tone="strong" size="meta"
              label={t('settings.addMachine')} onPress={() => router.push(buildMachineAddHref({ serverId }) as never)} /> }
          : { subtitle: t('session.collaboration.discussion.secondOpinion.nothingCanAnswerBody'), disabled: true },
      ));
    }
    const sections: ExecutableParticipantSection[] = [];
    if (sessions.length)
      sections.push({
        kind: 'static',
        id: 'agents-sessions',
        title: t('session.collaboration.discussion.manage.sessionsGroup'),
        // How listed Sessions answer; said only over Sessions, never over a status line alone.
        ...(listedSessions > 0 ? { rightAccessory: (
          <Text numberOfLines={1} style={{ ...Typography.variant('meta'), color: theme.colors.text.tertiary }}>
            {sessionsContext}
          </Text>
        ) } : {}),
        options: sessions,
      });
    if (bots.length)
      sections.push({
        kind: 'static',
        id: 'agents-bots',
        title: t('bots.title'),
        options: bots,
      });
    if (models.length && (!input.people || input.people.includeModels))
      sections.push({
        kind: 'static',
        id: 'agents-models',
        title: t('session.collaboration.discussion.manage.modelsGroup'),
        options: models,
      });
    return sections;
  }, [
    busy,
    candidates.candidates,
    candidates.sessions,
    input.accountLifetime.scope,
    input.enabled,
    input.people,
    launchMachines,
    noAgentToOffer,
    router,
    query,
    onChoose,
    onReadinessSessionChange,
    presence,
    serverId,
    sessionsContext,
    theme.colors.text.secondary,
    theme.colors.text.tertiary,
  ]);
  // New Discussion: the Home's people lead, found as the person types through the shared directory
  // (its own pagination and cancellation); the viewer is never offered to themselves.
  const people = input.people;
  const viewerAccountId = input.accountLifetime.scope.accountId;
  const resolvePeople = candidates.people.resolve;
  const browsePeople = candidates.candidates;
  const peopleSection = React.useMemo<SelectionListSectionDescriptor | null>(() => {
    if (!people || !input.enabled) return null;
    const toOption = (principal: SharePrincipalPresentation): ExecutableParticipantSectionOption[] => {
      const ref = principal.ref;
      if (ref.kind !== 'account' || ref.accountId === viewerAccountId) return [];
      return [{ id: `account:${ref.accountId}`,
        testID: `discussion-invite-person-${ref.accountId}`,
        label: principal.displayName,
        ...(principal.secondaryLabel ? { subtitle: principal.secondaryLabel } : {}),
        accessibilityLabel: principal.accessibilityLabel,
        icon: () => <SharePrincipalVisual host={SHARE_SHEET_HOST} principal={principal} testID={`discussion-invite-person-visual-${ref.accountId}`} />,
        disabled: busy,
        onSelect: () => people.onChoose({ kind: 'account', accountId: ref.accountId }) }];
    };
    const principals = (rows: typeof browsePeople) => rows.flatMap(candidate => candidate.kind === 'account' ? [candidate.principal] : []);
    return {
      kind: 'dynamic', id: 'people', title: people.title,
      resolverKey: JSON.stringify(['people', candidates.people.resolverKey ?? 'account', busy, people.chosen.map(principal => principal.key)]),
      resultFiltering: 'provider', resultTransition: 'none', loadingSkeletonRows: 1,
      resolve: async (query, signal) => ({
        options: query.trim()
          ? principals(await resolvePeople(query, signal)).flatMap(toOption)
          : [...people.chosen, ...principals(browsePeople).filter(principal => !people.chosen.some(chosen => chosen.key === principal.key))].flatMap(toOption),
      }),
    };
  }, [browsePeople, busy, candidates.people.resolverKey, input.enabled, people, resolvePeople, viewerAccountId]);
  // Add an agent (lab dpRev `add`): the consumer Session's Machine and folder, else the caller's Machine,
  // else the first launchable one. Read once at the press; nothing here subscribes to the Session.
  const consumerSessionId = input.consumerSessionId ?? null;
  const preferredMachineId = input.preferredMachineId ?? null;
  const seedProfileId = input.seedProfileId ?? null;
  const addAgent = React.useMemo(() => launchMachines.length === 0 ? null : () => {
    const session = consumerSessionId
      ? selectHomeQualifiedSession(getStorage().getState(), consumerSessionId, serverId, getActiveServerSnapshot().serverId) : null;
    const metadata = session ? readSessionOwnerMetadataView(session) : null;
    const machineId = [metadata?.machineId, preferredMachineId].find(id => id && launchMachines.some(machine => machine.id === id))
      ?? launchMachines[0]!.id;
    const directory = metadata?.machineId === machineId && metadata.path ? metadata.path : undefined;
    setRecipe({ seed: { permissionMode: 'read-only', ...(directory ? { directory } : {}),
      ...(seedProfileId ? { profileId: seedProfileId } : {}) },
      target: { serverId, machineId }, onChoose });
  }, [consumerSessionId, launchMachines, onChoose, preferredMachineId, seedProfileId, serverId]);
  const recipeEditor = input.enabled && recipe ? <SessionServerStartDraftRecipeEditor
    seed={recipe.seed} target={recipe.target}
    requireWorkspaceWriteDenial={input.requireWorkspaceWriteDenial}
    onResolve={draft => {
      setRecipe(null);
      if (!draft || !input.accountLifetime.isCurrent()) return;
      const selection = normalizeExecutableParticipantSelectionV1({ kind: 'model', launch: projectDiscussionModelParticipantLaunchV1(draft) });
      if (selection) recipe.onChoose(selection);
    }} /> : null;
  return { sections, peopleSection, sessions: candidates.sessions, recipeEditor, editModel, addAgent, offersAgents: !noAgentToOffer };
}
