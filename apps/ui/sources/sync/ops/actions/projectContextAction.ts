import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { updatePersonalProjectContextV1 } from '@happier-dev/protocol/projects/projectContextV1';
import { canUsePrivateProjectAccountAction, createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { createUiPromptLibraryArtifactStore, withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Bind private context semantics to the captured Account's real row and Artifact owners. */
export function createUiProjectContextAction(account: LazyActionAccountContext | undefined): NonNullable<ActionExecutorDeps['projectsContextUpdate']> {
  const rows = account ? createUiProjectAccountRowsClient(account) : null;
  const artifacts = account ? createUiPromptLibraryArtifactStore(account.workflowArtifacts) : null;
  return async (input, context) => {
    if (!account || !rows || !artifacts || !canUsePrivateProjectAccountAction(account, context)) {
      return { ok: false, errorCode: 'project_context_access_denied' };
    }
    return updatePersonalProjectContextV1({
      accountScope: () => {
        try { account.assertCurrent(); return { serverId: account.serverId, accountId: account.accountId }; }
        catch { return null; }
      },
      readArtifact: async (ref, options) => {
        if (!ref.serverId || areServerProfileIdentifiersEquivalent(ref.serverId, account.serverId)) {
          return artifacts.read(ref.artifactId, options);
        }
        // A delegated Home credential must never borrow the device user's
        // credentials on another Home. Ordinary user reads use the canonical
        // qualified reader, which captures that Home's own actual authority.
        if (account.credentialAuthorityKind === 'api_token' || context?.externalActionCredential || context?.externalActionExecutionAuthorization) return null;
        return withUiPromptLibraryArtifactReader(reader => reader.readArtifact(ref), {
          serverId: account.serverId, signal: options?.signal,
        });
      },
      mutateOrganization: rows.mutateOrganization,
    }, input, context);
  };
}
