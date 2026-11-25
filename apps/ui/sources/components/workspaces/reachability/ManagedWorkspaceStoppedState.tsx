import * as React from 'react';

import { SurfaceStateCard, type SurfaceStateSize } from '@/components/ui/surfaces/SurfaceStateCard';
import { useManagedWorkspaceStart } from '@/components/settings/machines/managed/useManagedWorkspaceStart';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

const StartOfferedBeside = React.createContext(false);

/**
 * Declares that this subtree sits beside a page that already says its workspace is stopped, with Start (the Code page
 * beside its Git pane): the line here names the state and Starting, and leaves the one Start to that page.
 */
export function ManagedWorkspaceStartOfferedBeside(props: Readonly<{ offered?: boolean; children: React.ReactNode }>) {
  return <StartOfferedBeside.Provider value={props.offered !== false}>{props.children}</StartOfferedBeside.Provider>;
}

/**
 * A stopped attached workspace, wherever its contents were asked for (Files, Git): it names the workspace and
 * its one next step (lab project-stoppedCold). Stopped → Starting → `onStarted` reads again; Start shows only
 * when the managed owner lets this person start it.
 */
export function ManagedWorkspaceStoppedState(
  props: Readonly<{
    workspaceName: string | null;
    /** What starting it gives back, in the surface's words ("Start it to see its files."). */
    reason: string;
    workspaceScope: WorkspaceScopeBase | null;
    onStarted?: () => void;
    /** `line` over rows a surface kept (lab project-stopped): the name and Start, without the reason. */
    size?: SurfaceStateSize;
    testID: string;
  }>,
) {
  return props.workspaceScope?.workspace ? (
    <StartableWorkspaceStoppedState
      {...props}
      workspaceScope={props.workspaceScope}
    />
  ) : (
    <WorkspaceStoppedState {...props} action={null} />
  );
}

function StartableWorkspaceStoppedState(
  props: Readonly<{
    workspaceName: string | null;
    reason: string;
    workspaceScope: WorkspaceScopeBase;
    onStarted?: () => void;
    size?: SurfaceStateSize;
    testID: string;
  }>,
) {
  const start = useManagedWorkspaceStart(props.workspaceScope);
  const offeredBeside = React.useContext(StartOfferedBeside);
  const pending = start?.pending === true;
  const failure = start?.failure ?? null;
  const wasPending = React.useRef(pending);
  const onStarted = React.useRef(props.onStarted);
  onStarted.current = props.onStarted;
  React.useEffect(() => {
    // Re-read after a completed wake. A refusal stays in this stopped row.
    if (wasPending.current && !pending && !failure) onStarted.current?.();
    wasPending.current = pending;
  }, [pending, failure]);
  if (pending && props.workspaceName) {
    return (
      <SurfaceStateCard
        testID={props.testID}
        kind="loading"
        size={props.size}
        title={t('files.pane.managedStartingTitle', {
          workspace: props.workspaceName,
        })}
      />
    );
  }
  return (
    <WorkspaceStoppedState
      workspaceName={props.workspaceName}
      reason={props.reason}
      failure={failure}
      size={props.size}
      testID={props.testID}
      action={
        offeredBeside
          ? null
          : start?.reviewApproval
          ? { label: t('approvals.details'), onPress: start.reviewApproval }
          : start && !pending
            ? {
                label: t(failure ? 'common.retry' : 'managedMachines.actions.start'),
                onPress: start.start,
              }
            : null
      }
    />
  );
}

function WorkspaceStoppedState(
  props: Readonly<{
    workspaceName: string | null;
    reason: string;
    size?: SurfaceStateSize;
    testID: string;
    action: Readonly<{ label: string; onPress: () => void }> | null;
    failure?: NonNullable<ReturnType<typeof useManagedWorkspaceStart>>['failure'];
  }>,
) {
  const { failure } = props;
  const failureReason = failure
    ? resolveActionExecutionFailureMessage({ ...failure, ok: false, errorCode: failure.code }, t('common.requestFailed'))
    : null;
  return (
    <SurfaceStateCard
      testID={props.testID}
      kind="unavailable"
      iconName="stop-circle"
      title={
        props.workspaceName
          ? t('files.pane.managedStoppedTitle', {
              workspace: props.workspaceName,
            })
          : t('files.pane.rootErrorTitleUnnamed')
      }
      reason={failureReason ?? (props.size === 'line' ? undefined : props.reason)}
      diagnosticCode={failure?.code}
      size={props.size}
      action={props.action ?? undefined}
    />
  );
}
