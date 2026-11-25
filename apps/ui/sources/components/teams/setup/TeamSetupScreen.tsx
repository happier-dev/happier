import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { ProjectSourceOnboardingTaskSelectionV1 } from '@happier-dev/protocol/projects/sources/projectSourceOnboardingTaskV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { suggestProjectOpenDestination } from '@/components/projects/activation/projectOpenChoices';
import { buildProjectRouteHref } from '@/components/projects/detail/projectRouteState';
import { PROJECT_USE_SHARED_SETUP_PARAM } from '@/components/projects/projectSetup/sharedSetupRoute';
import { useMachinePresetUpdates } from '@/components/machines/setup/useMachinePresetUpdates';
import { MachineSignInsSection } from '@/components/machines/setup/MachineSignInsSection';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { presentProjectSourceIssue } from '@/components/projects/sources/projectSourceIssue';
import { projectSourceRoute } from '@/components/projects/sources/projectSourceNavigation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { MachineSetupContents } from '@/components/settings/machines/managed/MachineSetupContents';
import { MachineSetupPlanReview } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { TeamHeaderAvatar } from '@/components/settings/teams/TeamHeaderAvatar';
import { useSourceSetupRequirementNames, type SourceSetupRequirementRead } from '@/components/settings/teams/newMembers/useSourceSetupRequirementNames';
import {
  deliveryModeLabel,
  recipientDeliveryMode,
  resourceStateLabel,
} from '@/components/settings/teams/credentials/teamCredentialPresentation';
import { TeamSection } from '@/components/settings/teams/TeamSection';
import { teamPageHeaderMeta, type TeamSectionContext } from '@/components/settings/teams/teamSectionContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { PageAsideColumns } from '@/components/ui/layout/PageAsideColumns';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useLayoutPresentationActive, useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { GITHUB_CONNECTED_SERVICE_ROUTE } from '@/sync/domains/connectedServices/githubConnectedServiceRoute';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
  useMachineAdministrationTargetSelection,
  type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import {
  areServerAccountScopesEqual,
  serverAccountScopedResourceKey,
  type ServerAccountScopeLifetime,
} from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { createWorkflowInvocationRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
  useActiveServerAccountScopeLifetime,
  useServerScopedMachine,
  useServerScopedMachineLabelState,
  useWorkspaceRefsSelector,
} from '@/sync/store/hooks';
import { useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { buildTeamSetupPlan, type TeamSetupPlan, type TeamSetupSessionTarget } from './teamSetupPlan';
import { buildTeamSetupRepository } from './teamSetupRepositories';
import { useTeamSetupExistingClones, type TeamSetupExistingClones } from './useTeamSetupExistingClones';
import { useTeamSetupFirstTask } from './useTeamSetupFirstTask';
import { findTeamSetupSourceCheckout, TeamSetupSourceChangeNotice, useTeamSetupCheckoutSetup } from './TeamSetupSourceChange';
import { useRetainedTeamSetupPlan } from './TeamSetupPlanProvider';
import type { TeamSetupBatch } from './useTeamSetupPlan';
import { useTeamSetupBatchProgress, type TeamSetupRepositoryPhase } from './useTeamSetupBatchProgress';
import { useTeamSetupHeldReviews } from './useTeamSetupRepositoryProgress';
import {
  useTeamSetupResources,
  type TeamSetupResources,
} from './useTeamSetupResources';

const NO_KEYS: readonly never[] = Object.freeze([]);

export type TeamSetupRunState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'running'; operationId: string | null }>
  | Readonly<{ kind: 'approval'; operationId: null; artifactId: string }>
  | Readonly<{
      kind: 'stopped';
      operationId: string | null;
      failure: ActionExecuteFailure | null;
    }>
  | Readonly<{ kind: 'done'; operationId: string | null; completed: boolean }>;

function readTeamSetupRunState(batch: TeamSetupBatch | null): TeamSetupRunState {
  if (!batch) return { kind: 'idle' };
  if (batch.approvalArtifactId) return { kind: 'approval', operationId: null, artifactId: batch.approvalArtifactId };
  const machine = batch.settlement?.machine ?? batch.machine;
  const operationId = machine?.ok && 'operationId' in machine.result ? machine.result.operationId : null;
  if (batch.running) return { kind: 'running', operationId };
  const failure = machine && !machine.ok ? machine : batch.settlement?.machineSettlement;
  if (failure || !batch.settlement) return { kind: 'stopped', operationId, failure: failure ?? null };
  const approval = machine?.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(machine.result) : null;
  if (approval?.success) return { kind: 'approval', operationId: null, artifactId: approval.data.artifactId };
  return { kind: 'done', operationId, completed: batch.completed };
}

export type TeamSetupPreparedMachine = Readonly<{
  key: string;
  plan: TeamSetupPlan | null;
  failure: ActionExecuteFailure | null;
}>;

function readHomeDir(
  machine: Readonly<{ metadata?: unknown }> | null,
): string | null {
  const homeDir = (
    machine?.metadata as { homeDir?: unknown } | null | undefined
  )?.homeDir;
  return typeof homeDir === 'string' && homeDir ? homeDir : null;
}

export type TeamSetupFirstTaskView = Readonly<{
  title: string;
  markdown: string;
  repositoryName: string;
  onOpen: () => void;
}>;

/**
 * Set up for a Team (plan D, L2): everything the Team expects on one of the member's Machines, in one
 * place, reviewed before anything runs. The Machine preset's own plan review and the ordinary Project
 * Open owner do the work; this page only chooses the Machine and which shared repositories to include.
 */
export const TeamSetupScreen = React.memo(function TeamSetupScreen(
  props: Readonly<{
    serverId: string;
    teamId: string;
    /**
     * Preview as a member (plan D, L5): the same page from the same Team, Source, preset and key reads a member
     * makes, with no Machine chosen and nothing to run. Opened from What new members get.
     */
    preview?: boolean;
  }>,
) {
  return (
    <TeamSection
      serverId={props.serverId}
      teamId={props.teamId}
      childRendersHeader
      pageColumn="wide"
    >
      {(context, conditions) =>
        context.archived ? null : <TeamSetupBody context={context} conditions={conditions} preview={props.preview === true} />
      }
    </TeamSection>
  );
});

/** The Team's lockup and, only while there is something to review, the page's promise. */
export function TeamSetupHeader(props: Readonly<{
  context: Pick<TeamSectionContext, 'team' | 'address' | 'homeName'>;
  lead: boolean;
  preview?: boolean;
  /** Once setup finished, the page says where it finished instead of promising what will run. */
  doneOn?: string | null;
}>) {
  const { team, address, homeName } = props.context;
  const done = props.doneOn !== undefined;
  const title = done
    ? t('teams.join.setupPage.doneTitle', { machine: props.doneOn ?? t('teams.join.setupPage.yourMachine') })
    : t('teams.join.setUpForTeam', { team: team.name });
  // The Team's identity line, as every Team page draws it (which Team, on which Home); "Suggested by"
  // joins it only while there is a setup to suggest.
  const facts = teamPageHeaderMeta({ pageTitle: title, teamName: team.name, homeName });
  return (
    <PageHeader
      testID="team-setup-header"
      alwaysShowTitle
      title={title}
      description={props.lead && !done
        ? t(props.preview ? 'teams.join.setupPage.previewLead' : 'teams.join.setupPage.lead', { team: team.name })
        : undefined}
      leading={<TeamHeaderAvatar address={address} team={team} />}
      meta={props.lead && !done ? [...facts, { key: 'suggested', text: t('teams.join.setupPage.suggestedBy', { team: team.name }) }] : facts}
    />
  );
}

function TeamSetupBody(props: Readonly<{ context: TeamSectionContext; conditions?: React.ReactNode; preview: boolean }>) {
  const lifetime = useActiveServerAccountScopeLifetime();
  if (
    !lifetime ||
    !areServerAccountScopesEqual(lifetime.scope, props.context.scope)
  ) {
    return (
      <>
      <TeamSetupHeader context={props.context} lead={false} />
      {props.conditions}
      <SurfaceStateCard
        testID="team-setup-other-account"
        kind="error"
        size="line"
        title={t('teams.join.setupPage.otherAccount')}
      />
      </>
    );
  }
  return <TeamSetupPlanPage context={props.context} conditions={props.conditions} lifetime={lifetime} preview={props.preview} />;
}

function TeamSetupPlanPage(
  props: Readonly<{
    context: TeamSectionContext;
    conditions?: React.ReactNode;
    lifetime: ServerAccountScopeLifetime;
    preview: boolean;
  }>,
) {
  const { context } = props;
  const router = useRouter();
  const presented = useLayoutPresentationActive();
  const presentation = useLayoutPresentationSignal();
  const mounted = React.useRef(false);
  React.useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isReviewPresented = React.useCallback(() => mounted.current && presentation.get(), [presentation]);
  const teamName = context.team.name;
  const resources = useTeamSetupResources({
    scope: context.scope,
    address: context.address,
    team: context.team,
    lifetime: props.lifetime,
    preview: props.preview,
  });
  const homeId =
    getServerProfileById(context.scope.serverId)?.serverIdentityId ?? null;
  const repositories = resources.repositorySources;
  const heldReviews = useTeamSetupHeldReviews(context.scope, repositories, props.preview);
  // A held review waits on the Machine it was admitted to: the page opens on that Machine (as a route target, until
  // the person picks another), so a cold return still shows where it runs. Kept once seen, so approving it doesn't
  // take the Machine away while its setup runs.
  const heldMachineId = heldReviews.values().next().value?.snapshot.scope.machineId ?? null;
  const [heldTarget, setHeldTarget] = React.useState<MachineAdministrationTargetV1 | null>(null);
  if (!heldTarget && heldMachineId && homeId) setHeldTarget({ serverIdentityId: homeId, machineId: heldMachineId });
  const selection = useMachineAdministrationTargetSelection(
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines,
    {
      accountScope: context.scope,
      ...(heldTarget ? { initialTarget: heldTarget } : {}),
    },
  );
  // A preview stands for a new member's own machine: none of the viewer's Machines is read or planned against.
  const machineId = props.preview ? null : selection.selectedTarget?.machineId ?? null;
  // Undefined while the Machine's name (and the home folder that comes with its record) is still opening.
  const machineLabelState = useServerScopedMachineLabelState(context.scope.serverId, machineId);
  const machineName = machineLabelState ?? null;
  const homeDir = useServerScopedMachine(
    context.scope.serverId,
    machineId,
    readHomeDir,
  );

  const [execute] = React.useState(() => createFrontDoorActionExecute());
  const actionContext = React.useMemo(
    () => ({
      surface: 'ui' as const,
      serverId: context.scope.serverId,
      expectedAccountId: context.scope.accountId,
    }),
    [context.scope.accountId, context.scope.serverId],
  );
  const { batch: retainedBatch, prepare, run: runPlan, openFirstTask } = useRetainedTeamSetupPlan();
  const currentBatch = !props.preview && retainedBatch?.selection.team.serverId === context.address.serverId
    && retainedBatch.selection.team.teamId === context.address.teamId
    && retainedBatch.selection.lifetime === props.lifetime ? retainedBatch : null;

  const presetValue = resources.preset?.state.value ?? null;
  const githubServiceKey = resolveQualifiedConnectedAccountServiceKey(GITHUB_CONNECTED_SERVICE_ROUTE.params.serviceId);
  const [excluded, setExcluded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [dismissedRun, dismissRun] = React.useState<TeamSetupBatch['selection'] | null>(null);
  const [selectionFailed, setSelectionFailed] = React.useState(false);
  const run = selectionFailed ? { kind: 'stopped' as const, operationId: null, failure: null }
    : readTeamSetupRunState(currentBatch && currentBatch.selection !== dismissedRun ? currentBatch : null);
  const approval = useInPlaceApprovalReview({ approvalId: run.kind === 'approval' ? run.artifactId : null,
    approvalPending: run.kind === 'approval', serverId: context.scope.serverId });

  // The preset's own plan is read for the chosen Machine so each step shows before anything runs.
  const prepareKey =
    machineId && homeId && presetValue
      ? JSON.stringify([context.scope.serverId, context.scope.accountId, homeId, machineId, presetValue.id, presetValue.revision])
      : null;
  const [prepared, setPrepared] = React.useState<TeamSetupPreparedMachine | null>(null);
  const prepareKeyRef = React.useRef(prepareKey);
  prepareKeyRef.current = prepareKey;
  // A refetch of the same preset revision is the same plan: the read is keyed by revision, not identity.
  const presetRef = React.useRef(presetValue);
  presetRef.current = presetValue;
  React.useEffect(() => {
    const preset = presetRef.current;
    if (!prepareKey || !machineId || !homeId || !preset) return;
    const key = prepareKey;
    void prepare({
        target: { serverId: context.scope.serverId, homeId, machineId },
        preset,
        repositories: [],
        isCurrent: () => prepareKeyRef.current === key,
      })
      .then((result) => {
        if (prepareKeyRef.current !== key || result === null) return;
        setPrepared(
          result.ok
            ? { key, plan: result.plan, failure: null }
            : { key, plan: null, failure: result },
        );
      });
  }, [context.scope.serverId, homeId, machineId, prepare, prepareKey]);
  const machinePlan = prepared?.key === prepareKey ? prepared : null;

  const included = repositories.filter((source) => !excluded.has(source.id));
  const requirementsEnabled = presented && !props.preview;
  const requirements = useSourceSetupRequirementNames(context.scope, included, requirementsEnabled);
  const hasPreset = !props.preview && resources.preset !== null;
  const running = run.kind === 'running';
  const canReview =
    !!machineId &&
    !!homeId &&
    !running &&
    heldReviews.size === 0 &&
    run.kind !== 'approval' &&
    run.kind !== 'done' &&
    (!hasPreset || !!machinePlan?.plan) &&
    (hasPreset || included.length > 0);

  // The checkout owner's registered checkouts of these Sources on the chosen Machine; one lookup for the page.
  const serverId = context.scope.serverId;
  const checkoutList = useWorkspaceRefsSelector(React.useCallback((refs) => repositories.map((source) =>
    findTeamSetupSourceCheckout(refs, { serverId, machineId, sourceId: source.id, revision: source.revision })),
  [machineId, repositories, serverId]));
  // Whether that lookup has answered for this Account: before it does, "no checkout" is not yet known.
  const checkoutLookupSettled = useProjectAccountRows(rows => !!rows && areServerAccountScopesEqual(rows.scope, context.scope)
    && rows.status !== 'idle' && rows.status !== 'loading', !!machineId);
  const checkouts = React.useMemo(() => new Map(repositories.flatMap((source, index) => {
    const checkout = checkoutList[index];
    return checkout ? [[source.id, checkout] as const] : [];
  })), [checkoutList, repositories]);

  const clones = useTeamSetupExistingClones({
    execute,
    context: actionContext,
    machineId,
    homeDir,
    sources: repositories,
  });
  const canRun = canReview && included.every(source =>
    (clones.matches?.get(source.id)?.length ?? 0) < 2 || clones.adopted.has(source.id) || checkouts.has(source.id));

  const start = React.useCallback(async () => {
    if (!canRun || !machineId || !homeId) return;
    const repositoryInputs = included.flatMap((source) => {
      const repository = buildTeamSetupRepository(
        source,
        { serverId: context.scope.serverId, machineId, homeDir },
        clones.matches?.get(source.id)?.length === 1 && checkouts.has(source.id)
          ? null : clones.adopted.get(source.id) ?? null,
        checkouts.get(source.id) ?? null,
      );
      return repository ? [repository] : [];
    });
    if (repositoryInputs.length !== included.length) {
      setSelectionFailed(true);
      return;
    }
    const batch = buildTeamSetupPlan({ serverId: context.scope.serverId, homeId, machineId },
      machinePlan?.plan?.machine ?? null, repositoryInputs);
    setSelectionFailed(false);
    await runPlan({
      plan: batch,
      selection: { team: context.address, lifetime: props.lifetime, sources: included,
        retireOffer: resources.sources.state.status === 'ready' && resources.sources.state.coverage.complete, isReviewPresented },
    });
  }, [
    canRun,
    context.address,
    context.scope.serverId,
    props.lifetime,
    checkouts,
    clones.adopted,
    clones.matches,
    homeDir,
    homeId,
    included,
    machineId,
    machinePlan,
    runPlan,
    isReviewPresented,
    resources.sources.state,
  ]);

  // The Machine owner decides whether the Team's preset moved on since this Machine applied it.
  const presetUpdates = useMachinePresetUpdates({
    serverId: context.scope.serverId,
    machineId: machineId ?? '',
    active: !!machineId && !!presetValue,
  });
  const presetUpdate = presetValue
    ? presetUpdates.find((update) => update.presetId === presetValue.id && update.kind === 'changed') ?? null
    : null;
  const presetChange = React.useMemo(() => presetUpdate?.kind === 'changed' && machineId ? {
    revision: presetUpdate.presetRevision,
    onReview: () => router.push(machinePageHref({ door: 'rail',
      target: { machineId, serverId: context.scope.serverId }, tab: { id: 'setup' } }) as never),
  } : null, [context.scope.serverId, machineId, presetUpdate, router]);

  const done = run.kind === 'done';
  const taskSelection = useTeamSetupFirstTask({ execute, context: actionContext, sources: included, enabled: done });
  const suggestedTask = taskSelection?.task;
  const openTask = React.useCallback(async (project: TeamSetupSessionTarget, prompt: string) => {
    if (!machineId) return;
    await openFirstTask({ project, machineId, prompt, lifetime: props.lifetime });
  }, [machineId, openFirstTask, props.lifetime]);
  // Rows and the suggested task consume the retained observer's native snapshots.
  const taskProject = useTeamSetupBatchProgress(
    suggestedTask ? currentBatch : null, suggestedTask?.sourceId ?? '', undefined, { observeOpen: false },
  )?.readyProject ?? null;
  const firstTask = React.useMemo<TeamSetupFirstTaskView | null>(() => suggestedTask && taskProject ? {
    title: suggestedTask.title,
    markdown: suggestedTask.markdown,
    repositoryName: repositories.find((source) => source.id === suggestedTask.sourceId)?.repository?.repository.nameWithOwner
      ?? suggestedTask.sourceName,
    onOpen: () => { void openTask(taskProject, suggestedTask.markdown); },
  } : null, [openTask, repositories, suggestedTask, taskProject]);
  // A finished setup leaves its rows' results in place; choosing another Machine starts a new review.
  const setUpAnother = React.useCallback(() => dismissRun(currentBatch?.selection ?? null), [currentBatch?.selection]);
  const startSession = React.useCallback((project: TeamSetupSessionTarget) => { void openTask(project, ''); }, [openTask]);

  const sourcesState = resources.sources.state;
  const sourcesLoading = sourcesState.status === 'initial' || sourcesState.status === 'loading';
  const sourcesFailed = sourcesState.status === 'offline' || sourcesState.status === 'refused';
  // The page's own reads that shape the plan: Sources, each included repository's environment read, and on a chosen
  // Machine its name and home folder and the checkout lookup. The view latches arrival once these and each found
  // checkout's setup read have answered.
  const planReadsSettled = !sourcesLoading && (!requirementsEnabled || included.every((source) => {
    const entry = requirements.entries.get(source.id);
    return entry?.revision === source.revision && entry.read.status !== 'loading';
  })) && (!machineId || (machineLabelState !== undefined && checkoutLookupSettled));
  const sourceIssue = sourcesFailed ? presentProjectSourceIssue(sourcesState.issue, context.homeName) : null;
  // Keys the Team already shares: sessions on any of the member's Machines use them without the value
  // reaching the member, so they need no step here. Keys a repository asks each member for are owed.
  const sharedKeys = resources.credentialsEnabled ? resources.credentials.resources : NO_KEYS;
  const openOperation = React.useCallback(
    (operationId: string) => openActionOperationDetail({ serverId: context.scope.serverId, operationId }),
    [context.scope.serverId],
  );
  const setupRetry = run.kind === 'stopped' ? run.failure?.setupRetry : undefined;
  const openSetupRetry = React.useCallback(() => {
    if (setupRetry) router.push(createWorkflowInvocationRoute(setupRetry.runId, setupRetry.invocationId, context.scope.serverId) as never);
  }, [context.scope.serverId, router, setupRetry]);
  const toggleRepository = React.useCallback((sourceId: string, next: boolean) =>
    setExcluded((current) => {
      const updated = new Set(current);
      if (next) updated.delete(sourceId);
      else updated.add(sourceId);
      return updated;
    }), []);
  if (!props.preview && resources.sharedResources.status === 'ready' && sourcesState.status === 'ready' && sourcesState.coverage.complete
    && !hasPreset && sourcesState.rows.length === 0 && sharedKeys.length === 0) {
    return (
      <>
      <TeamSetupHeader context={context} lead={false} />
      {props.conditions}
      <SurfaceStateCard
        testID="team-setup-empty"
        kind="empty"
        title={t('teams.join.setupPage.emptyTitle', { team: teamName })}
        reason={t('teams.join.setupPage.emptyBody', { team: teamName })}
        action={{ label: t('teams.join.setupPage.emptyOpenProject'), onPress: () => router.push('/projects/open' as never) }}
        secondaryAction={{ label: t('teams.join.setupPage.emptyAddMachine'), onPress: () => router.push(buildMachineAddHref({ serverId: context.scope.serverId }) as never) }}
        note={t('teams.join.setupPage.emptyNote', { team: teamName })}
      />
      </>
    );
  }

  return (
    <TeamSetupPageView
      header={<TeamSetupHeader context={context} lead preview={props.preview}
        {...(run.kind === 'done' && run.completed ? { doneOn: machineName ?? null } : {})} />}
      preview={props.preview ? {
        onClose: () => router.back(),
        presetSetup: presetValue?.setup,
        scope: context.scope,
      } : undefined}
      conditions={props.conditions}
      teamName={teamName}
      navigationContextKey={serverAccountScopedResourceKey(context.scope, context.team.id)}
      selection={selection}
      machineId={machineId}
      machineLabel={machineName ?? null}
      homeDir={homeDir}
      run={run}
      canRun={canRun}
      onRun={() => { void start(); }}
      onOpenOperation={openOperation}
      onOpenApproval={approval.reopen}
      onRetryFailedSetup={setupRetry ? openSetupRetry : undefined}
      sources={{
        loading: sourcesLoading,
        failure: sourcesFailed
          ? { title: sourceIssue?.title ?? t('common.unavailable'), description: sourceIssue?.description }
          : null,
        onRetry: () => { void resources.sources.controller.load(); },
      }}
      hasPreset={hasPreset}
      signIns={machineId && githubServiceKey && included.some(source => source.repository?.provider.kind === 'github') ? (
        <MachineSignInsSection serverId={context.scope.serverId} machineId={machineId}
          machineName={machineName ?? t('teams.join.setupPage.yourMachine')}
          presented={presented} editable={context.canMutate && !running}
          connectedServiceKey={githubServiceKey} />
      ) : null}
      machinePlan={machinePlan}
      repositories={repositories}
      repositoryFreeSources={resources.repositoryFreeSources}
      excluded={excluded}
      onToggleRepository={toggleRepository}
      batch={currentBatch}
      heldReviews={heldReviews}
      requirements={requirements}
      sharedKeys={sharedKeys}
      keyDisplayNames={resources.credentialDisplayNames}
      firstTask={firstTask}
      unavailableTasks={taskSelection?.unavailable}
      onStartSession={startSession}
      presetChange={presetChange}
      clones={clones}
      checkouts={checkouts}
      onSetUpAnother={setUpAnother}
      arriving={!planReadsSettled}
    />
  );
}

/**
 * The setup page as drawn from values its owner has already read: the Team's header, the Machine choice
 * and run button, the preset's plan review for that Machine, the shared repositories to clone, and the
 * keys the Team already shares. `TeamSetupPlanPage` owns every read and the run.
 */
export function TeamSetupPageView(
  props: Readonly<{
    header: React.ReactNode;
    conditions?: React.ReactNode;
    teamName: string;
    navigationContextKey?: string;
    selection: MachineAdministrationTargetSelectionV1;
    machineId: string | null;
    machineLabel: string | null;
    homeDir: string | null;
    run: TeamSetupRunState;
    canRun: boolean;
    onRun: () => void;
    onOpenOperation: (operationId: string) => void;
    onOpenApproval?: (artifactId: string) => void;
    onRetryFailedSetup?: () => void;
    sources: Readonly<{
      loading: boolean;
      failure: Readonly<{ title: string; description?: string }> | null;
      onRetry: () => void;
    }>;
    hasPreset: boolean;
    signIns?: React.ReactNode;
    machinePlan: TeamSetupPreparedMachine | null;
    repositories: readonly ProjectSourceV1[];
    repositoryFreeSources: readonly ProjectSourceV1[];
    excluded: ReadonlySet<string>;
    onToggleRepository: (sourceId: string, included: boolean) => void;
    batch: TeamSetupBatch | null;
    heldReviews?: ReadonlyMap<string, ActionOperationProjection>;
    requirements?: ReturnType<typeof useSourceSetupRequirementNames>;
    sharedKeys: TeamSetupResources['credentials']['resources'];
    keyDisplayNames: Readonly<Record<string, string | null>>;
    /** The Team's suggested task, offered once setup is done; it opens the ordinary composer, never a launch. */
    firstTask: TeamSetupFirstTaskView | null;
    unavailableTasks?: ProjectSourceOnboardingTaskSelectionV1['unavailable'];
    onStartSession?: (project: TeamSetupSessionTarget) => void;
    /** The Machine owner found the Team's preset newer than what this Machine applied. */
    presetChange: Readonly<{ revision: number; onReview: () => void }> | null;
    clones: TeamSetupExistingClones;
    /** Registered checkouts of the listed Sources on the chosen Machine, by Source id (the checkout owner's fact). */
    checkouts?: ReadonlyMap<string, WorkspaceRefV1>;
    /** After Done, the rail offers the same setup on another Machine instead of a spent button. */
    onSetUpAnother?: () => void;
    /**
     * The page's own reads that decide the plan's shape are pending (Sources, each included repository's environment keys,
     * the chosen Machine's record and checkout lookup). Each found checkout's setup read is waited on here as well.
     */
    arriving?: boolean;
    /** Preview as a member: a new member's own machine stands in for the selector, and nothing runs. */
    preview?: Readonly<{
      onClose: () => void;
      presetSetup: React.ComponentProps<typeof MachineSetupContents>['setup'];
      scope: React.ComponentProps<typeof MachineSetupContents>['scope'];
    }>;
  }>,
) {
  const { teamName, machineId, machineLabel, run, repositories } = props;
  // Until the plan's first reads settle, one loading line stands for the whole plan, so its sections arrive together
  // instead of each pushing the next one down as its own read lands. The rows mount hidden meanwhile, so each found
  // checkout's own setup read (Ready, or a changed shared setup) answers before the plan shows. Kept once reached: a
  // later refresh or a new Source revision updates rows in place instead of folding the plan back up.
  const [settledCheckouts, setSettledCheckouts] = React.useState<ReadonlySet<string>>(() => new Set());
  const settleCheckout = React.useCallback((checkoutId: string) => setSettledCheckouts(current =>
    current.has(checkoutId) ? current : new Set(current).add(checkoutId)), []);
  const [arrived, setArrived] = React.useState(false);
  if (!arrived && props.arriving !== true && repositories.every((source) => {
    const checkout = props.checkouts?.get(source.id);
    return !checkout || settledCheckouts.has(checkout.id);
  })) setArrived(true);
  const arriving = !arrived;
  const router = useRouter();
  const { theme } = useUnistyles();
  const compact = useDeviceType() === 'phone';
  const running = run.kind === 'running';
  const toolsOperation = run.kind !== 'idle' ? run.operationId : null;
  const stoppedOperation = run.kind === 'stopped' ? run.operationId : null;
  const heldEntry = React.useMemo(() => {
    for (const source of repositories) {
      const operation = props.heldReviews?.get(source.id);
      if (operation) return { operation, repository: source.repository?.repository.nameWithOwner ?? source.name };
    }
    return null;
  }, [props.heldReviews, repositories]);
  const visibleOperation = stoppedOperation ?? (!arriving && props.hasPreset ? toolsOperation : null);
  const operationAction = visibleOperation ? {
    label: run.kind === 'running'
      ? t('teams.join.setupPage.machineRunning', { machine: machineLabel ?? '' })
      : t('teams.join.setupPage.seeWhatRan'),
    onPress: () => props.onOpenOperation(visibleOperation),
  } : undefined;
  const seeWhatRan = stoppedOperation ? operationAction : undefined;
  useCurrentUiContextLocalCommands(operationAction && props.navigationContextKey ? [{
    key: `team-setup-operation:${visibleOperation}`,
    title: operationAction.label,
    invoke: operationAction.onPress,
  }] : [], { contextKey: props.navigationContextKey });
  // The selector draws its own card, so the heading stands alone above it, as the plan review's do below.
  const aside = props.preview ? (
    <>
      <ItemGroup testID="team-setup-before" title={t('teams.join.setupPage.beforeYouStart')}>
        <Item
          testID="team-setup-preview-machine"
          icon={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />}
          title={t('teams.join.setupPage.previewMachineTitle')}
          subtitle={t('teams.join.setupPage.previewMachine')}
          showChevron={false}
        />
      </ItemGroup>
      <ItemGroup surface="none" description={t('teams.join.setupPage.previewNote')}>
        <BareSectionContent>
          <RoundButton
            testID="team-setup-preview-close"
            size="large"
            title={t('teams.join.setupPage.closePreview')}
            onPress={props.preview.onClose}
          />
        </BareSectionContent>
      </ItemGroup>
    </>
  ) : run.kind === 'done' && run.completed ? (
    <ItemGroup testID="team-setup-another">
      <Item
        testID="team-setup-another-machine"
        icon={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />}
        title={t('teams.join.setupPage.anotherMachine')}
        subtitle={t('teams.join.setupPage.anotherMachineDescription', { team: teamName })}
        showChevron={false}
        rightElement={props.onSetUpAnother ? (
          <RoundButton
            testID="team-setup-another-run"
            size="small"
            display="secondary"
            title={t('teams.join.setupPage.anotherMachineAction')}
            onPress={props.onSetUpAnother}
          />
        ) : undefined}
      />
    </ItemGroup>
  ) : run.kind === 'done' || run.kind === 'approval' ? null : (
    <>
      <ItemGroup testID="team-setup-before" title={t('teams.join.setupPage.beforeYouStart')} children={null} />
      <MachineAdministrationTargetSelector
        selection={props.selection}
        presentation="context"
        testIDPrefix="team-setup-machine"
        unselectedTitle={t('teams.join.setupPage.machineUnselected', { team: teamName })}
        disabled={running || !!heldEntry}
      />
      {heldEntry ? (
        // A held review is the one thing to do: the run card says so and opens it, in place of a Run with nothing to commit.
        <ItemGroup testID="team-setup-held">
          <Item
            icon={<Icon name="radio-button" size={20} color={theme.colors.state.attention.foreground} />}
            title={t('teams.join.setupPage.heldTitle')}
            subtitle={t('teams.join.setupPage.heldReason', { repository: heldEntry.repository })}
            subtitleLines={0}
            showChevron={false}
            rightElement={
              <RoundButton
                testID="team-setup-held-review"
                size="small"
                display="secondary"
                title={t('approvals.review')}
                onPress={() => props.onOpenOperation(heldEntry.operation.snapshot.operationId)}
              />
            }
          />
        </ItemGroup>
      ) : arriving ? null : (
        <ItemGroup surface="none">
          <BareSectionContent>
            <RoundButton
              testID="team-setup-run"
              size="large"
              title={
                machineLabel
                  ? t('teams.join.setupPage.run', { machine: machineLabel, team: teamName })
                  : t('teams.join.setUpForTeam', { team: teamName })
              }
              loading={running}
              disabled={!props.canRun}
              onPress={props.onRun}
            />
          </BareSectionContent>
        </ItemGroup>
      )}
    </>
  );

  return (
    <>
    {props.header}
    {props.conditions}
    <PageAsideColumns compact={compact} compactAside={run.kind === 'done' ? 'last' : 'first'} aside={aside}>
      {props.preview ? <SurfaceStateCard testID="team-setup-preview-audience" kind="warning" size="line"
        title={t('teams.join.setupPage.previewAudience')} /> : null}
      {arriving || (props.sources.loading && repositories.length === 0) ? (
        <SurfaceStateCard testID="team-setup-sources-loading" kind="loading" size="line" title={t('projects.sources.loading')} />
      ) : props.sources.failure ? (
        <SurfaceStateCard
          testID="team-setup-sources-failed"
          kind="error"
          size="line"
          title={props.sources.failure.title}
          reason={props.sources.failure.description}
          action={{ label: t('common.retry'), onPress: props.sources.onRetry }}
        />
      ) : null}
      {run.kind === 'stopped' ? (
        <SurfaceStateCard
          testID="team-setup-stopped"
          kind="error"
          size="line"
          title={t('teams.join.setupPage.stopped', {
            machine: machineLabel ?? t('teams.join.setupPage.yourMachine'),
          })}
          reason={run.failure?.error ?? undefined}
          action={props.onRetryFailedSetup
            ? { testID: 'team-setup-retry-failed', label: t('common.retry'), onPress: props.onRetryFailedSetup }
            : seeWhatRan ?? { label: t('common.retry'), onPress: props.onRun }}
          secondaryAction={props.onRetryFailedSetup ? seeWhatRan : undefined}
        />
      ) : null}
      {run.kind === 'approval' ? (
        <SurfaceStateCard testID="team-setup-approval" kind="warning" size="line"
          title={t('teams.join.setupPage.statusApproval')}
          action={props.onOpenApproval ? { label: t('approvals.review'), onPress: () => props.onOpenApproval?.(run.artifactId) } : undefined} />
      ) : run.kind === 'done' && !run.completed ? (
        <SurfaceStateCard testID="team-setup-partial" kind="warning" size="line"
          title={t('teams.join.setupPage.partial')} />
      ) : null}
      {run.kind === 'done' && !props.firstTask ? props.unavailableTasks?.map(task => (
        <SurfaceStateCard key={task.sourceId} testID={`team-setup-first-task-unavailable:${task.sourceId}`}
          kind="warning" size="line"
          title={t('teams.join.setupPage.firstTaskUnavailable', { repository: task.sourceName })}
          reason={t(task.result.errorCode === 'action_disabled'
            ? 'teams.join.setupPage.firstTaskDisabled' : 'teams.join.setupPage.firstTaskAskOwner')} />
      )) : null}
      {run.kind === 'done' && props.firstTask ? (
        <ItemGroup
          testID="team-setup-first-task"
          title={t('teams.join.setupPage.firstTaskTitle')}
          description={t('teams.join.setupPage.firstTaskDescription', {
            team: teamName,
            repository: props.firstTask.repositoryName,
          })}
        >
          <Item
            testID="team-setup-first-task-prompt"
            title={props.firstTask.title}
            subtitle={props.firstTask.markdown}
            subtitleLines={4}
            showChevron={false}
            accessoryLayout={compact ? 'stacked' : 'adaptive'}
            rightElement={
              <RoundButton
                testID="team-setup-first-task-open"
                size="small"
                title={t('teams.join.setupPage.firstTaskOpen')}
                onPress={props.firstTask.onOpen}
              />
            }
          />
        </ItemGroup>
      ) : null}
      {!arriving && props.hasPreset ? (
        <>
          {/* Rows sit in this section's card; the plan review and its failure are sections and cards of their
              own, so they follow the heading instead of nesting in it. */}
          <ItemGroup
            testID="team-setup-tools"
            title={
              machineLabel
                ? t('teams.join.setupPage.toolsTitle', { machine: machineLabel })
                : t('teams.join.setupPage.toolsTitleNoMachine')
            }
            description={t('teams.join.setupPage.toolsDescription', { team: teamName })}
          >
            {props.presetChange && !toolsOperation ? (
              <Item
                testID="team-setup-preset-changed"
                title={t('teams.join.setupPage.presetChanged', { team: teamName })}
                subtitle={t('machinePresets.setup.tab.newerRevision', { revision: props.presetChange.revision })}
                showChevron={false}
                rightElement={
                  <RoundButton
                    testID="team-setup-preset-changed-review"
                    size="small"
                    display="secondary"
                    title={t('machinePresets.setup.tab.reviewChanges')}
                    onPress={props.presetChange.onReview}
                  />
                }
              />
            ) : null}
            {operationAction ? (
              <Item
                testID="team-setup-tools-operation"
                title={operationAction.label}
                onPress={operationAction.onPress}
              />
            ) : !machineId && props.preview ? null : !machineId ? (
              <Item
                testID="team-setup-tools-choose"
                title={t('teams.join.setupPage.toolsChooseMachine')}
                showChevron={false}
              />
            ) : props.machinePlan?.failure || props.machinePlan?.plan?.machine ? null : (
              <PageLoadingRows testID="team-setup-tools-loading" />
            )}
          </ItemGroup>
          {props.preview ? (
            <MachineSetupContents
              testID="team-setup-preview-tools"
              setup={props.preview.presetSetup}
              scope={props.preview.scope}
            />
          ) : null}
          {toolsOperation || !machineId ? null : props.machinePlan?.failure ? (
            <SurfaceStateCard
              testID="team-setup-tools-failed"
              kind="error"
              size="line"
              title={t('teams.join.setupPage.toolsFailed', {
                machine: machineLabel ?? '',
              })}
              reason={props.machinePlan.failure.error}
            />
          ) : props.machinePlan?.plan?.machine ? (
            <MachineSetupPlanReview
              testID="team-setup-tools-review"
              prepared={props.machinePlan.plan.machine}
              nameOf={() => machineLabel ?? ''}
              disabled={running}
            />
          ) : null}
        </>
      ) : null}
      {/* Mounted hidden while arriving too, so the Machine's sign-in report is read alongside the plan's reads. */}
      {props.signIns ? <TeamSetupArrivalHold held={arriving}>{props.signIns}</TeamSetupArrivalHold> : null}
      {repositories.length > 0 ? (
        <TeamSetupArrivalHold testID="team-setup-repositories-frame" held={arriving}>
        <ItemGroup
          testID="team-setup-repositories"
          title={t('teams.join.setupPage.repositoriesTitle')}
          description={
            run.kind === 'done'
              ? run.completed && machineLabel && props.excluded.size === 0
                ? t('teams.join.setupPage.repositoriesReady', { machine: machineLabel })
                : undefined
              : machineLabel
              ? t('teams.join.setupPage.repositoriesDescription', {
                  machine: machineLabel,
                })
              : t('teams.join.setupPage.repositoriesDescriptionNoMachine')
          }
          // The search runs on the chosen Machine: without one (a preview, nothing chosen yet) there is nothing to offer.
          action={run.kind === 'done' || !props.clones.onFind ? undefined : (
            <RoundButton
              testID="team-setup-find-clones"
              size="small"
              display="secondary"
              title={t('teams.join.setupPage.findClones')}
              loading={props.clones.searching}
              disabled={running}
              onPress={() => props.clones.onFind?.()}
            />
          )}
        >
          {repositories.map((source) => (
            <TeamSetupRepositoryRow
              key={source.id}
              source={source}
              machineId={machineId}
              homeDir={props.homeDir}
              included={!props.excluded.has(source.id)}
              adoptedPath={props.clones.adopted.get(source.id) ?? null}
              clonePaths={props.clones.matches?.get(source.id)}
              onChooseClone={props.clones.onChoose}
              checkout={props.checkouts?.get(source.id) ?? null}
              teamName={teamName}
              onStartSession={props.onStartSession}
              batch={props.batch}
              heldReview={props.heldReviews?.get(source.id)}
              requirements={readRequirementsForSource(props.requirements?.entries.get(source.id), source.revision)}
              onRetryRequirements={props.requirements?.retry}
              disabled={running || run.kind === 'done' || !!heldEntry}
              iconColor={theme.colors.text.secondary}
              onToggle={(next) => props.onToggleRepository(source.id, next)}
              onCheckoutSetupSettled={arrived ? undefined : settleCheckout}
            />
          ))}
        </ItemGroup>
        </TeamSetupArrivalHold>
      ) : null}
      {arriving ? null : props.clones.failure && props.clones.folder ? (
        <SurfaceStateCard
          testID="team-setup-clones-failed"
          kind="error"
          size="line"
          title={t('teams.join.setupPage.clonesFailed', { folder: props.clones.folder })}
          reason={props.clones.failure}
        />
      ) : props.clones.noneFound && props.clones.folder ? (
        <SurfaceStateCard
          testID="team-setup-clones-none"
          kind="empty"
          size="line"
          title={t('teams.join.setupPage.clonesNone', { folder: props.clones.folder })}
        />
      ) : null}
      {!arriving && props.repositoryFreeSources.length > 0 ? (
        <ItemGroup testID="team-setup-sources" title={t('projects.sources.title')}>
          {props.repositoryFreeSources.map((source) => (
            <Item
              key={source.id}
              testID={`team-setup-source:${source.id}`}
              icon={<Icon name="git-branch" size={20} color={theme.colors.text.secondary} />}
              title={source.name}
              onPress={() => router.push(projectSourceRoute(source.id))}
            />
          ))}
        </ItemGroup>
      ) : null}
      {!arriving && props.sharedKeys.length > 0 ? (
        <ItemGroup
          testID="team-setup-keys"
          title={t('teams.join.setupPage.keysTitle')}
          description={t('teams.join.setupPage.keysDescription', { team: teamName })}
        >
          {props.sharedKeys.map((resource) => {
            const mode = recipientDeliveryMode(resource);
            const subtitle = [mode ? deliveryModeLabel(mode) : null, resourceStateLabel(resource.readiness)]
              .filter((part): part is string => Boolean(part)).join(' · ');
            return (
              <Item
                key={resource.id}
                testID={`team-setup-key:${resource.id}`}
                icon={<Icon name="key" size={20} color={theme.colors.text.secondary} />}
                title={props.keyDisplayNames[resource.id] ?? t('teams.credentials.title')}
                subtitle={subtitle || undefined}
                detail={t('teams.join.setupPage.keyShared')}
                showChevron={false}
              />
            );
          })}
        </ItemGroup>
      ) : null}
    </PageAsideColumns>
    </>
  );
}

// Laid out at the column's width but not drawn, reachable or read: `display: none` would measure the rows at zero width,
// and the phone header and row wraps would then reflow the moment the plan shows.
const ARRIVAL_HELD = {
  position: 'absolute', left: 0, right: 0, top: 0, pointerEvents: 'none', opacity: 0, visibility: 'hidden',
} as ViewStyle;

/** Keeps a plan section mounted (so its own reads start with the page's) while the plan is still arriving. */
function TeamSetupArrivalHold(props: Readonly<{ held: boolean; testID?: string; children: React.ReactNode }>) {
  return (
    <View testID={props.testID} style={props.held ? ARRIVAL_HELD : undefined}
      accessibilityElementsHidden={props.held} importantForAccessibility={props.held ? 'no-hide-descendants' : 'auto'}>
      {props.children}
    </View>
  );
}

const STATUS_WORD: Record<TeamSetupRepositoryPhase, () => string> = {
  queued: () => t('teams.join.setupPage.statusQueued'),
  opening: () => t('teams.join.setupPage.statusOpening'),
  prepared: () => t('approvals.review'),
  ready: () => t('teams.join.setupPage.statusReady'),
  approval: () => t('teams.join.setupPage.statusApproval'),
  failed: () => t('teams.join.setupPage.statusFailed'),
  stopped: () => t('common.unavailable'),
  unavailable: () => t('common.unavailable'),
};

function readRequirementsForSource(entry: { revision: number; read: SourceSetupRequirementRead } | undefined, revision: number) {
  return entry?.revision === revision ? entry.read : undefined;
}

const TeamSetupRepositoryRow = React.memo(function TeamSetupRepositoryRow(
  props: Readonly<{
    source: ProjectSourceV1;
    machineId: string | null;
    homeDir: string | null;
    included: boolean;
    /** A clone the member already has, found by Find existing clones; it is attached as it is. */
    adoptedPath: string | null;
    clonePaths?: readonly string[];
    onChooseClone?: (sourceId: string, path: string) => void;
    checkout: WorkspaceRefV1 | null;
    teamName: string;
    onStartSession?: (project: TeamSetupSessionTarget) => void;
    batch: TeamSetupBatch | null;
    heldReview?: ActionOperationProjection;
    requirements?: SourceSetupRequirementRead;
    onRetryRequirements?: () => void;
    disabled: boolean;
    iconColor: string;
    onToggle: (included: boolean) => void;
    /** Told once this row's checkout setup read has answered, while the plan is still arriving. */
    onCheckoutSetupSettled?: (checkoutId: string) => void;
  }>,
) {
  const progress = useTeamSetupBatchProgress(props.batch, props.source.id, undefined, { observeOpen: false });
  const router = useRouter();
  const { theme } = useUnistyles();
  const [choosingClone, setChoosingClone] = React.useState(false);
  const heldReview = progress ? undefined : props.heldReview;
  // The member's existing checkout of this Source on the chosen Machine, whose owner says if its shared setup moved on
  // and whether its setup is already current.
  const { checkout } = props;
  const checkoutSetup = useTeamSetupCheckoutSetup(props.source, checkout);
  const { onCheckoutSetupSettled } = props;
  const checkoutId = checkout?.id;
  React.useEffect(() => {
    if (checkoutId && checkoutSetup.settled) onCheckoutSetupSettled?.(checkoutId);
  }, [checkoutId, checkoutSetup.settled, onCheckoutSetupSettled]);
  const checkoutReady = !progress && !heldReview && !!checkout && checkoutSetup.ready
    && (!props.adoptedPath || checkout.rootPath === props.adoptedPath);
  const opened: TeamSetupSessionTarget | null | undefined = progress?.readyProject
    ?? (checkoutReady ? { workspace: { serverId: checkout.serverId }, directory: checkout.rootPath } : null);
  const cloneChoice = props.clonePaths && props.clonePaths.length > 1 ? props.clonePaths : null;
  const existingPath = cloneChoice ? props.adoptedPath ?? checkout?.rootPath : checkout?.rootPath ?? props.adoptedPath;
  const projectResult = progress?.openedProject;
  const setupOperation = heldReview ?? progress?.progress.setupOperation ?? progress?.progress.openOperation;
  const phase = heldReview ? 'approval' : progress?.phase ?? (checkoutReady ? 'ready' : undefined);
  const workspace = projectResult && 'machineId' in projectResult.workspace
    ? projectResult.workspace : null;
  const bindingsProject = workspace ?? (checkout && (!props.adoptedPath || checkout.rootPath === props.adoptedPath)
    ? { serverId: checkout.serverId, workspaceId: checkout.id, rootPath: checkout.rootPath } : null);
  const bindingsSourceId = projectResult?.facts?.source?.sourceId
    ?? (bindingsProject?.workspaceId === checkout?.id ? checkout?.source?.sourceId : undefined);
  const destination = existingPath ? null : props.machineId
    ? suggestProjectOpenDestination({
        machineId: props.machineId,
        machineHomeDir: props.homeDir,
        subject: { kind: 'source', source: props.source },
        checkouts: [],
      })
    : '';
  const nameWithOwner =
    props.source.repository?.repository.nameWithOwner ?? props.source.name;
  return (
    <>
    <Item
      testID={`team-setup-repository:${props.source.id}`}
      icon={<Icon name="git-branch" size={20} color={props.iconColor} />}
      title={nameWithOwner}
      subtitle={
        existingPath
          ? t('teams.join.setupPage.repositoryExisting', { path: existingPath })
          : destination && !cloneChoice
            ? t('teams.join.setupPage.repositoryInto', { path: destination })
            : undefined
      }
      onPress={setupOperation && !opened ? () => openActionOperationDetail({
        serverId: setupOperation.serverId, operationId: setupOperation.snapshot.operationId,
      }) : undefined}
      showChevron={!!setupOperation && !opened}
      detail={phase ? STATUS_WORD[phase]() : undefined}
      // "Needs you" speaks in amber (DESIGN.md: colour means state); every other status stays ink.
      detailStyle={phase === 'approval' ? { color: theme.colors.state.attention.textForeground } : undefined}
      rightElement={
        opened && props.onStartSession ? (
          <RoundButton
            testID={`team-setup-repository-start:${props.source.id}`}
            size="small"
            display="secondary"
            title={t('teams.join.setupPage.startSession')}
            onPress={() => props.onStartSession?.(opened)}
          />
        ) : phase ? undefined : (
          <Switch
            testID={`team-setup-repository-include:${props.source.id}`}
            value={props.included}
            disabled={props.disabled}
            onValueChange={props.onToggle}
            accessibilityLabel={nameWithOwner}
          />
        )
      }
    />
    {props.included && props.requirements?.status === 'ready' && props.requirements.names.length > 0 ? (
      <Item
        testID={`team-setup-repository-keys:${props.source.id}`}
        title={t('projects.scripts.environment.title')}
        subtitle={props.requirements.names.join(', ')}
        onPress={bindingsProject ? () => router.push(buildProjectRouteHref({
          workspaceRefId: bindingsProject.workspaceId,
          serverId: bindingsProject.serverId,
          segment: 'scripts',
          activeRootPath: bindingsProject.rootPath,
          defaultRootPath: bindingsProject.rootPath,
          // Folder Open keeps the checkout as it is. The Project owner reviews its Source setup before use.
          ...(bindingsSourceId !== props.source.id
            ? { routeParams: { [PROJECT_USE_SHARED_SETUP_PARAM]: props.source.id } } : {}),
        })) : undefined}
        showChevron={!!bindingsProject}
      />
    ) : null}
    {props.included && props.requirements?.status === 'failed' && props.onRetryRequirements ? (
      <SurfaceStateCard kind="warning" size="line" title={t('teams.join.setupPage.requirementsUnavailable')}
        action={{ label: t('common.retry'), onPress: props.onRetryRequirements }} />
    ) : null}
    {cloneChoice && !props.disabled && props.included ? (
      <DropdownMenu
        testID={`team-setup-repository-clone:${props.source.id}`}
        open={choosingClone}
        onOpenChange={setChoosingClone}
        items={cloneChoice.map(path => ({ id: path, title: path }))}
        selectedId={existingPath ?? null}
        onSelect={path => props.onChooseClone?.(props.source.id, path)}
        itemTrigger={{ title: t('projects.open.chooseCheckout', { count: cloneChoice.length }) }}
      />
    ) : null}
    {checkoutSetup.pending ? (
      <TeamSetupSourceChangeNotice sourceId={props.source.id} teamName={props.teamName}
        pending={checkoutSetup.pending} onReview={checkoutSetup.onReview} />
    ) : null}
    </>
  );
});
