import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';

type MountedProfileDraft = Readonly<{
    scope: ServerAccountScope;
    profileId: string;
    revision: number | 'absent';
    artifactRevision?: ArtifactRevisionV1;
    draftId: string;
    isCurrent(): boolean;
    discard(): boolean | Promise<boolean>;
}>;

// These are mounted editor closures, not copies of their draft or Account state.
const mountedDrafts = new Set<MountedProfileDraft>();

export function registerMountedProfileDraft(target: MountedProfileDraft): () => void {
    mountedDrafts.add(target);
    return () => { mountedDrafts.delete(target); };
}

export async function discardMountedProfileDraft(scope: ServerAccountScope, draftId: string) {
    for (const target of [...mountedDrafts].reverse()) {
        if (target.draftId !== draftId || !areServerAccountScopesEqual(target.scope, scope) || !target.isCurrent()) continue;
        return await target.discard()
            ? { status: 'discarded' as const, draftId }
            : { status: 'unavailable' as const, reason: 'profile_editor_not_mounted' };
    }
    return { status: 'unavailable' as const, reason: 'profile_editor_not_mounted' };
}
