import * as React from 'react';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import type { ForgeCiReadsV1 } from '@happier-dev/forge-ci/runtime';
import {
  useForgeCiQueryV1, useForgeCiQueryValueV1, useForgeCiQueryStatusV1,
  readForgeOperationStateV1, presentForgeCiStatusV1, ForgeCiStateNotice,
  type ForgeCiBindingV1, type ForgeCiMountedViewV1,
} from '@happier-dev/forge-ci/ui';
import {
  CheckStatusGlyph, Collection, Icon, LoadingState, Row, SurfaceState, Text,
  useHappierCollection, useSurfaceContext, type CollectionAnatomy,
} from '@happier-dev/plugin-ui';
import type { ForgeCiRunV1, ForgeCiWorkflowV1 } from '@happier-dev/triage-protocol/ci/v1';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';
import { replaceGithubActionsLocationV1, type GithubActionsLocationV1 } from '../../actions/model.js';
import type { GithubLocalRunOpenV1 } from './localRun.js';
import { latestGithubRunByWorkflowV1, matchesGithubWorkflowV1 } from './runGroups.js';
import { GithubWorkflowDetail } from './WorkflowDetail.js';

type Translate = (key: string, fallback: string, values?: Readonly<Record<string, string | number>>) => string;
type HeaderRender = React.ComponentProps<typeof Collection>['header'];
type QueryStatus = ReturnType<typeof useForgeCiQueryStatusV1>;
type Go = (subPath: string, backLocation: string) => ReturnType<typeof replaceGithubActionsLocationV1>;

export function WorkflowsCollection({
  repository,
  reads,
  ci,
  mountedView,
  branch,
  localRun,
  translate,
  workflows,
  runs,
  status,
  location,
  go,
  query,
  onQueryChange,
  runRequest,
  onRunRequestHandled,
  header,
  minListWidth,
  minDetailWidth,
}: Readonly<{
  repository: ScmHostingRepositoryIdentityV1;
  reads: ForgeCiReadsV1 | null;
  ci: ForgeCiBindingV1;
  mountedView: ForgeCiMountedViewV1 | null;
  branch: string | null;
  localRun: GithubLocalRunOpenV1 | null;
  translate: Translate;
  workflows: readonly ForgeCiWorkflowV1[] | null;
  runs: readonly ForgeCiRunV1[];
  status: QueryStatus;
  location: GithubActionsLocationV1;
  go: Go;
  query: string;
  onQueryChange: (value: string) => void;
  /** Run workflow chose this workflow: its page opens on its form once its definition says it can start by hand. */
  runRequest: string | null;
  onRunRequestHandled: () => void;
  header: HeaderRender;
  minListWidth: number;
  minDetailWidth: number;
}>): React.ReactElement {
  const latest = React.useMemo(() => latestGithubRunByWorkflowV1(runs), [runs]);
  const selectedId = location.kind === 'workflow' ? location.workflowId : null;
  const listedSelection = workflows?.find(workflow => workflow.id === selectedId);
  // A location identifies a workflow independently of the list's current page.
  // Reuse an admitted row; only a missing selected row needs the exact reader.
  const selectedQuery = useForgeCiQueryV1(reads, 'readWorkflow',
    selectedId !== null && listedSelection === undefined && (workflows !== null || status.snapshot?.failure)
      ? { repository, workflowId: selectedId } : null);
  const selectedWorkflow = useForgeCiQueryValueV1(selectedQuery);
  const selectedStatus = useForgeCiQueryStatusV1(selectedQuery);
  const workflowForKey = (key: string) => workflows?.find(workflow => workflow.id === key)
    ?? (selectedWorkflow?.id === key ? selectedWorkflow : undefined);
  const { locale } = useSurfaceContext();
  // Read once per mount, like the runs list's ages; the list is not a clock.
  const [mountedAtMs] = React.useState(() => Date.now());
  const anatomy = React.useMemo<CollectionAnatomy<ForgeCiWorkflowV1>>(
    () => ({
      glyph: () => <Icon name="workflow" tone="neutral" />,
      title: (workflow) => workflow.name,
      // The file is a designation, not a fact the list reads: the table's title line carries it, and the workflow
      // pane names it. As end-aligned list meta it squeezed every title on a phone (lab a3p drops it).
      titleSuffix: (workflow) =>
        workflow.path === undefined ? null : (
          <Text variant="code" tone="secondary" numberOfLines={1} value={workflow.path.split('/').pop() ?? workflow.path} />
        ),
      byline: (workflow) => {
        if (workflow.nativeState !== 'active')
          return translate('plugins.github.actions.workflow.off', 'Turned off');
        const run = latest.get(workflow.id);
        if (run === undefined)
          return translate(
            'plugins.github.actions.workflow.noRecent',
            'No recent runs',
          );
        // How it last went (lab a3 "Failed · 2 days ago", "Running on main"), not the last run's title again.
        const status = presentForgeCiStatusV1(run.state);
        const at = run.completedAtMs ?? run.createdAtMs ?? run.startedAtMs;
        const word = translate(status.wordKey, status.word);
        const line =
          status.kind === 'running' && run.headRef !== undefined
            ? translate('plugins.github.actions.workflow.runningOn', '{state} on {branch}', { state: word, branch: run.headRef })
            : at === undefined
              ? word
              : `${word} · ${formatTriageTimestampV1(locale, at, 'relative', mountedAtMs)}`;
        return (
          <Row gap="xsmall" align="center">
            <CheckStatusGlyph status={status.kind} size={14} />
            <Text variant="meta" tone="secondary" value={line} />
          </Row>
        );
      },
      accessibilityLabel: (workflow) => workflow.name,
      testID: (workflow) => `github.actions.workflow.${workflow.id}`,
      columnTitles: {
        title: translate('plugins.github.actions.workflows.column', 'Workflow'),
      },
    }),
    [latest, translate, locale, mountedAtMs],
  );
  const groups = React.useMemo(
    () => [
      {
        key: 'active',
        title: translate(
          'plugins.github.actions.workflows.group.active',
          'Workflows',
        ),
      },
      {
        key: 'off',
        title: translate(
          'plugins.github.actions.workflows.group.off',
          'Turned off',
        ),
      },
    ],
    [translate],
  );
  const filter = React.useCallback((workflow: ForgeCiWorkflowV1) => matchesGithubWorkflowV1(workflow, query), [query]);
  const model = useHappierCollection({
    items: workflows ?? [],
    keyOf: (workflow) => workflow.id,
    filter,
    // One list while every workflow is on: a lone "Workflows" heading would repeat the lens. Turned-off workflows
    // split the list into two groups.
    ...(workflows?.some((workflow) => workflow.nativeState !== 'active') === true
      ? {
          groups: {
            axis: groups,
            groupOf: (workflow: ForgeCiWorkflowV1) =>
              workflow.nativeState === 'active' ? 'active' : 'off',
          },
        }
      : {}),
    openKey: location.kind === 'workflow' ? location.workflowId : null,
    onOpenChange: (key) => {
      void go(
        key === null ? 'workflows' : `workflows/${key}`,
        key === null ? '' : 'workflows',
      );
    },
  });
  const failure = status.snapshot?.failure ?? null;
  return (
    <Collection
      testID="github.actions.workflows"
      accessibilityLabel={translate(
        'plugins.github.actions.workflows.label',
        'Workflows',
      )}
      model={model}
      anatomy={anatomy}
      presentation="list"
      detail="auto"
      scroll="page"
      pageRoot
      search={{
        label: translate('plugins.github.actions.search.workflows', 'Filter workflows'),
        placeholder: translate('plugins.github.actions.search.workflows', 'Filter workflows'),
        width: 'fixed',
        value: query,
        onValueChange: onQueryChange,
      }}
      minListWidth={minListWidth}
      minDetailWidth={minDetailWidth}
      preferredListRatio={0.5}
      loading={workflows === null && failure === null}
      header={(slots) => (
        <>
          {typeof header === 'function' ? header(slots) : header}
          {failure !== null && workflows !== null ? (
            <ForgeCiStateNotice
              state={readForgeOperationStateV1({
                failure,
                hasRetainedValue: true,
              })}
              about={{
                forgeName: 'GitHub',
                subject: translate(
                  'plugins.github.actions.subject.workflows',
                  'workflows',
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
              subject: translate(
                'plugins.github.actions.subject.workflows',
                'workflows',
              ),
            }}
            presentation="surface"
            onRetry={() => status.refresh()}
          />
        ) : (
          <SurfaceState
            kind="empty"
            size="line"
            title={query.trim() !== ''
              ? translate('plugins.github.actions.workflows.noMatch', 'No workflows match')
              : translate('plugins.github.actions.workflows.empty', 'No workflows in this repository')}
            description={query.trim() !== ''
              ? translate('plugins.github.actions.workflows.noMatch.description', 'Clear the filter to see every workflow.')
              : translate('plugins.github.actions.workflows.empty.description', 'Add a workflow file under .github/workflows to see it here.')}
          />
        )
      }
      detailHeader={(key) => {
        const workflow = workflowForKey(key);
        return {
          title:
            workflow?.name ??
            translate('plugins.github.actions.workflow', 'Workflow'),
          ...(workflow?.path === undefined ? {} : { subtitle: workflow.path }),
        };
      }}
      renderDetail={(key) => {
        const workflow = workflowForKey(key);
        return workflow === undefined ? selectedStatus.snapshot?.failure ? (
          <ForgeCiStateNotice presentation="surface" about={{ forgeName: 'GitHub', subject: translate('plugins.github.actions.workflow', 'Workflow') }}
            state={readForgeOperationStateV1({ failure: selectedStatus.snapshot.failure, hasRetainedValue: false })}
            onRetry={selectedStatus.refresh} />
        ) : <LoadingState title={translate('plugins.github.actions.workflow.loading', 'Loading workflow')} rows={3} layout="line" /> : (
          <GithubWorkflowDetail
            key={workflow.id}
            repository={repository}
            ci={ci}
            view={mountedView}
            branch={branch}
            localRun={localRun}
            workflow={workflow}
            translate={translate}
            openRunForm={runRequest === workflow.id}
            onRunFormHandled={onRunRequestHandled}
            onOpenRun={(run) => {
              void go(
                `runs/${run.ref.runId}/attempts/${run.currentAttempt?.attemptId ?? '1'}`,
                `workflows/${workflow.id}`,
              );
            }}
            onRunStarted={(runId) => {
              // A dispatch starts a new run, whose first attempt is 1.
              void go(`runs/${runId}/attempts/1`, `workflows/${workflow.id}`);
            }}
          />
        );
      }}
    />
  );
}
