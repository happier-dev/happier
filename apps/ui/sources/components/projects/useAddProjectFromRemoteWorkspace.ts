import * as React from 'react';

import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { AttachRemoteWorkspaceOutcome } from '@/components/settings/machines/managed/attachableRemoteWorkspaceActions';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import type { ManagedWorkspacePreparationOutcome } from '@/components/ui/pathBrowser/ManagedWorkspacePreparation';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';

import { seedAndOpenProjectDraft } from './activation/projectOpenDraftSeed';
import { useNavigateToProjectOpen } from './activation/projectOpenPresentation';

/** Where the chooser starts when the attached record names no guest home. */
const GUEST_ROOT = '/';

export type AddProjectFromRemoteWorkspaceInput = Readonly<{
  /** The workspace or host name, for the chooser's copy. */
  name: string;
  controllerMachineId: string;
  /** The attach that gives the workspace access; the chooser runs it first and browses what it settles to. */
  attach(
    input: Readonly<{
      signal: AbortSignal;
      onApprovalPending(registration: ActionApprovalRegistration): void;
    }>,
  ): Promise<AttachRemoteWorkspaceOutcome>;
  /** The unsupported-platform next step. */
  onSetUpAsMachine?: () => void;
}>;

/**
 * A folder in an attached workspace (remote workspaces F1, F6): the chooser prepares access, the person picks the
 * folder in the guest, and the Open page saves the Project there. The Projects "+" and Remote Hosts share it.
 */
export function useAddProjectFromRemoteWorkspace() {
  const activeServer = useActiveServerSnapshot();
  const navigateToOpen = useNavigateToProjectOpen();
  return React.useCallback(
    async (input: AddProjectFromRemoteWorkspaceInput) => {
      const serverId = String(activeServer.serverId ?? '').trim();
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (
        !serverId ||
        !lifetime?.isCurrent() ||
        lifetime.scope.serverId !== serverId
      )
        return;
      const picked = await openMachinePathBrowserModal({
        title: t('files.pane.serverFolderTitle'),
        controllerMachineId: input.controllerMachineId,
        prepare: {
          name: input.name,
          serverId,
          onSetUpAsMachine: input.onSetUpAsMachine,
          run: async (request): Promise<ManagedWorkspacePreparationOutcome> => {
            const outcome = await input.attach(request);
            return outcome.kind === 'attached'
              ? {
                  kind: 'ready',
                  workspace: {
                    serverId,
                    managedId: outcome.managedId,
                    controller: outcome.controller,
                    rootPath: outcome.home ?? GUEST_ROOT,
                  },
                }
              : outcome;
          },
        },
      });
      if (!picked || !lifetime.isCurrent()) return;
      const { managedId, controller } = picked.workspace;
      await seedAndOpenProjectDraft({
        lifetime,
        selection: {
          serverId,
          machineId: controller.machineId,
          source: { kind: 'folder', path: picked.path },
          materialization: {
            kind: 'attach',
            targetManaged: { managedId, controller },
          },
        },
        navigate: navigateToOpen,
      });
    },
    [activeServer.serverId, navigateToOpen],
  );
}
