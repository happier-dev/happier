import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { useManagedWorkspaceForget } from '@/components/settings/machines/managed/useManagedWorkspaceForget';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { workspaceScopeFromProject } from '@/sync/domains/workspaces/workspaceScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useEventCallback } from '@/hooks/ui/useEventCallback';

import { resolveWorkspaceRefDisplayName } from '../resolveWorkspaceRefDisplayName';

/**
 * The Project page "…" row that forgets the attached workspace this checkout lives in (lab `project-more`,
 * `project-forget`; owner decision 4). Forget retires the attachment, so its confirmation names every Project on that
 * workspace and says the workspace and its files stay. Null for a checkout on a Machine, or before the attached resource
 * is read.
 */
export function useForgetAttachedWorkspaceAction(
  workspaceRef: WorkspaceRefV1 | null,
): PageHeaderMenuAction | null {
  const managed =
    workspaceRef && isManagedWorkspaceRefV2(workspaceRef) ? workspaceRef : null;
  const scope = React.useMemo(
    () =>
      managed ? workspaceScopeFromProject(managed, managed.rootPath) : NO_SCOPE,
    [managed],
  );
  const forget = useManagedWorkspaceForget(scope);
  const [pending, setPending] = React.useState(false);
  const workspaceName = forget?.workspaceName ?? null;
  const run = forget?.forget;
  // Stable across renders: the menu list keeps its identity while the attached resource is unchanged.
  const onSelect = useEventCallback(() => {
    if (!managed || !workspaceName || !run) return;
    // Every Project with a checkout on this workspace stops opening (decision 4), each named once.
    const projects = new Map<string, string>();
    for (const ref of readProjectWorkspaceRefs(getStorage().getState())) {
      if (
        !isManagedWorkspaceRefV2(ref) ||
        ref.managedId !== managed.managedId ||
        !areServerProfileIdentifiersEquivalent(ref.serverId, managed.serverId)
      )
        continue;
      const key = projectWorkspaceRefV1(ref).projectKey;
      if (!projects.has(key))
        projects.set(key, resolveWorkspaceRefDisplayName(ref));
    }
    if (projects.size === 0)
      projects.set('', resolveWorkspaceRefDisplayName(managed));
    const names = [...projects.values()];
    fireAndForget(
      (async () => {
        const confirmed = await Modal.confirm(
          t('projects.checkouts.forgetTitle', { workspace: workspaceName }),
          undefined,
          {
            messageParagraphs: [
              `${t('projects.checkouts.forgetProjects', { projects: names.join(', '), count: names.length })} ${t('projects.checkouts.forgetStays')}`,
              t('projects.checkouts.forgetHelper', {
                workspace: workspaceName,
              }),
            ],
            confirmText: t('projects.checkouts.forgetConfirm', {
              workspace: workspaceName,
            }),
          },
        );
        if (!confirmed) return;
        setPending(true);
        try {
          if ((await run()) === 'failed')
            Modal.alert(t('common.requestFailed'));
        } finally {
          setPending(false);
        }
      })(),
      { tag: 'project.forgetAttachedWorkspace' },
    );
  });
  return React.useMemo(
    () =>
      workspaceName
        ? {
            id: 'forgetWorkspace',
            title: t('projects.checkouts.forgetWorkspace', {
              workspace: workspaceName,
            }),
            testID: 'project-shell-header.forgetWorkspace',
            loading: pending,
            onSelect,
          }
        : null,
    [onSelect, pending, workspaceName],
  );
}

const NO_SCOPE = { serverId: '', machineId: '', rootPath: '' } as const;
