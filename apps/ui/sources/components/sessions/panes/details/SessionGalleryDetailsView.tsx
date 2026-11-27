import * as React from 'react';

import type { GalleryDetailsResource } from '@/components/appShell/panes/details/galleryDetailsTab';
import { useSessionMachineName } from '@/components/sessions/agents/presentation/useSessionMachineName';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { FolderGalleryView } from '@/components/workspaces/files/gallery/FolderGalleryView';
import { SessionMediaGalleryView } from '@/components/workspaces/files/gallery/SessionMediaGalleryView';
import { RepositoryTreeRootErrorState } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRootErrorState';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import { useRepositoryTreeBrowserState } from '@/hooks/workspaces/files/repositoryTreeBrowserState';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { useSessionDirectoryKind } from '@/sync/domains/state/storage';
import { t } from '@/text';

/**
 * A gallery in the Session's Details pane (lab pr974 SG2): the same body as the Files pane's, with more columns.
 * Opening a folder inside it replaces this tab with that folder's gallery.
 */
export function SessionGalleryDetailsView(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    resource: GalleryDetailsResource;
    onNavigate: (path: string) => void;
    onOpenFile: (path: string) => void;
  }>,
) {
  const target = useSessionWorkspaceTarget(props.sessionId, props.serverId);
  const scope = React.useMemo(
    () =>
      target
        ? {
            serverId: target.serverId,
            machineId: target.machineId,
            rootPath: target.rootPath,
          }
        : null,
    [target?.serverId, target?.machineId, target?.rootPath],
  );
  const { machineRpcTargetAvailable } = useSessionMachineReachability(
    props.sessionId,
    props.serverId,
  );
  const machineName = useSessionMachineName(props.sessionId, props.serverId);
  const managed =
    useSessionDirectoryKind(props.sessionId, props.serverId) === 'managed';
  const { setView, revealPath } = useRepositoryTreeBrowserState(
    scope ? (tryBuildWorkspaceCacheKey(scope) ?? '') : '',
  );
  // Show as list: the Files pane returns to its list with this folder revealed.
  const showAsList = React.useCallback(
    (path: string) => {
      setView('list');
      if (path) revealPath(path, { focus: true });
    },
    [revealPath, setView],
  );
  if ('scope' in props.resource) {
    return (
      <SessionMediaGalleryView
        sessionId={props.sessionId}
        serverId={props.serverId}
        presentation="tab"
        onOpenFile={props.onOpenFile}
      />
    );
  }
  if (!scope)
    return (
      <RepositoryTreeRootErrorState
        kind="unavailable"
        machineName={machineName}
      />
    );
  return (
    <FolderGalleryView
      scope={scope}
      folderPath={props.resource.path}
      rootLabel={
        managed ? t('session.folderless.sessionFiles') : t('files.projectRoot')
      }
      online={machineRpcTargetAvailable}
      presentation="tab"
      machineName={machineName}
      onNavigate={props.onNavigate}
      onShowAsList={showAsList}
      onOpenFile={props.onOpenFile}
      targetSession={
        scope.serverId
          ? { sessionId: props.sessionId, serverId: scope.serverId }
          : null
      }
    />
  );
}
