import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import {
  buildProjectOpenDraft,
  buildProjectOpenInput,
  suggestProjectOpenDestination,
} from '@/components/projects/activation/projectOpenChoices';
import { presentProjectSourceIssue } from '@/components/projects/sources/projectSourceIssue';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
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
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
  useActiveServerAccountScopeLifetime,
  useServerScopedMachine,
  useServerScopedMachineLabel,
} from '@/sync/store/hooks';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import type { TeamSetupPlan, TeamSetupRepository } from './teamSetupPlan';
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

/** A fresh clone of the Source into the suggested checkout folder, through the ordinary Open owner. */
function buildFreshCloneRepository(
  source: ProjectSourceV1,
  serverId: string,
  machineId: string,
  homeDir: string | null,
): TeamSetupRepository | null {
  const subject = { kind: 'source' as const, source };
  const destination = suggestProjectOpenDestination({
    machineId,
    machineHomeDir: homeDir,
    subject,
    checkouts: [],
  });
  if (!destination) return null;
  const draft = buildProjectOpenDraft({
    serverId,
    machineId,
    machineHomeDir: homeDir,
    subject,
    ref: source.defaultRef ?? null,
    use: 'clone',
    branch: '',
    destination,
    checkouts: [],
  });
  const input = buildProjectOpenInput(draft, []);
  if (!input) return null;
  const { serverId: _serverId, machineId: _machineId, ...rest } = input;
  return { id: source.id, input: rest };
}

/**
 * Set up for a Team (plan D, L2): everything the Team expects on one of the member's Machines, in one
 * place, reviewed before anything runs. The Machine preset's own plan review and the ordinary Project
 * Open owner do the work; this page only chooses the Machine and which shared repositories to include.
 */
export const TeamSetupScreen = React.memo(function TeamSetupScreen(
  props: Readonly<{ serverId: string; teamId: string }>,
) {
  return (
    <TeamSection
      serverId={props.serverId}
      teamId={props.teamId}
      childRendersHeader
    >
      {(context, conditions) =>
        context.archived ? null : <TeamSetupBody context={context} conditions={conditions} />
      }
    </TeamSection>
  );
});

/** The Team's lockup and, only while there is something to review, the page's promise. */
export function TeamSetupHeader(props: Readonly<{
  context: Pick<TeamSectionContext, 'team' | 'address' | 'homeName'>;
  lead: boolean;
}>) {
  const { team, address, homeName } = props.context;
  const title = t('teams.join.setUpForTeam', { team: team.name });
  // The Team's identity line, as every Team page draws it (which Team, on which Home); "Suggested by"
  // joins it only while there is a setup to suggest.
  const facts = teamPageHeaderMeta({ pageTitle: title, teamName: team.name, homeName });
  return (
    <PageHeader
      testID="team-setup-header"
      alwaysShowTitle
      title={title}
      description={props.lead ? t('teams.join.setupPage.lead', { team: team.name }) : undefined}
      leading={<TeamHeaderAvatar address={address} team={team} />}
      meta={props.lead ? [...facts, { key: 'suggested', text: t('teams.join.setupPage.suggestedBy', { team: team.name }) }] : facts}
    />
  );
}

function TeamSetupBody(props: Readonly<{ context: TeamSectionContext; conditions?: React.ReactNode }>) {
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
  return <TeamSetupPlanPage context={props.context} conditions={props.conditions} lifetime={lifetime} />;
}

function TeamSetupPlanPage(
  props: Readonly<{
    context: TeamSectionContext;
    conditions?: React.ReactNode;
    lifetime: ServerAccountScopeLifetime;
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
  const machineId = selection.selectedTarget?.machineId ?? null;
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
  const repositories = React.useMemo(
    () => resources.sources.state.rows.filter((source) => source.repository),
    [resources.sources.state.rows],
  );
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

  const start = React.useCallback(async () => {
    if (!machineId || !homeId) return;
    const repositoryInputs = included.flatMap((source) => {
      const repository = buildFreshCloneRepository(
        source,
        context.scope.serverId,
        machineId,
        homeDir,
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
    homeDir,
    homeId,
    included,
    machineId,
    plan,
    presetValue,
  ]);

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
  const toggleRepository = React.useCallback((sourceId: string, next: boolean) =>
    setExcluded((current) => {
      const updated = new Set(current);
      if (next) updated.delete(sourceId);
      else updated.add(sourceId);
      return updated;
    }), []);
  if (resources.sharedResources.status === 'ready' && sourcesState.status === 'ready' && sourcesState.coverage.complete
    && !hasPreset && repositories.length === 0 && sharedKeys.length === 0) {
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
      header={<TeamSetupHeader context={context} lead />}
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
      excluded={excluded}
      onToggleRepository={toggleRepository}
      batch={plan.batch}
      sharedKeys={sharedKeys}
      keyDisplayNames={resources.credentialDisplayNames}
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
    sources: Readonly<{
      loading: boolean;
      failure: Readonly<{ title: string; description?: string }> | null;
      onRetry: () => void;
    }>;
    hasPreset: boolean;
    machinePlan: TeamSetupPreparedMachine | null;
    repositories: readonly ProjectSourceV1[];
    excluded: ReadonlySet<string>;
    onToggleRepository: (sourceId: string, included: boolean) => void;
    batch: TeamSetupBatch | null;
    sharedKeys: TeamSetupResources['credentials']['resources'];
    keyDisplayNames: Readonly<Record<string, string | null>>;
  }>,
) {
  const { teamName, machineId, machineLabel, run, repositories } = props;
  const { theme } = useUnistyles();
  const compact = useDeviceType() === 'phone';
  const running = run.kind === 'running';
  const aside = (
    <ItemGroup
      testID="team-setup-before"
      title={t('teams.join.setupPage.beforeYouStart')}
    >
      <MachineAdministrationTargetSelector
        selection={props.selection}
        presentation="context"
        testIDPrefix="team-setup-machine"
        unselectedTitle={t('teams.join.setupPage.machineUnselected', { team: teamName })}
        disabled={running}
      />
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
  );

  return (
    <>
    {props.header}
    {props.conditions}
    <PageAsideColumns compact={compact} compactAside="first" aside={aside}>
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
          action={
            run.operationId
              ? {
                  label: t('teams.join.setupPage.seeWhatRan'),
                  onPress: () => props.onOpenOperation(run.operationId!),
                }
              : {
                  label: t('common.retry'),
                  onPress: props.onRun,
                }
          }
        />
      ) : null}
      {props.hasPreset ? (
        <ItemGroup
          testID="team-setup-tools"
          title={
            machineLabel
              ? t('teams.join.setupPage.toolsTitle', { machine: machineLabel })
              : t('teams.join.setupPage.toolsTitleNoMachine')
          }
          description={t('teams.join.setupPage.toolsDescription', { team: teamName })}
        >
          {run.kind !== 'idle' && run.operationId ? (
            <Item
              testID="team-setup-tools-operation"
              title={
                run.kind === 'running'
                  ? t('teams.join.setupPage.machineRunning', {
                      machine: machineLabel ?? '',
                    })
                  : t('teams.join.setupPage.seeWhatRan')
              }
              onPress={() => props.onOpenOperation(run.operationId!)}
            />
          ) : !machineId ? (
            <Item
              testID="team-setup-tools-choose"
              title={t('teams.join.setupPage.toolsChooseMachine')}
              showChevron={false}
            />
          ) : props.machinePlan?.failure ? (
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
          ) : (
            <PageLoadingRows testID="team-setup-tools-loading" />
          )}
        </ItemGroup>
      ) : null}
      {repositories.length > 0 ? (
        <ItemGroup
          testID="team-setup-repositories"
          title={t('teams.join.setupPage.repositoriesTitle')}
          description={
            machineLabel
              ? t('teams.join.setupPage.repositoriesDescription', {
                  machine: machineLabel,
                })
              : t('teams.join.setupPage.repositoriesDescriptionNoMachine')
          }
        >
          {repositories.map((source) => (
            <TeamSetupRepositoryRow
              key={source.id}
              source={source}
              machineId={machineId}
              homeDir={props.homeDir}
              included={!props.excluded.has(source.id)}
              batch={props.batch}
              disabled={running || run.kind === 'done'}
              iconColor={theme.colors.text.secondary}
              onToggle={(next) => props.onToggleRepository(source.id, next)}
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
    batch: TeamSetupBatch | null;
    disabled: boolean;
    iconColor: string;
    onToggle: (included: boolean) => void;
  }>,
) {
  const progress = useTeamSetupBatchProgress(props.batch, props.source.id);
  const destination = props.machineId
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
    <Item
      testID={`team-setup-repository:${props.source.id}`}
      icon={<Icon name="github-logo" size={20} color={props.iconColor} />}
      title={nameWithOwner}
      subtitle={
        destination
          ? t('teams.join.setupPage.repositoryInto', { path: destination })
          : undefined
      }
      showChevron={false}
      detail={progress ? STATUS_WORD[progress.phase]() : undefined}
      rightElement={
        progress ? undefined : (
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
  );
});
