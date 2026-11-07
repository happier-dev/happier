import * as React from 'react';
import {
  ForgeCiRailPanel,
  ForgeCiRunDetailView,
  useForgeCiMountedViewV1,
  useForgeCiMountedViewStateV1,
  useForgeCiQueryStatusV1,
  useForgeCiQueryV1,
  useForgeCiQueryValueV1,
  type ForgeCiRailContextV1,
} from '@happier-dev/forge-ci/ui';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Stack,
  usePluginHostApi,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import type {
  ForgeCiJobRefV1,
  ForgeCiSelectionV1,
} from '@happier-dev/triage-protocol/ci/v1';
import { bindGithubCiMountedViewV1 } from '../../../actions/mounted.js';
import { GITHUB_PLUGIN_ID } from '../../../observations/githubProviderContracts.js';
import { useGithubCiBindingV1 } from '../../actions/useGithubCiBinding.js';
import { GITHUB_ACTIONS_PAGE_ID_V1 } from '../surfaceIds.js';

type Opened = Readonly<{
  selection: ForgeCiSelectionV1;
  job: ForgeCiJobRefV1 | null;
}>;

/**
 * The Session rail's CI tab (lab a6), bound to this plugin's one CI binding: runs for the Session's exact HEAD and
 * branch, and a run or job opened in place with Back to the list. The Session target supplies the accepted branch
 * and HEAD; without them the panel says so rather than showing another commit's result.
 */
export function GithubSessionCiPanel({
  context,
}: Readonly<{ context: RenderContext }>): React.ReactElement {
  const t = usePluginTranslation();
  const host = usePluginHostApi();
  const target = context.surface.target;
  const repository =
    target.kind === 'session' && target.repository?.kind === 'github'
      ? target.repository
      : null;
  const ci = useGithubCiBindingV1(repository, { signal: context.signal });
  const rail: ForgeCiRailContextV1 =
    target.kind !== 'session' ||
    !repository ||
    !target.branch ||
    !target.headOid
      ? { kind: 'unknown' }
      : { kind: 'ready', branch: target.branch, headSha: target.headOid };
  const ready = rail.kind === 'ready' && repository !== null ? rail : null;
  const headLease = useForgeCiQueryV1(
    ci.reads,
    'listRuns',
    ready && repository
      ? {
          repository,
          filters: { branch: ready.branch, headSha: ready.headSha },
        }
      : null,
  );
  const branchLease = useForgeCiQueryV1(
    ci.reads,
    'listRuns',
    ready && repository
      ? { repository, filters: { branch: ready.branch } }
      : null,
  );
  const workflowsLease = useForgeCiQueryV1(
    ci.reads,
    'listWorkflows',
    repository ? { repository } : null,
  );
  const head = useForgeCiQueryValueV1(headLease);
  const branch = useForgeCiQueryValueV1(branchLease);
  const workflows = useForgeCiQueryValueV1(workflowsLease);
  const headStatus = useForgeCiQueryStatusV1(headLease);
  const workflowNames = React.useMemo(
    () =>
      new Map(
        (workflows?.rows ?? []).map((workflow) => [workflow.id, workflow.name]),
      ),
    [workflows],
  );

  const surface = useSurfaceContext();
  const view = useForgeCiMountedViewV1({
    mountId: surface.mountId,
    signal: context.signal,
    canApply: operation => !['selectView', 'selectWorkflow', 'setFilters', 'setRunScope', 'setQuery', 'setTriggerRef', 'setTriggerDraft'].includes(operation.kind)
      && !(operation.kind === 'setJobsView' && operation.view === 'graph'),
    phone:
      context.surface.platform === 'ios' ||
      context.surface.platform === 'android',
  });
  const scope = usePluginUiEphemeralSharedScope();
  React.useEffect(
    () => (scope && view ? bindGithubCiMountedViewV1(scope, view, context.signal) : undefined),
    [scope, view, context.signal],
  );
  const state = useForgeCiMountedViewStateV1(view);
  const opened: Opened | null = state?.selection ? { selection: state.selection, job: state.job } : null;
  const open = async (selection: ForgeCiSelectionV1, job?: ForgeCiJobRefV1) => {
    if (!view) return;
    await view.invoke({ mountId: view.mountId, operation: { kind: 'selectAttempt', selection } });
    if (job) await view.invoke({ mountId: view.mountId, operation: { kind: 'selectJob', job } });
  };
  const back = {
    label: t('plugins.github.ci.rail.back', 'CI'),
    onPress: () => view?.closeSelection(),
  };

  if (opened) {
    return (
      <ForgeCiRunDetailView ci={ci} selection={opened.selection} presentation="pane" back={back} view={view}
        selectedJobId={opened.job?.jobId ?? null}
        onOpenJob={job => { void open(opened.selection, job); }}
        onOpenSummary={() => view?.openSummary()} />
    );
  }
  return (
    <Stack gap="none">
      <ForgeCiRailPanel
        ci={ci}
        context={rail}
        headRuns={head?.rows ?? null}
        branchRuns={branch?.rows ?? null}
        failure={headStatus.snapshot?.failure ?? null}
        checkedAtMs={headStatus.snapshot?.checkedAtMs ?? null}
        onRetry={() => {
          void headStatus.refresh();
        }}
        onOpenRun={(selection, job) =>
          void open(selection, job)
        }
        onOpenActions={() => {
          void host.openSurface({
            pluginId: GITHUB_PLUGIN_ID,
            localId: GITHUB_ACTIONS_PAGE_ID_V1,
          });
        }}
        workflowNames={workflowNames}
      />
    </Stack>
  );
}
