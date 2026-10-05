import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { normalizeScmRemoteRequest, parseScmUpstreamRef } from '@happier-dev/protocol/scm';

export type ScmRemoteSelection = {
    remote: string;
    branch: string | null;
};

export function inferRemoteTargetFromSnapshot(
    snapshot: ScmWorkingSnapshot | null | undefined
): ScmRemoteSelection {
    return scmUiBackendRegistry.getPluginForSnapshot(snapshot ?? null).inferRemoteTarget(snapshot ?? null);
}

export function resolvePublishRemoteFromSnapshot(snapshot: ScmWorkingSnapshot | null | undefined): string | null {
    const remotes = snapshot?.repo.remotes ?? [];
    if (remotes.length === 0) return null;
    const inferredRemote = inferRemoteTargetFromSnapshot(snapshot).remote.trim();
    if (inferredRemote && remotes.some((remote) => remote.name === inferredRemote)) {
        return inferredRemote;
    }
    const origin = remotes.find((remote) => remote.name === 'origin');
    return (origin ?? remotes[0])?.name ?? null;
}

/** A rewrite can target only the remote ref whose object identity this snapshot actually observed. */
export function resolveForceWithLeaseTarget(snapshot: ScmWorkingSnapshot | null | undefined) {
    if (!snapshot?.repo.isRepo || snapshot.branch.detached) return null;
    const target = parseScmUpstreamRef(snapshot.branch.upstream);
    if (!target || !snapshot.branch.upstreamOid) return null;
    const normalized = normalizeScmRemoteRequest({
        ...target, branch: target.branch ?? undefined, pushMode: 'force_with_lease', expectedRemoteOid: snapshot.branch.upstreamOid,
    });
    if (!normalized.ok) return null;
    return { ...target, pushMode: 'force_with_lease' as const, expectedRemoteOid: snapshot.branch.upstreamOid };
}
