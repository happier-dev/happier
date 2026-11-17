import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import {
  buildProjectOpenDraft,
  buildProjectOpenInput,
  suggestProjectOpenDestination,
} from '@/components/projects/activation/projectOpenChoices';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { MachineSetupPlanReview } from '@/components/settings/machines/managed/MachineSetupPlanReview';
import { TeamHeaderAvatar } from '@/components/settings/teams/TeamHeaderAvatar';
import { TeamSection } from '@/components/settings/teams/TeamSection';
import type { TeamSectionContext } from '@/components/settings/teams/teamSectionContext';
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
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
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
import { useTeamSetupPlan } from './useTeamSetupPlan';
import {
  useTeamSetupResources,
  type TeamSetupResources,
} from './useTeamSetupResources';

type RepositoryStatus = 'queued' | 'opening' | 'ready' | 'approval' | 'failed';
type RunState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'running'; operationId: string | null }>
  | Readonly<{
      kind: 'stopped';
      operationId: string | null;
      failure: ActionExecuteFailure | null;
    }>
  | Readonly<{ kind: 'done'; operationId: string | null }>;

type PreparedMachine = Readonly<{
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
function TeamSetupHeader(props: Readonly<{ context: TeamSectionContext; lead: boolean }>) {
  const { team, address } = props.context;
  return (
    <PageHeader
      testID="team-setup-header"
      alwaysShowTitle
      title={t('teams.join.setUpForTeam', { team: team.name })}
      description={props.lead ? t('teams.join.setupPage.lead', { team: team.name }) : undefined}
      leading={<TeamHeaderAvatar address={address} team={team} />}
      meta={props.lead ? [{ key: 'suggested', text: t('teams.join.setupPage.suggestedBy', { team: team.name }) }] : undefined}
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
  const { theme } = useUnistyles();
  const router = useRouter();
  const compact = useDeviceType() === 'phone';
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
    }),
    [context.scope.accountId, context.scope.serverId],
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
  const [statuses, setStatuses] = React.useState<
    ReadonlyMap<string, RepositoryStatus>
  >(() => new Map());
  const [run, setRun] = React.useState<RunState>({ kind: 'idle' });

  // The preset's own plan is read for the chosen Machine so each step shows before anything runs.
  const prepareKey =
    machineId && homeId && presetValue
      ? JSON.stringify([machineId, presetValue.id, presetValue.revision])
      : null;
  const [prepared, setPrepared] = React.useState<PreparedMachine | null>(null);
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
  }, [context.scope.serverId, homeId, machineId, plan, prepareKey]);
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
    setStatuses(
      new Map(
        repositoryInputs.map((repository) => [
          repository.id,
          'queued' as const,
        ]),
      ),
    );
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
      onMachineApplied: (applied) => {
        if (applied.ok && 'operationId' in applied.result) {
          operationId = applied.result.operationId;
          setRun({ kind: 'running', operationId });
        }
      },
      onRepositoryOpened: (id, opened) => {
        const approval = opened.ok && ActionApprovalRequestCreatedResultSchema.safeParse(opened.result).success;
        setStatuses((current) =>
          new Map(current).set(
            id,
            !opened.ok ? 'failed' : approval ? 'approval' : 'ready',
          ),
        );
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
    context.scope.serverId,
    homeDir,
    homeId,
    included,
    machineId,
    plan,
    presetValue,
  ]);

  const loading =
    resources.sharedResources.status !== 'ready' &&
    resources.sources.state.rows.length === 0 &&
    !resources.preset;
  if (!loading && !hasPreset && repositories.length === 0) {
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

  const machineLabel = machineName ?? null;
  const aside = (
    <ItemGroup
      testID="team-setup-before"
      title={t('teams.join.setupPage.beforeYouStart')}
    >
      <MachineAdministrationTargetSelector
        selection={selection}
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
          disabled={!canRun}
          onPress={() => {
            void start();
          }}
        />
      </BareSectionContent>
    </ItemGroup>
  );

  return (
    <>
    <TeamSetupHeader context={context} lead />
    {props.conditions}
    <PageAsideColumns compact={compact} compactAside="first" aside={aside}>
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
                  onPress: () =>
                    openActionOperationDetail({
                      serverId: context.scope.serverId,
                      operationId: run.operationId!,
                    }),
                }
              : {
                  label: t('common.retry'),
                  onPress: () => {
                    void start();
                  },
                }
          }
        />
      ) : null}
      {hasPreset ? (
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
              onPress={() =>
                openActionOperationDetail({
                  serverId: context.scope.serverId,
                  operationId: run.operationId!,
                })
              }
            />
          ) : !machineId ? (
            <Item
              testID="team-setup-tools-choose"
              title={t('teams.join.setupPage.toolsChooseMachine')}
              showChevron={false}
            />
          ) : machinePlan?.failure ? (
            <SurfaceStateCard
              testID="team-setup-tools-failed"
              kind="error"
              size="line"
              title={t('teams.join.setupPage.toolsFailed', {
                machine: machineLabel ?? '',
              })}
              reason={machinePlan.failure.error}
            />
          ) : machinePlan?.plan?.machine ? (
            <MachineSetupPlanReview
              testID="team-setup-tools-review"
              prepared={machinePlan.plan.machine}
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
              homeDir={homeDir}
              included={!excluded.has(source.id)}
              status={statuses.get(source.id) ?? null}
              disabled={running || run.kind === 'done'}
              iconColor={theme.colors.text.secondary}
              onToggle={(next) =>
                setExcluded((current) => {
                  const updated = new Set(current);
                  if (next) updated.delete(source.id);
                  else updated.add(source.id);
                  return updated;
                })
              }
            />
          ))}
        </ItemGroup>
      ) : null}
    </PageAsideColumns>
    </>
  );
}

const STATUS_WORD: Record<RepositoryStatus, () => string> = {
  queued: () => t('teams.join.setupPage.statusQueued'),
  opening: () => t('teams.join.setupPage.statusOpening'),
  ready: () => t('teams.join.setupPage.statusReady'),
  approval: () => t('teams.join.setupPage.statusApproval'),
  failed: () => t('teams.join.setupPage.statusFailed'),
};

const TeamSetupRepositoryRow = React.memo(function TeamSetupRepositoryRow(
  props: Readonly<{
    source: ProjectSourceV1;
    machineId: string | null;
    homeDir: string | null;
    included: boolean;
    status: RepositoryStatus | null;
    disabled: boolean;
    iconColor: string;
    onToggle: (included: boolean) => void;
  }>,
) {
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
      detail={props.status ? STATUS_WORD[props.status]() : undefined}
      rightElement={
        props.status ? undefined : (
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
