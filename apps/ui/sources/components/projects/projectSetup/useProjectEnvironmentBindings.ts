import * as React from 'react';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SavedSecretReferenceV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';

import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useProjectAccountRows, useProjectAccountWorkspaceRef } from '@/sync/domains/workspaces/projectAccountRows';

import type { ProjectManifestActionClient } from './projectManifestActionClient';

/** One Project organization row supplies every named task's reference settings and recovery picker. */
export function useProjectEnvironmentBindings(
  workspace: WorkspaceAddressV1,
  binding: ServerCredentialAccountScopeBinding | null,
  client: ProjectManifestActionClient | null,
  signal: AbortSignal,
  enabled = true,
) {
  const ref = useProjectAccountWorkspaceRef(enabled ? workspace.workspaceId : null, workspace.serverId);
  const project = React.useMemo(() => ref ? projectWorkspaceRefV1(ref) : null, [ref]);
  const row = useProjectAccountRows(rows => project && binding
    && areServerAccountScopesEqual(rows?.scope, binding.scope)
    ? rows?.organizations.find(candidate => candidate.key.serverId === project.serverId
      && candidate.key.projectKey === project.projectKey) ?? null : null, enabled);
  const status = useProjectAccountRows(rows => !binding || !areServerAccountScopesEqual(rows?.scope, binding.scope)
    ? 'unavailable' : rows?.status === 'ready' && rows.coverage === 'complete' ? 'ready'
      : rows?.status === 'loading' || rows?.status === 'idle' ? 'loading' : 'unavailable', enabled);
  const scopeKey = JSON.stringify([binding?.accountId, project?.serverId, project?.projectKey]);
  const [mutation, setMutation] = React.useState<Readonly<{ scopeKey: string; signal: AbortSignal; name: string; error: string | null; pending: boolean }> | null>(null);
  const currentMutation = mutation?.scopeKey === scopeKey && mutation.signal === signal ? mutation : null;
  const available = enabled && status === 'ready' && project !== null && client !== null && binding?.isCurrent() === true;

  const update = React.useCallback(async (name: string, reference: SavedSecretReferenceV1 | null) => {
    if (!available || !project || !client || !binding || signal.aborted) return;
    setMutation({ scopeKey, signal, name, error: null, pending: true });
    try {
      const result = await client.updateEnvironmentBinding({
        projectRef: project, expectedRevision: row?.revision ?? 'absent', environmentBinding: { name, reference },
      });
      if (!signal.aborted) setMutation({ scopeKey, signal, name, pending: false, error: result.ok ? null : result.errorCode });
    } catch (error) {
      if (!signal.aborted) setMutation({ scopeKey, signal, name, pending: false,
        error: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'request_failed' });
    }
  }, [available, binding, client, signal, project, row?.revision, scopeKey]);

  const choose = React.useCallback(async (name: string) => {
    if (!available || !binding || signal.aborted) return;
    const selected = row?.value.environmentBindings?.bindings[name];
    const selection = await presentSavedSecretReferencePicker({
      accountLifetime: binding, signal, isCurrent: binding.isCurrent,
      ...(selected?.revision ? { selected: { ref: selected.ref, resourceRevision: selected.revision } } : {}),
    });
    if (selection) await update(name, { ref: selection.ref, revision: selection.resourceRevision });
  }, [available, binding, signal, row?.value.environmentBindings, update]);

  return {
    scope: binding?.scope ?? null,
    bindings: row?.value.environmentBindings?.bindings,
    available, status, pendingName: currentMutation?.pending ? currentMutation.name : null,
    error: currentMutation?.error ? { name: currentMutation.name, code: currentMutation.error } : null,
    choose, remove: (name: string) => update(name, null),
  };
}

export type ProjectEnvironmentBindingsController = ReturnType<typeof useProjectEnvironmentBindings>;

