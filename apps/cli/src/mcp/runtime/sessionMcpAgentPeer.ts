import type { Socket } from 'node:net';

import { ancestorsOf, indexCensus, readProcessCensus } from '@/processes/census/processCensus';
import { observeLocalIpcPeerIdentity, resolveProcessCustodyPeerIdentityExecutable } from '@/subprocess/supervision/processCustody';
import { readSessionAgentTreeRoots } from '@/subprocess/supervision/sessionHolder';

export type SessionMcpAgentPeerCandidate = Readonly<{ holderScope: object; agentUid: number | undefined }>;

/**
 * A Session MCP connection without a Session bearer is admitted only from one Session's Agent tree:
 * the kernel-proven peer (SO_PEERCRED / LOCAL_PEERPID through the process-custody helper) resolves
 * to the one Session (of those sharing a host endpoint) whose Agent tree holds it:
 * the peer runs as that Session's Agent uid and is in the process group of one of its held Agents or
 * descends from one of its holders. The peer and its ancestry are observed once for all candidates.
 * Another Session's Agent (same uid, same host) is that Session, never this one. No candidate, more
 * than one, or anything unprovable (no helper, no census, no live holder) is a refusal.
 */
export async function resolveSessionMcpAgentPeer<T extends SessionMcpAgentPeerCandidate>(
    socket: Socket, candidates: readonly T[],
): Promise<T | null> {
    if (candidates.length === 0) return null;
    const executablePath = resolveProcessCustodyPeerIdentityExecutable(process.platform);
    if (!executablePath) return null;
    const peer = await observeLocalIpcPeerIdentity({ socket, executablePath }).catch(() => null);
    if (!peer) return null;
    const sameUid = candidates.filter(candidate => candidate.agentUid === peer.uid);
    if (sameUid.length === 0) return null;
    const census = await readProcessCensus({ freshness: 'fresh', scope: 'all', pids: [peer.pid], includeAncestors: true, fields: [] })
        .catch(() => null);
    if (census?.status !== 'ok') return null;
    const index = indexCensus(census.rows);
    const row = index.byPid.get(peer.pid);
    if (!row) return null;
    const ancestors = ancestorsOf(index, peer.pid);
    const matches = sameUid.filter(candidate => {
        const { holderPids, agentPids } = readSessionAgentTreeRoots(candidate.holderScope);
        if (holderPids.length === 0 && agentPids.length === 0) return false;
        if (row.pgid !== undefined && agentPids.includes(row.pgid)) return true;
        return ancestors.some(ancestor => holderPids.includes(ancestor.pid) || agentPids.includes(ancestor.pid));
    });
    return matches.length === 1 ? matches[0]! : null;
}
