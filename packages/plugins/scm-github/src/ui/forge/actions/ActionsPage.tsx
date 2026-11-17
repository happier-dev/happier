import * as React from 'react';
import { readForgeCiSelectionRunV1 } from '@happier-dev/forge-ci/runtime';
import {
  useForgeCiQueryStatusV1,
  useForgeCiPagedQueryV1,
  useForgeCiQueryValueV1,
  readForgeOperationStateV1,
  ForgeCiRunDetailView,
  useForgeCiRunPaneHeaderV1,
  ForgeCiStateNotice,
  type ForgeCiBindingV1,
  useForgeCiMountedViewV1,
  useForgeCiMountedViewStateV1,
  type ForgeCiMountedViewV1,
} from '@happier-dev/forge-ci/ui';
import { sameScmHostingRepositoryIdentity, type ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Banner,
  Button,
  Collection,
  CollectionToolbar,
  DetailsPaneOpenAsPageButton,
  formatHappierAsOfTime,
  Icon,
  Row,
  Select,
  SurfaceState,
  usePluginHostApi,
  usePluginTranslation,
  useSurfaceContext,
  type MenuItem,
} from '@happier-dev/plugin-ui';
import { usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { bindGithubCiMountedViewV1, GITHUB_CI_MOUNTED_ACTION_ID_V1 } from '../../../actions/mounted.js';
import type {
  ForgeCiRunV1,
  ForgeCiJobRefV1,
  ForgeCiSelectionV1,
} from '@happier-dev/triage-protocol/ci/v1';
import {
  githubActionsPaneLocationsV1,
  parseGithubActionsLocationV1,
  replaceGithubActionsLocationV1,
  type GithubActionsLocationV1,
} from '../../actions/model.js';
import { useGithubCiBindingV1 } from '../../actions/useGithubCiBinding.js';
import { useGithubCiFixV1 } from '../../actions/useGithubCiFix.js';
import { GITHUB_DEPLOYMENT_MONITORING_OPEN_ACTION_ID } from '../../../actions/deploymentMonitoring.js';
import { GITHUB_PLUGIN_ID } from '../../../observations/githubProviderContracts.js';
import {
  GITHUB_ACTIONS_RUNS_PAGE_SIZE_V1,
  matchesGithubActionsRunV1,
  type GithubActionsRunScopeV1,
} from './runGroups.js';
import { WorkflowsCollection } from './WorkflowsCollection.js';
import { GithubRunDeploymentReview } from '../deployments/GithubRunDeploymentReview.js';
import { GithubDeploymentBanner } from '../deployments/GithubDeploymentBanner.js';
import { useGithubLocalRunOpenV1, type GithubLocalRunOpenV1 } from './localRun.js';
import { githubRunCollectionKeyV1, useGithubRunsCollectionV1 } from './runsCollectionModel.js';
import { GITHUB_ACTIONS_PAGE_ID_V1 } from '../surfaceIds.js';

const GITHUB_DEPLOYMENT_MONITORING_OPEN_REF = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_DEPLOYMENT_MONITORING_OPEN_ACTION_ID } as const;

type Translate = (
  key: string,
  fallback: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

/** The pane minima at normal text size: a run row's title and meta, and a readable run detail. */
const MIN_LIST_WIDTH = 420;
const MIN_DETAIL_WIDTH = 460;

/**
 * The Actions Project page (labs a2/a3/a9): runs or workflows for the Project's repository as one Collection,
 * with the run detail in the host's details pane, pushed on a phone, and expanded through the shared Open as page
 * control. The page owns layout and copy; reads, the run row and the run detail are the shared CI owners'.
 */
export function GithubActionsPage({
  context,
}: Readonly<{ context: RenderContext }>): React.ReactElement {
  const translate: Translate = usePluginTranslation();
  const target = context.surface.target;
  const repository =
    target.kind === 'project' && target.repository?.kind === 'github'
      ? target.repository
      : null;
  const fix = useGithubCiFixV1({ signal: context.signal });
  const ci = useGithubCiBindingV1(repository, { signal: context.signal, fix });
  if (target.kind !== 'project') {
    return (
      <SurfaceState
        kind="unavailable"
        title={translate(
          'plugins.github.actions.needsProject',
          'Actions opens from a Project',
        )}
        description={translate(
          'plugins.github.actions.needsProject.description',
          'Open a Project whose repository is on GitHub to see its workflow runs.',
        )}
      />
    );
  }
  if (repository === null) {
    return (
      <SurfaceState
        kind="unavailable"
        title={translate(
          'plugins.github.actions.noRepository',
          'No GitHub repository here',
        )}
        description={
          target.repository === undefined
            ? translate(
                'plugins.github.actions.noRepository.unknown',
                'This Project’s repository isn’t known yet. Actions appears once its checkout reports a GitHub remote.',
              )
            : translate(
                'plugins.github.actions.noRepository.other',
                'This Project’s repository isn’t on GitHub, so it has no GitHub Actions runs.',
              )
        }
      />
    );
  }
  return (
    <ActionsBody
      context={context}
      repository={repository}
      branch={target.branch ?? null}
      ci={ci}
      translate={translate}
    />
  );
}

function ActionsBody({
  context,
  repository,
  branch,
  ci,
  translate,
}: Readonly<{
  context: RenderContext;
  repository: ScmHostingRepositoryIdentityV1;
  branch: string | null;
  ci: ForgeCiBindingV1;
  translate: Translate;
}>): React.ReactElement {
  const host = usePluginHostApi();
  const reads = ci.reads;
  const localRun = useGithubLocalRunOpenV1(context);
  const [location, setLocation] = React.useState<GithubActionsLocationV1>(
    () =>
      parseGithubActionsLocationV1(context.subPath ?? '') ?? {
        kind: 'list',
        view: 'runs',
      },
  );
  const [moveFailed, setMoveFailed] = React.useState(false);
  React.useEffect(() => {
    const parsed = parseGithubActionsLocationV1(context.subPath ?? '');
    if (parsed !== null) setLocation(parsed);
  }, [context.subPath]);
  const go = React.useCallback(
    async (subPath: string, backLocation: string) => {
      const result = await replaceGithubActionsLocationV1(
        host,
        { subPath, backLocation },
        location,
      );
      if (context.signal.aborted) return { kind: 'unavailable' as const, location };
      setMoveFailed(result.kind === 'unavailable');
      setLocation(result.location);
      return result;
    },
    [context.signal, host, location],
  );
  const view =
    location.kind === 'workflow'
      ? 'workflows'
      : location.kind === 'run'
        ? 'runs'
        : location.view;
  const surface = useSurfaceContext();
  const mountedView: ForgeCiMountedViewV1 | null = useForgeCiMountedViewV1({
    mountId: surface.mountId,
    signal: context.signal,
    phone: surface.platform === 'ios' || surface.platform === 'android',
    initialState: {
      view,
      ...(location.kind === 'workflow' ? { workflowId: location.workflowId } : {}),
      ...(location.kind === 'run' ? { selection: attemptSelection(repository, location.runId, location.attempt) } : {}),
    },
    canApply: operation => !(operation.kind === 'setJobsView' && operation.view === 'graph'),
    applyOperation: operation => {
      const navigateTo = (subPath: string) => {
        if (context.signal.aborted || mountedView?.getSnapshot() === null) return false;
        const next = parseGithubActionsLocationV1(subPath);
        if (next === null) return false;
        if (pluginJsonValuesEqual(next, location)) return true;
        return go(subPath, subPath.startsWith('workflows') ? 'workflows' : 'runs').then(settled =>
          !context.signal.aborted && mountedView?.getSnapshot() !== null
          && settled.kind === 'applied' && pluginJsonValuesEqual(next, settled.location));
      };
      let subPath: string | null = null;
      if (operation.kind === 'selectView') subPath = operation.view;
      if (operation.kind === 'selectWorkflow') subPath = `workflows/${operation.workflowId}`;
      if (operation.kind === 'selectRun' || operation.kind === 'selectAttempt' || operation.kind === 'selectJob') {
        const selection = operation.kind === 'selectRun' ? { kind: 'run' as const, run: operation.run }
          : operation.kind === 'selectAttempt' ? operation.selection : operation.job.selection;
        const run = readForgeCiSelectionRunV1(selection);
        if (!sameScmHostingRepositoryIdentity(run.repository, repository)) return false;
        const attempt = selection.kind === 'attempt' ? selection.attempt.attemptId
          : runs?.rows.find(value => value.ref.runId === run.runId)?.currentAttempt?.attemptId;
        const pathForAttempt = (attemptId: string) => `runs/${run.runId}/attempts/${attemptId}${operation.kind === 'selectJob' ? `/jobs/${operation.job.jobId}` : ''}${location.kind === 'run' && location.presentation === 'page' ? '/page' : ''}`;
        if (attempt) return navigateTo(pathForAttempt(attempt));
        if (!reads || context.signal.aborted) return false;
        const lease = reads.acquire('readRun', { repository, runId: run.runId }, {
          signal: context.signal,
          ...(ci.adapter ? { adapter: ci.adapter } : {}),
        });
        return (async () => {
          try {
            await lease.refresh();
            const snapshot = lease.getSnapshot();
            if (context.signal.aborted || mountedView?.getSnapshot() === null || snapshot.retired || snapshot.failure) return false;
            const currentAttempt = snapshot.value?.currentAttempt?.attemptId;
            return currentAttempt ? navigateTo(pathForAttempt(currentAttempt)) : false;
          } finally { lease.release(); }
        })();
      }
      if (subPath === null) return true;
      return navigateTo(subPath);
    },
  });
  const mountedState = useForgeCiMountedViewStateV1(mountedView);
  const scope = mountedState?.runScope ?? 'all';
  const query = mountedState?.query ?? '';
  const setScope = React.useCallback((scope: GithubActionsRunScopeV1) => { void mountedView?.invoke({ mountId: mountedView.mountId, operation: { kind: 'setRunScope', scope } }); }, [mountedView]);
  const setQuery = React.useCallback((query: string) => { void mountedView?.invoke({ mountId: mountedView.mountId, operation: { kind: 'setQuery', query } }); }, [mountedView]);
  const sharedScope = usePluginUiEphemeralSharedScope();
  React.useEffect(() => sharedScope && mountedView
    ? bindGithubCiMountedViewV1(sharedScope, mountedView, context.signal) : undefined,
  [sharedScope, mountedView, context.signal]);
  React.useEffect(() => {
    if (!mountedView || context.signal.aborted) return;
    host.publishCurrentUiContext({ commands: [{
      title: translate(view === 'runs' ? 'plugins.github.actions.view.workflows' : 'plugins.github.actions.view.runs', view === 'runs' ? 'Workflows' : 'Runs'),
      command: { kind: 'executeAction', action: GITHUB_CI_MOUNTED_ACTION_ID_V1,
        input: { mountId: mountedView.mountId, operation: { kind: 'selectView', view: view === 'runs' ? 'workflows' : 'runs' } } },
    }, ...(view === 'workflows' && (mountedState?.triggerAvailable || mountedState?.triggerFormOpen) ? [{
      title: translate(mountedState.triggerFormOpen ? 'happier.plugin-ui.form.cancel' : 'plugins.github.actions.runWorkflow', mountedState.triggerFormOpen ? 'Cancel' : 'Run workflow'),
      command: { kind: 'executeAction' as const, action: GITHUB_CI_MOUNTED_ACTION_ID_V1,
        input: { mountId: mountedView.mountId, operation: { kind: 'setTriggerFormOpen', open: !mountedState.triggerFormOpen } } },
    }] : []), ...(view === 'workflows' && mountedState?.triggerFormOpen && mountedState.triggerEnvironmentCursor ? [{
      title: translate('forgeCi.trigger.moreEnvironments', 'Load more environments'),
      command: { kind: 'executeAction' as const, action: GITHUB_CI_MOUNTED_ACTION_ID_V1,
        input: { mountId: mountedView.mountId, operation: { kind: 'loadTriggerEnvironments', cursor: mountedState.triggerEnvironmentCursor } } },
    }] : [])] });
    const clear = () => host.publishCurrentUiContext(null);
    context.signal.addEventListener('abort', clear, { once: true });
    return () => { context.signal.removeEventListener('abort', clear); clear(); };
  }, [context.signal, host, mountedView, mountedState?.triggerAvailable, mountedState?.triggerFormOpen, mountedState?.triggerEnvironmentCursor, translate, view]);
  React.useEffect(() => {
    if (!mountedView) return;
    if (location.kind === 'list') {
      mountedView.closeSelection();
      void mountedView.invoke({ mountId: mountedView.mountId, operation: { kind: 'selectView', view: location.view } });
    } else if (location.kind === 'workflow') {
      void mountedView.invoke({ mountId: mountedView.mountId, operation: { kind: 'selectWorkflow', workflowId: location.workflowId } });
    } else {
      const selection = attemptSelection(repository, location.runId, location.attempt);
      void (async () => {
        await mountedView.invoke({ mountId: mountedView.mountId, operation: { kind: 'selectAttempt', selection } });
        if (location.jobId) await mountedView.invoke({ mountId: mountedView.mountId, operation: { kind: 'selectJob', job: { selection, jobId: location.jobId } } });
        else mountedView.openSummary();
      })();
    }
  }, [location, mountedView, repository]);

  const runsLease = useForgeCiPagedQueryV1(reads, 'listRuns', {
    repository,
    filters: mountedState?.filters ?? {},
    pageSize: GITHUB_ACTIONS_RUNS_PAGE_SIZE_V1,
  }, !context.signal.aborted);
  const runs = useForgeCiQueryValueV1(runsLease);
  const runsStatus = useForgeCiQueryStatusV1(runsLease);
  const runsBusy = runsStatus.snapshot?.pending === true;
  const runsMore = React.useMemo(
    () => (runsLease === null ? null : { loadMore: () => runsLease.loadMore(), busy: runsBusy }),
    [runsLease, runsBusy],
  );
  const workflowsLease = useForgeCiPagedQueryV1(
    reads,
    'listWorkflows',
    { repository },
    // Both lenses read the workflow list: the runs list names each run by its workflow ("CI #4821").
    !context.signal.aborted,
  );
  const workflows = useForgeCiQueryValueV1(workflowsLease);
  const workflowsStatus = useForgeCiQueryStatusV1(workflowsLease);
  const workflowNames = React.useMemo(
    () => new Map((workflows?.rows ?? []).map((workflow) => [workflow.id, workflow.name] as const)),
    [workflows],
  );

  const lens = (
    <Select
      presentation="segmented"
      label={translate('plugins.github.actions.view', 'Show')}
      value={view}
      options={[
        {
          value: 'runs',
          label: translate('plugins.github.actions.view.runs', 'Runs'),
        },
        {
          value: 'workflows',
          label: translate(
            'plugins.github.actions.view.workflows',
            'Workflows',
          ),
        },
      ]}
      onChange={(value) => {
        void go(value === 'workflows' ? 'workflows' : 'runs', '');
      }}
    />
  );
  // Which runs: the wide row's control, and the folded Filters sheet's content.
  const scopeControl = (
    <Select
      presentation="segmented"
      label={translate('plugins.github.actions.filter', 'Show runs')}
      value={scope}
      options={scopeOptions(translate)}
      onChange={(value) => setScope(value as GithubActionsRunScopeV1)}
    />
  );
  const webUrl = `${repository.deployment.replace(/\/$/u, '')}/${repository.repository}/actions`;
  const more = {
    label: translate('plugins.github.actions.more', 'More Actions options'),
    items: [
      {
        id: 'monitoring',
        label: translate(
          'plugins.github.actions.monitoring',
          'Deployment monitoring',
        ),
        subtitle: translate(
          'plugins.github.actions.monitoring.subtitle',
          'Get notified when a deploy waits for you',
        ),
        icon: 'watch',
      },
      {
        id: 'github',
        label: translate(
          'plugins.github.actions.openOnGithub',
          'Open Actions on GitHub',
        ),
        icon: 'external',
      },
    ] satisfies readonly MenuItem[],
    onSelect: (id: string) => {
      if (id === 'github') void host.openExternalLink(webUrl);
      // Opens the existing Event setup for this repository; it enrolls nothing until the person submits it.
      if (id === 'monitoring')
        void host.executeAction(GITHUB_DEPLOYMENT_MONITORING_OPEN_REF, {
          repository: repository.repository,
        });
    },
  };
  const status = view === 'workflows' ? workflowsStatus : runsStatus;
  const freshness =
    status.snapshot?.checkedAtMs == null || status.snapshot.failure !== null
      ? null
      : {
          tone: 'muted' as const,
          label: translate('plugins.github.releases.toolbar.asOf', 'As of {time}', {
            time: formatHappierAsOfTime(status.snapshot.checkedAtMs, Date.now(), surface.locale),
          }),
        };
  const [runRequest, setRunRequest] = React.useState<string | null>(null);
  const clearRunRequest = React.useCallback(() => setRunRequest(null), []);
  const runnable = workflows?.rows.filter((workflow) => workflow.nativeState === 'active') ?? null;
  // The list says which workflows can start; the chosen one's definition says whether it can start by hand, read
  // only once it is opened. Nothing to run offers nothing; a list still reading says so in its menu.
  const runWorkflow = runnable !== null && runnable.length === 0 ? undefined : {
    label: translate('plugins.github.actions.runWorkflow', 'Run workflow'),
    menu: {
      items: runnable === null
        ? [{ id: 'loading', label: translate('plugins.github.actions.workflow.loading', 'Loading workflow'), disabled: true }]
        : runnable.map((workflow): MenuItem => ({ id: workflow.id, label: workflow.name, icon: 'workflow' })),
      onSelect: (id: string) => {
        setRunRequest(id);
        void go(`workflows/${id}`, view);
      },
    },
  };
  const banner = moveFailed ? (
    <Banner
      tone="warning"
      presentation="strip"
      title={translate(
        'plugins.github.actions.moveFailed',
        'That view couldn’t open',
      )}
      description={translate(
        'plugins.github.actions.moveFailed.description',
        'You’re still on the previous view.',
      )}
    />
  ) : null;

  if (view === 'workflows') {
    return (
      <WorkflowsCollection
        minListWidth={MIN_LIST_WIDTH}
        minDetailWidth={MIN_DETAIL_WIDTH}
        repository={repository}
        reads={reads}
        ci={ci}
        mountedView={mountedView}
        branch={branch}
        localRun={localRun}
        translate={translate}
        workflows={workflows?.rows ?? null}
        runs={runs?.rows ?? []}
        status={workflowsStatus}
        location={location}
        go={go}
        query={query}
        onQueryChange={setQuery}
        runRequest={runRequest}
        onRunRequestHandled={clearRunRequest}
        header={(slots) => (
          <>
            {banner}
            <CollectionToolbar
              slots={slots}
              lens={lens}
              freshness={freshness}
              refresh={{
                label: translate('plugins.github.actions.refresh', 'Refresh'),
                busy: workflowsStatus.snapshot?.pending === true,
                onPress: () => {
                  void workflowsStatus.refresh();
                },
              }}
              more={more}
              {...(runWorkflow === undefined ? {} : { primary: runWorkflow })}
            />
          </>
        )}
      />
    );
  }
  return (
    <RunsCollection
      repository={repository}
      branch={branch}
      ci={ci}
      mountedView={mountedView}
      localRun={localRun}
      translate={translate}
      page={runs}
      status={runsStatus}
      more={runsMore}
      workflowNames={workflowNames}
      location={location}
      go={go}
      signal={context.signal}
      scope={scope}
      query={query}
      onQueryChange={setQuery}
      header={(slots) => (
        <>
          {banner}
          <CollectionToolbar
            slots={slots}
            lens={lens}
            freshness={freshness}
            refine={{
              label: translate('plugins.github.actions.filter', 'Show runs'),
              activeCount: scope === 'all' ? 0 : 1,
              render: () => scopeControl,
              // The scope switch is the whole filter and stands in the wide row; folded, the search field's funnel
              // opens the same control in the shared sheet, where a choice applies as it is touched.
              inline: true,
              sheet: { render: () => scopeControl },
            }}
            refresh={{
              label: translate('plugins.github.actions.refresh', 'Refresh'),
              busy: runsStatus.snapshot?.pending === true,
              onPress: () => {
                void runsStatus.refresh();
              },
            }}
            more={more}
            {...(runWorkflow === undefined ? {} : { primary: runWorkflow })}
          />
        </>
      )}
    />
  );
}

function scopeOptions(translate: Translate) {
  return [
    {
      value: 'all',
      label: translate('plugins.github.actions.filter.all', 'All'),
    },
    {
      value: 'active',
      label: translate('plugins.github.actions.filter.active', 'Active'),
    },
    {
      value: 'failed',
      label: translate('plugins.github.actions.filter.failed', 'Failed'),
    },
  ] as const;
}

type HeaderRender = React.ComponentProps<typeof Collection>['header'];
type QueryStatus = ReturnType<typeof useForgeCiQueryStatusV1>;
type Go = (subPath: string, backLocation: string) => ReturnType<typeof replaceGithubActionsLocationV1>;

function attemptSelection(
  repository: ScmHostingRepositoryIdentityV1,
  runId: string,
  attemptId: string,
): ForgeCiSelectionV1 {
  return {
    kind: 'attempt',
    attempt: { run: { v: 1, repository, runId }, attemptId },
  };
}


function RunsCollection({
  repository,
  branch,
  ci,
  mountedView,
  localRun,
  translate,
  page,
  status,
  more,
  workflowNames,
  location,
  go,
  signal,
  scope,
  query,
  onQueryChange,
  header,
}: Readonly<{
  repository: ScmHostingRepositoryIdentityV1;
  branch: string | null;
  ci: ForgeCiBindingV1;
  mountedView: ForgeCiMountedViewV1 | null;
  localRun: GithubLocalRunOpenV1 | null;
  translate: Translate;
  page: Readonly<{
    rows: readonly ForgeCiRunV1[];
    continuation: string | null;
    incomplete: string | null;
  }> | null;
  status: QueryStatus;
  more: Readonly<{ loadMore: () => unknown; busy: boolean }> | null;
  workflowNames: ReadonlyMap<string, string>;
  location: GithubActionsLocationV1;
  go: Go;
  signal: AbortSignal;
  scope: GithubActionsRunScopeV1;
  query: string;
  onQueryChange: (value: string) => void;
  header: HeaderRender;
}>): React.ReactElement {
  // Durations tick inside the anatomy's time leaf; the model changes only with the window,
  // the narrowing, the open run or the local calendar day.
  const filter = React.useCallback(
    (run: ForgeCiRunV1) => matchesGithubActionsRunV1(run, scope, query),
    [scope, query],
  );
  const openKey =
    location.kind === 'run' ? `${location.runId}/${location.attempt}` : null;
  const onOpenChange = React.useCallback(
    (key: string | null) => {
      void go(
        key === null ? 'runs' : `runs/${key.replace('/', '/attempts/')}`,
        key === null ? '' : 'runs',
      );
    },
    [go],
  );
  const { anatomy, model } = useGithubRunsCollectionV1({ page, translate, workflowNames, filter, openKey, onOpenChange, more });
  const rows = page?.rows ?? [];
  const failure = status.snapshot?.failure ?? null;
  const detailLocations =
    location.kind === 'run'
      ? githubActionsPaneLocationsV1(
          `runs/${location.runId}/attempts/${location.attempt}${location.jobId === undefined ? '' : `/jobs/${location.jobId}`}`,
        )
      : null;
  const selected =
    location.kind === 'run'
      ? (rows.find((run) => githubRunCollectionKeyV1(run) === openKey) ?? null)
      : null;
  // The pane's header row names the run (lab a9); the detail body then starts at the run controls.
  const runHeader = useForgeCiRunPaneHeaderV1(selected);

  const deploymentReview = React.useCallback(
    (waiting: ForgeCiRunV1) => <GithubRunDeploymentReview reads={ci.reads} repository={repository} run={waiting} />,
    [ci.reads, repository],
  );
  // 08's Reproduce locally beside the selected job, seeded with this run's admitted workflow and commit only.
  const renderJobAction = localRun === null ? undefined : ({ run }: Readonly<{ run: ForgeCiRunV1 }>) => (
    <Button variant="secondary" size="small"
      title={translate('plugins.github.actions.reproduceLocally', 'Reproduce locally')}
      onPress={() => localRun({
        ...(run.workflow?.path === undefined ? {} : { workflowPath: run.workflow.path }),
        ...(run.headSha === undefined ? {} : { sourceHeadSha: run.headSha }),
      })} />
  );

  if (location.kind === 'run' && location.presentation === 'page') {
    return (
      <ForgeCiRunDetailView
        ci={ci}
        view={mountedView}
        presentation="page"
        pageKind={{ pluginId: GITHUB_PLUGIN_ID, localId: `${GITHUB_ACTIONS_PAGE_ID_V1}/run` }}
        {...(renderJobAction === undefined ? {} : { renderJobAction })}
        deploymentReview={deploymentReview}
        selection={attemptSelection(
          repository,
          location.runId,
          location.attempt,
        )}
        selectedJobId={location.jobId ?? null}
        onOpenJob={(job: ForgeCiJobRefV1) => {
          void go(
            `runs/${location.runId}/attempts/${location.attempt}/jobs/${job.jobId}/page`,
            `runs/${location.runId}/attempts/${location.attempt}/page`,
          );
        }}
        onOpenSummary={() => {
          void go(
            `runs/${location.runId}/attempts/${location.attempt}/page`,
            `runs/${location.runId}/attempts/${location.attempt}`,
          );
        }}
        back={{
          label: translate('plugins.github.actions.returnToList', 'Runs'),
          onPress: () => {
            if (detailLocations)
              void go(
                detailLocations.returnLocation.subPath,
                detailLocations.returnLocation.backLocation,
              );
          },
        }}
      />
    );
  }

  return (
    <Collection
      testID="github.actions.runs"
      accessibilityLabel={translate(
        'plugins.github.actions.runs.label',
        'Workflow runs',
      )}
      model={model}
      anatomy={anatomy}
      presentation="list"
      detail="auto"
      scroll="page"
      pageRoot
      minListWidth={MIN_LIST_WIDTH}
      minDetailWidth={MIN_DETAIL_WIDTH}
      preferredListRatio={0.5}
      loading={page === null && status.snapshot?.failure == null}
      search={{
        label: translate('plugins.github.actions.search', 'Filter runs'),
        placeholder: translate('plugins.github.actions.search', 'Filter runs'),
        width: 'fixed',
        value: query,
        onValueChange: onQueryChange,
      }}
      header={(slots) => (
        <>
          {typeof header === 'function' ? header(slots) : header}
          <GithubDeploymentBanner
            reads={ci.reads}
            repository={repository}
            runs={rows}
            signal={signal}
            translate={translate}
          />
          {failure !== null && page !== null ? (
            <ForgeCiStateNotice
              state={readForgeOperationStateV1({
                failure,
                hasRetainedValue: true,
              })}
              about={{
                forgeName: 'GitHub',
                subject: translate(
                  'plugins.github.actions.subject.runs',
                  'runs',
                ),
              }}
              presentation="line"
              asOfMs={status.snapshot?.checkedAtMs ?? null}
              onRetry={() => status.refresh()}
            />
          ) : null}
        </>
      )}
      empty={
        failure !== null ? (
          <ForgeCiStateNotice
            state={readForgeOperationStateV1({
              failure,
              hasRetainedValue: false,
            })}
            about={{
              forgeName: 'GitHub',
              subject: translate('plugins.github.actions.subject.runs', 'runs'),
            }}
            presentation="surface"
            onRetry={() => status.refresh()}
          />
        ) : (
          <SurfaceState
            kind="empty"
            size="line"
            title={
              query.trim() !== '' || scope !== 'all'
                ? translate(
                    'plugins.github.actions.runs.noMatch',
                    'No loaded runs match',
                  )
                : translate(
                    'plugins.github.actions.runs.empty',
                    'No workflow runs yet',
                  )
            }
            description={
              query.trim() !== '' || scope !== 'all'
                ? translate(
                    'plugins.github.actions.runs.noMatch.description',
                    'Clear the filter to see every loaded run.',
                  )
                : branch === null
                  ? translate(
                      'plugins.github.actions.runs.empty.description',
                      'Runs appear here when a workflow starts on GitHub.',
                    )
                  : translate(
                      'plugins.github.actions.runs.empty.branch',
                      'Push {branch} or run a workflow to see it here.',
                      { branch },
                    )
            }
          />
        )
      }
      detailHeader={() => ({
        title:
          runHeader?.title ??
          translate('plugins.github.actions.run', 'Workflow run'),
        ...(runHeader === null ? {} : { subtitle: runHeader.subtitle, leading: runHeader.leading }),
        actions:
          detailLocations === null ? undefined : (
            <DetailsPaneOpenAsPageButton
              testID="github.actions.openAsPage"
              onPress={() =>
                go(
                  detailLocations.fullPageLocation.subPath,
                  detailLocations.fullPageLocation.backLocation,
                )
              }
            />
          ),
      })}
      renderDetail={() =>
        location.kind !== 'run' ? null : (
          <ForgeCiRunDetailView
            ci={ci}
            view={mountedView}
            presentation="pane"
            identity={runHeader === null ? 'body' : 'host'}
            {...(renderJobAction === undefined ? {} : { renderJobAction })}
        deploymentReview={deploymentReview}
            selection={attemptSelection(
              repository,
              location.runId,
              location.attempt,
            )}
            selectedJobId={location.jobId ?? null}
            onOpenJob={(job: ForgeCiJobRefV1) => {
              void go(
                `runs/${location.runId}/attempts/${location.attempt}/jobs/${job.jobId}`,
                `runs/${location.runId}/attempts/${location.attempt}`,
              );
            }}
            onOpenSummary={() => { void go(`runs/${location.runId}/attempts/${location.attempt}`, 'runs'); }}
          />
        )
      }
    />
  );
}
