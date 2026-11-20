import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { suggestProjectOpenDestination } from '@/components/projects/activation/projectOpenChoices';
import { useMachinePresetUpdates } from '@/components/machines/setup/useMachinePresetUpdates';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { presentProjectSourceIssue } from '@/components/projects/sources/projectSourceIssue';
import { projectSourceRoute } from '@/components/projects/sources/projectSourceNavigation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { MachineSetupContents } from '@/components/settings/machines/managed/MachineSetupContents';
import { MachineSetupPlanReview } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { TeamHeaderAvatar } from '@/components/settings/teams/TeamHeaderAvatar';
import {
  deliveryModeLabel,
  recipientDeliveryMode,
  resourceStateLabel,
} from '@/components/settings/teams/credentials/teamCredentialPresentation';
import { TeamSection } from '@/components/settings/teams/TeamSection';
import { teamPageHeaderMeta, type TeamSectionContext } from '@/components/settings/teams/teamSectionContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { PageAsideColumns } from '@/components/ui/layout/PageAsideColumns';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
  useMachineAdministrationTargetSelection,
  type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import {
  areServerAccountScopesEqual,
  type ServerAccountScopeLifetime,
} from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { createWorkflowInvocationRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
  useActiveServerAccountScopeLifetime,
  useServerScopedMachine,
  useServerScopedMachineLabel,
  useWorkspaceRefsSelector,
} from '@/sync/store/hooks';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import type { TeamSetupPlan } from './teamSetupPlan';
import { buildTeamSetupRepository } from './teamSetupRepositories';
import { useTeamSetupExistingClones, type TeamSetupExistingClones } from './useTeamSetupExistingClones';
import { useTeamSetupFirstTask } from './useTeamSetupFirstTask';
import { findTeamSetupSourceCheckout, TeamSetupSourceChange } from './TeamSetupSourceChange';
import { useTeamSetupPlan, type TeamSetupBatch } from './useTeamSetupPlan';
import { useTeamSetupBatchProgress, type TeamSetupRepositoryPhase } from './useTeamSetupBatchProgress';
import {
  useTeamSetupResources,
  type TeamSetupResources,
} from './useTeamSetupResources';

const NO_KEYS: readonly never[] = Object.freeze([]);

export type TeamSetupRunState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'running'; operationId: string | null }>
  | Readonly<{
      kind: 'stopped';
      operationId: string | null;
      failure: ActionExecuteFailure | null;
    }>
  | Readonly<{ kind: 'done'; operationId: string | null }>;

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

type OpenedProject = Extract<OpenProjectResultV1, { kind: 'opened' }>;

/** The Open owner's own answer for one repository of the settled batch, once it opened. */
function readOpenedProject(batch: TeamSetupBatch | null, sourceId: string): OpenedProject | null {
  const row = batch?.selection.repositories.find((repository) => repository.source.id === sourceId);
  const result = row ? batch?.settlement?.repositories.find((repository) => repository.id === row.repositoryId)?.result : null;
  return result?.ok && 'kind' in result.result && result.result.kind === 'opened' ? result.result : null;
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
  const teamName = context.team.name;
  const resources = useTeamSetupResources({
    scope: context.scope,
    address: context.address,
    team: context.team,
    lifetime: props.lifetime,
  });
  const selection = useMachineAdministrationTargetSelection(
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines,
    {
      accountScope: context.scope,
    },
  );
  // A preview stands for a new member's own machine: none of the viewer's Machines is read or planned against.
  const machineId = props.preview ? null : selection.selectedTarget?.machineId ?? null;
  const machineName = useServerScopedMachineLabel(
    context.scope.serverId,
    machineId,
  );
  const homeDir = useServerScopedMachine(
    context.scope.serverId,
    machineId,
    readHomeDir,
  );
  const homeId =
    getServerProfileById(context.scope.serverId)?.serverIdentityId ?? null;

  const [execute] = React.useState(() => createFrontDoorActionExecute());
  const actionContext = React.useMemo(
    () => ({
      surface: 'ui' as const,
      serverId: context.scope.serverId,
      expectedAccountId: context.scope.accountId,
      signal: props.lifetime.signal,
    }),
    [context.scope.accountId, context.scope.serverId, props.lifetime.signal],
  );
  const plan = useTeamSetupPlan(execute, actionContext);

  const presetValue = resources.preset?.state.value ?? null;
  const repositories = resources.repositorySources;
  const [excluded, setExcluded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [run, setRun] = React.useState<TeamSetupRunState>({ kind: 'idle' });

  // The preset's own plan is read for the chosen Machine so each step shows before anything runs.
  const prepareKey =
    machineId && homeId && presetValue
      ? JSON.stringify([machineId, presetValue.id, presetValue.revision])
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
    void plan
      .prepare({
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
  }, [context.scope.serverId, homeId, machineId, plan.prepare, prepareKey]);
  const machinePlan = prepared?.key === prepareKey ? prepared : null;

  const included = repositories.filter((source) => !excluded.has(source.id));
  const hasPreset = resources.preset !== null;
  const running = run.kind === 'running';
  const canRun =
    !!machineId &&
    !!homeId &&
    !running &&
    run.kind !== 'done' &&
    (!hasPreset || !!machinePlan?.plan) &&
    (hasPreset || included.length > 0);

  // The checkout owner's registered checkouts of these Sources on the chosen Machine; one lookup for the page.
  const serverId = context.scope.serverId;
  const checkoutList = useWorkspaceRefsSelector(React.useCallback((refs) => repositories.map((source) =>
    findTeamSetupSourceCheckout(refs, { serverId, machineId, sourceId: source.id, revision: source.revision })),
  [machineId, repositories, serverId]));
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

  const start = React.useCallback(async () => {
    if (!machineId || !homeId) return;
    const repositoryInputs = included.flatMap((source) => {
      const repository = buildTeamSetupRepository(
        source,
        { serverId: context.scope.serverId, machineId, homeDir },
        clones.adopted.get(source.id) ?? null,
        checkouts.get(source.id) ?? null,
      );
      return repository ? [repository] : [];
    });
    setRun({ kind: 'running', operationId: null });
    const batch = await plan.prepare({
      target: { serverId: context.scope.serverId, homeId, machineId },
      ...(presetValue ? { preset: presetValue } : {}),
      repositories: repositoryInputs,
      isCurrent: () => true,
    });
    if (!batch || !batch.ok) {
      setRun({
        kind: 'stopped',
        operationId: null,
        failure: batch && !batch.ok ? batch : null,
      });
      return;
    }
    let operationId: string | null = null;
    const result = await plan.run({
      plan: batch.plan,
      selection: { team: context.address, lifetime: props.lifetime, sources: included },
      onMachineApplied: (applied) => {
        if (applied.ok && 'operationId' in applied.result) {
          operationId = applied.result.operationId;
          setRun({ kind: 'running', operationId });
        }
      },
    });
    const machineFailure =
      result.machine && !result.machine.ok
        ? result.machine
        : result.machineSettlement;
    setRun(
      machineFailure
        ? { kind: 'stopped', operationId, failure: machineFailure }
        : { kind: 'done', operationId },
    );
  }, [
    context.address,
    context.scope.serverId,
    props.lifetime,
    checkouts,
    clones.adopted,
    homeDir,
    homeId,
    included,
    machineId,
    plan,
    presetValue,
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
  const suggestedTask = useTeamSetupFirstTask({ serverId: context.scope.serverId, sources: included, enabled: done });
  const openTask = React.useCallback(async (project: OpenedProject, prompt: string) => {
    if (!machineId) return;
    const result = await plan.openFirstTask({ project, machineId, prompt });
    if (!result.ok) Modal.alert(t('common.error'), result.error);
  }, [machineId, plan]);
  const taskProject = suggestedTask ? readOpenedProject(plan.batch, suggestedTask.sourceId) : null;
  const firstTask = React.useMemo<TeamSetupFirstTaskView | null>(() => suggestedTask && taskProject ? {
    title: suggestedTask.title,
    markdown: suggestedTask.markdown,
    repositoryName: repositories.find((source) => source.id === suggestedTask.sourceId)?.repository?.repository.nameWithOwner
      ?? suggestedTask.sourceName,
    onOpen: () => { void openTask(taskProject, suggestedTask.markdown); },
  } : null, [openTask, repositories, suggestedTask, taskProject]);
  // A finished setup leaves its rows' results in place; choosing another Machine starts a new review.
  const setUpAnother = React.useCallback(() => setRun({ kind: 'idle' }), []);
  const startSession = React.useCallback((project: OpenedProject) => { void openTask(project, ''); }, [openTask]);

  const sourcesState = resources.sources.state;
  const sourcesLoading = sourcesState.status === 'initial' || sourcesState.status === 'loading';
  const sourcesFailed = sourcesState.status === 'offline' || sourcesState.status === 'refused';
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
  if (resources.sharedResources.status === 'ready' && sourcesState.status === 'ready' && sourcesState.coverage.complete
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
        {...(run.kind === 'done' ? { doneOn: machineName ?? null } : {})} />}
      preview={props.preview ? {
        onClose: () => router.back(),
        presetSetup: presetValue?.setup,
        scope: context.scope,
      } : undefined}
      conditions={props.conditions}
      teamName={teamName}
      selection={selection}
      machineId={machineId}
      machineLabel={machineName ?? null}
      homeDir={homeDir}
      run={run}
      canRun={canRun}
      onRun={() => { void start(); }}
      onOpenOperation={openOperation}
      onRetryFailedSetup={setupRetry ? openSetupRetry : undefined}
      sources={{
        loading: sourcesLoading,
        failure: sourcesFailed
          ? { title: sourceIssue?.title ?? t('common.unavailable'), description: sourceIssue?.description }
          : null,
        onRetry: () => { void resources.sources.controller.load(); },
      }}
      hasPreset={hasPreset}
      machinePlan={machinePlan}
      repositories={repositories}
      repositoryFreeSources={resources.repositoryFreeSources}
      excluded={excluded}
      onToggleRepository={toggleRepository}
      batch={plan.batch}
      sharedKeys={sharedKeys}
      keyDisplayNames={resources.credentialDisplayNames}
      firstTask={firstTask}
      onStartSession={startSession}
      presetChange={presetChange}
      clones={clones}
      checkouts={checkouts}
      onSetUpAnother={setUpAnother}
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
    selection: MachineAdministrationTargetSelectionV1;
    machineId: string | null;
    machineLabel: string | null;
    homeDir: string | null;
    run: TeamSetupRunState;
    canRun: boolean;
    onRun: () => void;
    onOpenOperation: (operationId: string) => void;
    onRetryFailedSetup?: () => void;
    sources: Readonly<{
      loading: boolean;
      failure: Readonly<{ title: string; description?: string }> | null;
      onRetry: () => void;
    }>;
    hasPreset: boolean;
    machinePlan: TeamSetupPreparedMachine | null;
    repositories: readonly ProjectSourceV1[];
    repositoryFreeSources: readonly ProjectSourceV1[];
    excluded: ReadonlySet<string>;
    onToggleRepository: (sourceId: string, included: boolean) => void;
    batch: TeamSetupBatch | null;
    sharedKeys: TeamSetupResources['credentials']['resources'];
    keyDisplayNames: Readonly<Record<string, string | null>>;
    /** The Team's suggested task, offered once setup is done; it opens the ordinary composer, never a launch. */
    firstTask: TeamSetupFirstTaskView | null;
    onStartSession?: (project: OpenedProject) => void;
    /** The Machine owner found the Team's preset newer than what this Machine applied. */
    presetChange: Readonly<{ revision: number; onReview: () => void }> | null;
    clones: TeamSetupExistingClones;
    /** Registered checkouts of the listed Sources on the chosen Machine, by Source id (the checkout owner's fact). */
    checkouts?: ReadonlyMap<string, WorkspaceRefV1>;
    /** After Done, the rail offers the same setup on another Machine instead of a spent button. */
    onSetUpAnother?: () => void;
    /** Preview as a member: a new member's own machine stands in for the selector, and nothing runs. */
    preview?: Readonly<{
      onClose: () => void;
      presetSetup: React.ComponentProps<typeof MachineSetupContents>['setup'];
      scope: React.ComponentProps<typeof MachineSetupContents>['scope'];
    }>;
  }>,
) {
  const { teamName, machineId, machineLabel, run, repositories } = props;
  const router = useRouter();
  const { theme } = useUnistyles();
  const compact = useDeviceType() === 'phone';
  const running = run.kind === 'running';
  const toolsOperation = run.kind !== 'idle' ? run.operationId : null;
  const stoppedOperation = run.kind === 'stopped' ? run.operationId : null;
  const seeWhatRan = stoppedOperation ? {
    label: t('teams.join.setupPage.seeWhatRan'),
    onPress: () => props.onOpenOperation(stoppedOperation),
  } : undefined;
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
  ) : run.kind === 'done' ? (
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
  ) : (
    <>
      <ItemGroup testID="team-setup-before" title={t('teams.join.setupPage.beforeYouStart')} />
      <MachineAdministrationTargetSelector
        selection={props.selection}
        presentation="context"
        testIDPrefix="team-setup-machine"
        unselectedTitle={t('teams.join.setupPage.machineUnselected', { team: teamName })}
        disabled={running}
      />
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
    </>
  );

  return (
    <>
    {props.header}
    {props.conditions}
    <PageAsideColumns compact={compact} compactAside={run.kind === 'done' ? 'last' : 'first'} aside={aside}>
      {props.sources.loading && repositories.length === 0 ? (
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
      {props.hasPreset ? (
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
            {toolsOperation ? (
              <Item
                testID="team-setup-tools-operation"
                title={
                  run.kind === 'running'
                    ? t('teams.join.setupPage.machineRunning', {
                        machine: machineLabel ?? '',
                      })
                    : t('teams.join.setupPage.seeWhatRan')
                }
                onPress={() => props.onOpenOperation(toolsOperation)}
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
      {repositories.length > 0 ? (
        <ItemGroup
          testID="team-setup-repositories"
          title={t('teams.join.setupPage.repositoriesTitle')}
          description={
            run.kind === 'done' && machineLabel
              ? t('teams.join.setupPage.repositoriesReady', { machine: machineLabel })
              : machineLabel
              ? t('teams.join.setupPage.repositoriesDescription', {
                  machine: machineLabel,
                })
              : t('teams.join.setupPage.repositoriesDescriptionNoMachine')
          }
          action={run.kind === 'done' ? undefined : (
            <RoundButton
              testID="team-setup-find-clones"
              size="small"
              display="secondary"
              title={t('teams.join.setupPage.findClones')}
              loading={props.clones.searching}
              disabled={!props.clones.onFind || running}
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
              checkout={props.checkouts?.get(source.id) ?? null}
              teamName={teamName}
              onStartSession={props.onStartSession}
              batch={props.batch}
              disabled={running || run.kind === 'done'}
              iconColor={theme.colors.text.secondary}
              onToggle={(next) => props.onToggleRepository(source.id, next)}
            />
          ))}
        </ItemGroup>
      ) : null}
      {props.clones.failure && props.clones.folder ? (
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
      {props.repositoryFreeSources.length > 0 ? (
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
      {props.sharedKeys.length > 0 ? (
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

const TeamSetupRepositoryRow = React.memo(function TeamSetupRepositoryRow(
  props: Readonly<{
    source: ProjectSourceV1;
    machineId: string | null;
    homeDir: string | null;
    included: boolean;
    /** A clone the member already has, found by Find existing clones; it is attached as it is. */
    adoptedPath: string | null;
    checkout: WorkspaceRefV1 | null;
    teamName: string;
    onStartSession?: (project: OpenedProject) => void;
    batch: TeamSetupBatch | null;
    disabled: boolean;
    iconColor: string;
    onToggle: (included: boolean) => void;
  }>,
) {
  const progress = useTeamSetupBatchProgress(props.batch, props.source.id);
  const opened = progress?.ready ? readOpenedProject(props.batch, props.source.id) : null;
  // The member's existing checkout of this Source on the chosen Machine, whose owner says if its shared setup moved on.
  const { checkout } = props;
  const existingPath = checkout?.rootPath ?? props.adoptedPath;
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
          : destination
            ? t('teams.join.setupPage.repositoryInto', { path: destination })
            : undefined
      }
      showChevron={false}
      detail={progress && !(opened && props.onStartSession) ? STATUS_WORD[progress.phase]() : undefined}
      rightElement={
        opened && props.onStartSession ? (
          <RoundButton
            testID={`team-setup-repository-start:${props.source.id}`}
            size="small"
            display="secondary"
            title={t('teams.join.setupPage.startSession')}
            onPress={() => props.onStartSession?.(opened)}
          />
        ) : progress ? undefined : (
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
    {checkout ? <TeamSetupSourceChange sourceId={props.source.id} teamName={props.teamName} checkout={checkout} /> : null}
    </>
  );
});
