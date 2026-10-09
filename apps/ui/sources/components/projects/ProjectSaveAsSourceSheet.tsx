import * as React from 'react';

import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';

import { ProjectSourceDetail } from './sources/ProjectSourceDetail';
import type { ProjectsListModel } from './useProjectsListModel';

type SaveAsSourceHost = Pick<
  ProjectsListModel,
  | 'saveAsSource'
  | 'saveSourceCreation'
  | 'dismissSourceCreation'
  | 'sourceCreation'
  | 'teamName'
  | 'newSessionHere'
>;
type SaveResult = Awaited<ReturnType<ProjectsListModel['saveSourceCreation']>>;

type SaveAsSourceModalProps = CustomModalInjectedProps &
  Readonly<{
    controller: ProjectsListModel['sourceCreation']['controller'];
    serverId: string;
    accountId: string;
    teamName: ProjectsListModel['teamName'];
    /** Records the accepted checkout on the Source the editor just created. */
    settle: () => Promise<SaveResult>;
    discard: () => void;
  }>;

/**
 * "Save as a source" (lab p-projects TREE row menu): the existing new-Source editor, prefilled from
 * this checkout, in a sheet. Its Save creates the Source through the Source controller; the sheet then
 * records this checkout as that Source's checkout. A refused link keeps the created Source and says so.
 */
function ProjectSaveAsSourceModal(props: SaveAsSourceModalProps) {
  const { controller, settle, discard, onClose } = props;
  const state = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const homeName = resolveHomeDisplayLabel(
    getServerProfileById(props.serverId),
    props.serverId,
  );
  const onCreated = React.useCallback(() => {
    void settle().then((result) => {
      onClose();
      if (
        result.kind === 'provenance_not_saved' ||
        result.kind === 'unavailable'
      ) {
        Modal.alert(
          t('projects.identity.sourceSavedNotLinkedTitle'),
          t('projects.identity.sourceSavedNotLinkedBody'),
        );
      }
    });
  }, [onClose, settle]);
  return (
    <ProjectSourceDetail
      state={state}
      controller={controller}
      accountId={props.accountId}
      homeName={homeName}
      teamName={props.teamName}
      creating
      onCreated={onCreated}
      onDiscardCreate={() => {
        discard();
        onClose();
      }}
      onOpen={() => {}}
      onOpenCheckout={() => {}}
      onDeleted={onClose}
    />
  );
}

/**
 * The row menu's "New session here" and "Save as a source" for every Projects entrance, settled
 * visibly: the session opens or one line says it could not; Save as a source opens its editor.
 */
export function useProjectRowCreationActions(host: SaveAsSourceHost) {
  const {
    saveAsSource,
    saveSourceCreation,
    dismissSourceCreation,
    sourceCreation,
    teamName,
    newSessionHere,
  } = host;
  const accountScope = useActiveServerAccountScope();
  const newSession = React.useCallback(
    (ref: WorkspaceRefV1) => {
      const outcome = newSessionHere(ref);
      if (outcome.kind === 'opened' || outcome.kind === 'stale') return;
      Modal.alert(t('projects.identity.newSessionUnavailable'));
    },
    [newSessionHere],
  );
  const saveSource = React.useCallback(
    async (ref: WorkspaceRefV1) => {
      const result = await saveAsSource(ref);
      if (result.kind === 'editing') {
        Modal.show({
          component: ProjectSaveAsSourceModal,
          props: {
            controller: sourceCreation.controller,
            serverId: ref.serverId,
            accountId: accountScope?.accountId ?? '',
            teamName,
            settle: saveSourceCreation,
            discard: dismissSourceCreation,
          },
          chrome: {
            kind: 'card',
            header: 'none',
            material: 'solid',
            title: t('projects.identity.saveAsSource'),
            testID: 'projects-save-as-source',
            scrollHost: 'body',
            bodyScroll: 'none',
            dimensions: { width: 640, maxHeightRatio: 0.86, size: 'lg' },
            phonePresentation: 'sheet',
          },
          onRequestClose: dismissSourceCreation,
        });
        return;
      }
      if (
        result.kind === 'not_saved' ||
        result.kind === 'unavailable' ||
        result.kind === 'missing' ||
        result.kind === 'ambiguous' ||
        result.kind === 'invalid'
      ) {
        Modal.alert(t('projects.identity.saveAsSourceUnavailable'));
      }
    },
    [
      accountScope?.accountId,
      dismissSourceCreation,
      saveAsSource,
      saveSourceCreation,
      sourceCreation.controller,
      teamName,
    ],
  );
  return { newSession, saveSource };
}
