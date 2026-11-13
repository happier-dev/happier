import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import type { TriageActionV1 } from '../settings/actions.js';
import type { TriageForgeIdentityV1 } from './launchPlacement.js';

/** One workspace decision for handoff admission and its recipient presentation. */
export function evaluateTriageExistingSessionWorkspaceV1(
    workspaceMode: TriageActionV1['workspaceMode'],
    repository: TriageForgeIdentityV1 | undefined,
    accepted: SessionStateV1['acceptedWorkspace'],
): Readonly<{ kind: 'referenceOnly' }>
    | Readonly<{ kind: 'workspace'; workspace: NonNullable<SessionStateV1['acceptedWorkspace']> }>
    | Readonly<{ kind: 'unavailable'; reason: 'existing_session_workspace_missing' | 'repositoryMismatch' }> {
    if (workspaceMode === 'reference_only') return { kind: 'referenceOnly' };
    if (accepted === undefined) return { kind: 'unavailable', reason: 'existing_session_workspace_missing' };
    // An unbound entry uses the workspace explicitly chosen by the person.
    if (repository !== undefined && (accepted.repository === undefined
        || !sameScmHostingRepositoryIdentity(repository, accepted.repository))) return { kind: 'unavailable', reason: 'repositoryMismatch' };
    return { kind: 'workspace', workspace: accepted };
}
