import type { GitWorkingSnapshot } from '@happier-dev/protocol';

export type GitRemoteTarget = {
    remote: string;
    branch: string | null;
};

function parseUpstream(upstream: string | null | undefined): GitRemoteTarget | null {
    if (!upstream) return null;
    const slashIndex = upstream.indexOf('/');
    if (slashIndex <= 0 || slashIndex === upstream.length - 1) {
        return null;
    }
    return {
        remote: upstream.slice(0, slashIndex),
        branch: upstream.slice(slashIndex + 1),
    };
}

export function inferRemoteTargetFromSnapshot(
    snapshot: GitWorkingSnapshot | null | undefined
): GitRemoteTarget {
    const fromUpstream = parseUpstream(snapshot?.branch.upstream);
    if (fromUpstream) {
        return fromUpstream;
    }
    return {
        remote: 'origin',
        branch: snapshot?.branch.head ?? null,
    };
}

