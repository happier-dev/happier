import * as React from 'react';
import {
  ForgeCiRunDetailView,
  useForgeCiMountedViewV1,
  useForgeCiMountedViewStateV1,
} from '@happier-dev/forge-ci/ui';
import { readForgeCiSelectionRunV1 } from '@happier-dev/forge-ci/runtime';
import {
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import { bindGithubCiMountedViewV1 } from '../../actions/mounted.js';
import type { GithubCheckActionsTargetV1 } from '../../triage/checks.js';
import { useGithubCiBindingV1 } from '../actions/useGithubCiBinding.js';

/**
 * The PR Checks drill-down (lab a8): a check that GitHub Actions ran opens its run in place, with Back to the
 * checks, and its jobs open their step log in the same place. It is the shared run detail and job view, bound to
 * this plugin's one CI binding; the checks list around it stays the PR detail's.
 */
export function GithubChecksRunDrilldown({
  target,
  checksLabel,
  onBack,
  signal,
}: Readonly<{
  target: GithubCheckActionsTargetV1;
  /** Back's words, naming where it returns ("Checks on #2493"). */
  checksLabel: string;
  onBack: () => void;
  signal?: AbortSignal;
}>): React.ReactElement {
  const surface = useSurfaceContext();
  const run = readForgeCiSelectionRunV1(target.selection);
  const ci = useGithubCiBindingV1(run.repository, signal === undefined ? {} : { signal });
  const view = useForgeCiMountedViewV1({
    mountId: surface.mountId,
    initialState: { selection: target.selection },
    ...(signal === undefined ? {} : { signal }),
    canApply: operation => !['selectView', 'selectWorkflow', 'setFilters', 'setRunScope', 'setQuery', 'setTriggerRef', 'setTriggerDraft'].includes(operation.kind)
      && !(operation.kind === 'setJobsView' && operation.view === 'graph'),
    phone: surface.platform === 'ios' || surface.platform === 'android',
  });
  const scope = usePluginUiEphemeralSharedScope();
  React.useEffect(
    () => (scope && view ? bindGithubCiMountedViewV1(scope, view, signal) : undefined),
    [scope, view, signal],
  );
  const state = useForgeCiMountedViewStateV1(view);
  const selection = state?.selection ?? target.selection;
  React.useEffect(() => {
    if (view) void view.invoke({ mountId: view.mountId, operation: { kind: 'selectAttempt', selection: target.selection } });
  }, [target.selection, view]);

  return (
    <ForgeCiRunDetailView
      ci={ci}
      selection={selection}
      presentation="embedded"
      view={view}
      back={{ label: checksLabel, onPress: onBack }}
      selectedJobId={state?.job?.jobId ?? null}
      onOpenJob={job => { void view?.invoke({ mountId: view.mountId, operation: { kind: 'selectJob', job } }); }}
      onOpenSummary={() => view?.openSummary()}
    />
  );
}
