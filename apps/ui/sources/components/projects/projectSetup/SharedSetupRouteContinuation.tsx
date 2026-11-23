import * as React from 'react';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationParamsSelector } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useServerScopedMachine } from '@/sync/store/hooks';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';

import {
  openProjectSharedSetupUpdate,
  type ProjectSharedSetupUpdateInput,
} from './ProjectSharedSetupUpdateSheet';
import { PROJECT_USE_SHARED_SETUP_PARAM } from './sharedSetupRoute';

const selectRequestedSource = (
  params: Readonly<Record<string, string | string[] | undefined>>,
): string | null => {
  const value = params[PROJECT_USE_SHARED_SETUP_PARAM];
  return typeof value === 'string' && value.trim() ? value : null;
};
const selectMachineName = (machine: Machine | null) =>
  machine ? getMachineSentenceName(machine) : null;

/**
 * "Use for this project" lands here (plan A §7 L6 import): the Scripts page of the checkout the person
 * chose opens the same shared-setup review the pending row uses, once, and clears the request. The
 * review's own Action reads the Source; nothing runs until the person decides in it.
 */
export function SharedSetupRouteContinuation(
  props: Readonly<{
    workspace: WorkspaceAddressV1;
    binding: ServerCredentialAccountScopeBinding | null;
    /** The checkout's definition is read, so the review opens over a settled page. */
    ready: boolean;
    decide: ProjectSharedSetupUpdateInput['decide'];
  }>,
): null {
  const router = useRouter();
  const sourceId = useDestinationParamsSelector(selectRequestedSource);
  const source = useProjectSource(sourceId ? props.binding : null, sourceId);
  const machineName =
    useServerScopedMachine(
      props.workspace.serverId,
      props.workspace.machineId,
      selectMachineName,
    ) ?? props.workspace.machineId;
  const sourceName = source.source?.source.name ?? null;
  const { workspace, binding, ready, decide } = props;
  React.useEffect(() => {
    if (!sourceId || !ready || !binding?.isCurrent()) return;
    router.setParams({ [PROJECT_USE_SHARED_SETUP_PARAM]: undefined });
    openProjectSharedSetupUpdate({
      workspace,
      binding,
      sourceId,
      sourceName,
      machineName,
      decide,
      pending: true,
    });
    // The request is consumed once; a later Source name or Machine label does not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, ready, binding]);
  return null;
}
