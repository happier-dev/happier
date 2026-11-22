import * as React from 'react';

import { SurfaceStateCard, type SurfaceStateSize } from '@/components/ui/surfaces/SurfaceStateCard';
import { useManagedWorkspaceStart } from '@/components/settings/machines/managed/useManagedWorkspaceStart';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

/** The managed refusal code a stopped provider resource returns (protocol `managedRefusalCodeV1`). */
export const MANAGED_POWER_REQUIRED = 'managed_power_required';

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
  const wasPending = React.useRef(pending);
  const onStarted = React.useRef(props.onStarted);
  onStarted.current = props.onStarted;
  React.useEffect(() => {
    // The power operation settled: read again rather than guessing the workspace's state.
    if (wasPending.current && !pending) onStarted.current?.();
    wasPending.current = pending;
  }, [pending]);
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
      size={props.size}
      testID={props.testID}
      action={
        offeredBeside
          ? null
          : start?.reviewApproval
          ? { label: t('approvals.details'), onPress: start.reviewApproval }
          : start && !pending
            ? {
                label: t('managedMachines.actions.start'),
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
  }>,
) {
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
      reason={props.size === 'line' ? undefined : props.reason}
      size={props.size}
      action={props.action ?? undefined}
    />
  );
}
