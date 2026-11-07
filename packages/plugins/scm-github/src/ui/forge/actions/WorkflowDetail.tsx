import * as React from 'react';
import {
  ForgeCiRunWorkflowForm,
  ForgeCiStateNotice,
  type ForgeCiBindingV1,
  readForgeOperationStateV1,
  useForgeCiQueryStatusV1,
  useForgeCiPagedQueryV1,
  useForgeCiQueryValueV1,
  useForgeCiRunWorkflowV1,
  useForgeCiMountedViewStateV1,
  useForgeCiMutationV1,
  type ForgeCiMountedViewV1,
} from '@happier-dev/forge-ci/ui';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import {
  Button,
  Collection,
  Row,
  Icon,
  Item,
  ItemGroup,
  Stack,
  SurfaceState,
  Text,
  Toggle,
  usePluginHostApi,
} from '@happier-dev/plugin-ui';
import type {
  ForgeCiRunV1,
  ForgeCiWorkflowV1,
} from '@happier-dev/triage-protocol/ci/v1';
import { useGithubRunsCollectionV1 } from './runsCollectionModel.js';
import { GITHUB_ACTIONS_RUNS_PAGE_SIZE_V1 } from './runGroups.js';
import type { GithubLocalRunOpenV1 } from './localRun.js';

type Translate = (
  key: string,
  fallback: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

/** Readable minima for the workflow's runs inside the details pane; it never splits again. */
const NESTED_MIN_WIDTH = 320;

/**
 * The selected workflow (lab a3 `wf`, plan 02 D-21): what it is for, whether it is on, its file, then its runs
 * through the same runs Collection as the Runs view, filtered by this workflow. Only the selected workflow's runs
 * are read (provider paging, window honesty from the shared model); the workflow list itself reads no history.
 */
export function GithubWorkflowDetail({
  repository,
  ci,
  view,
  branch,
  localRun,
  workflow,
  translate,
  onOpenRun,
  onRunStarted,
  openRunForm,
  onRunFormHandled,
}: Readonly<{
  repository: ScmHostingRepositoryIdentityV1;
  ci: ForgeCiBindingV1;
  view: ForgeCiMountedViewV1 | null;
  /** The Project's current branch; the run form opens on it and lets the person pick another ref. */
  branch: string | null;
  localRun: GithubLocalRunOpenV1 | null;
  workflow: ForgeCiWorkflowV1;
  translate: Translate;
  /** Opening a run hands it to the page's run location (pane on desktop, pushed on a phone). */
  onOpenRun: (run: ForgeCiRunV1) => void;
  /** GitHub returned the exact run this dispatch started; never a guessed run. */
  onRunStarted: (runId: string) => void;
  /** The person pressed Run workflow and chose this workflow: open its form as soon as its definition allows. */
  openRunForm?: boolean;
  onRunFormHandled?: () => void;
}>): React.ReactElement {
  const host = usePluginHostApi();
  const reads = ci.reads;
  const mounted = useForgeCiMountedViewStateV1(view);
  const running = mounted?.triggerFormOpen === true;
  const setRunning = (open: boolean) => { void view?.invoke({ mountId: view.mountId, operation: { kind: 'setTriggerFormOpen', open } }); };
  const trigger = useForgeCiRunWorkflowV1({ ci, repository, workflowId: workflow.id, initialRef: branch ?? '',
    formOpen: running, view, enabled: workflow.nativeState === 'active',
    onStarted: runId => { setRunning(false); onRunStarted(runId); } });
  const definition = trigger.current;
  React.useEffect(() => {
    if (!openRunForm || !definition) return;
    // A workflow that only runs on events keeps the page as it is, whose triggers line says when it runs.
    if (definition.dispatchable === true) setRunning(true);
    onRunFormHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `setRunning` is this render's invoke on the same view.
  }, [openRunForm, definition, onRunFormHandled]);
  const runsLease = useForgeCiPagedQueryV1(reads, 'listRuns', {
    repository,
    workflowId: workflow.id,
    filters: {},
    pageSize: GITHUB_ACTIONS_RUNS_PAGE_SIZE_V1,
  });
  const runs = useForgeCiQueryValueV1(runsLease);
  const runsStatus = useForgeCiQueryStatusV1(runsLease);
  const workflowNames = React.useMemo(
    () => new Map([[workflow.id, workflow.name]]),
    [workflow.id, workflow.name],
  );
  const rowsById = React.useMemo(
    () =>
      new Map(
        (runs?.rows ?? []).map((run) => [
          `${run.ref.runId}/${run.currentAttempt?.attemptId ?? '1'}`,
          run,
        ]),
      ),
    [runs],
  );
  const onOpenChange = React.useCallback(
    (key: string | null) => {
      const run = key === null ? undefined : rowsById.get(key);
      if (run !== undefined) onOpenRun(run);
    },
    [rowsById, onOpenRun],
  );
  const runsBusy = runsStatus.snapshot?.pending === true;
  const more = React.useMemo(
    () => (runsLease === null ? null : { loadMore: () => runsLease.loadMore(), busy: runsBusy }),
    [runsLease, runsBusy],
  );
  const { anatomy, model } = useGithubRunsCollectionV1({
    page: runs,
    translate,
    workflowNames,
    openKey: null,
    onOpenChange,
    more,
  });
  const on = workflow.nativeState === 'active';
  const toggle = useForgeCiMutationV1(ci);
  const failure = runsStatus.snapshot?.failure ?? null;
  const fileUrl = workflow.webUrl ?? null;
  const about = {
    forgeName: 'GitHub',
    subject: translate('plugins.github.actions.subject.runs', 'runs'),
  };
  const dispatchable = on && trigger.current?.dispatchable === true;
  return (
    <Stack gap="large">
      {workflow.description === undefined ? null : (
        <Text value={workflow.description} tone="secondary" />
      )}
        <ForgeCiRunWorkflowForm
          ci={ci}
          repository={repository}
          workflowId={workflow.id}
          initialRef={branch ?? ''}
          controller={trigger}
          open={running}
          onStarted={onRunStarted}
          onCancel={() => setRunning(false)}
          testID={`github.actions.workflow.${workflow.id}.run`}
        />
      {trigger.current?.triggers?.length ? <Text tone="secondary" value={trigger.current.triggers.join(', ')} /> : null}
      {running ? null : (
        <Row gap="small" align="center" wrap>
          {dispatchable ? (
            <Button variant="primary" icon={<Icon name="workflow" />}
              title={translate('plugins.github.actions.runWorkflow', 'Run workflow')}
              onPress={() => setRunning(true)} />
          ) : null}
          {localRun === null ? null : (
            <Button variant="secondary"
              title={translate('plugins.github.actions.runLocally', 'Run locally')}
              onPress={() => localRun(workflow.path === undefined ? {} : { workflowPath: workflow.path })} />
          )}
        </Row>
      )}
      <ItemGroup
        title={translate('plugins.github.actions.workflow.status', 'Status')}
      >
        <Item
          title={
            on
              ? translate('plugins.github.actions.workflow.on', 'Turned on')
              : translate('plugins.github.actions.workflow.off', 'Turned off')
          }
          subtitle={
            on
              ? translate(
                  'plugins.github.actions.workflow.on.description',
                  'Its triggers and Run start runs.',
                )
              : translate(
                  'plugins.github.actions.workflow.off.description',
                  'Nothing starts it until you turn it back on.',
                )
          }
          accessory={
            <Toggle
              label={translate(
                'plugins.github.actions.workflow.status',
                'Status',
              )}
              value={on}
              disabled={toggle.state.pending !== null}
              onChange={() => {
                void toggle
                  .run(on ? 'disableWorkflow' : 'enableWorkflow', { repository, workflowId: workflow.id });
              }}
            />
          }
        />
      </ItemGroup>
      {workflow.path === undefined ? null : (
        <ItemGroup
          title={translate('plugins.github.actions.workflow.file', 'File')}
        >
          <Item
            title={workflow.path}
            titleEllipsizeMode="middle"
            icon={<Icon name="file" tone="neutral" />}
            {...(fileUrl === null
              ? {}
              : {
                  accessory: <Icon name="external" tone="neutral" />,
                  onPress: () => {
                    void host.openExternalLink(fileUrl);
                  },
                })}
          />
        </ItemGroup>
      )}
      <Collection
        testID={`github.actions.workflow.${workflow.id}.runs`}
        accessibilityLabel={translate(
          'plugins.github.actions.workflow.recent',
          'Recent runs',
        )}
        title={translate(
          'plugins.github.actions.workflow.recent',
          'Recent runs',
        )}
        model={model}
        anatomy={anatomy}
        presentation="list"
        detail="none"
        scroll="page"
        minListWidth={NESTED_MIN_WIDTH}
        minDetailWidth={NESTED_MIN_WIDTH}
        preferredListRatio={1}
        loading={runs === null && failure === null}
        header={
          failure !== null && runs !== null ? (
            <ForgeCiStateNotice
              state={readForgeOperationStateV1({
                failure,
                hasRetainedValue: true,
              })}
              about={about}
              presentation="line"
              asOfMs={runsStatus.snapshot?.checkedAtMs ?? null}
              onRetry={() => runsStatus.refresh()}
            />
          ) : undefined
        }
        empty={
          failure !== null ? (
            <ForgeCiStateNotice
              state={readForgeOperationStateV1({
                failure,
                hasRetainedValue: false,
              })}
              about={about}
              presentation="surface"
              onRetry={() => runsStatus.refresh()}
            />
          ) : (
            <SurfaceState
              kind="empty"
              size="line"
              title={translate(
                'plugins.github.actions.workflow.recent.none',
                'This workflow hasn’t run yet.',
              )}
            />
          )
        }
      />
    </Stack>
  );
}
