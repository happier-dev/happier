import type { Socket } from 'node:net';

import { ancestorsOf, indexCensus, readProcessCensus } from '@/processes/census/processCensus';
import { observeLocalIpcPeerIdentity, resolveProcessCustodyPeerIdentityExecutable } from '@/subprocess/supervision/processCustody';
import { readSessionAgentTreeRoots } from '@/subprocess/supervision/sessionHolder';

/**
 * A Session MCP relay is admitted only from that Session's Agent tree: the kernel-proven peer
 * (SO_PEERCRED / LOCAL_PEERPID through the process-custody helper) runs as the Session's Agent
 * uid and is in the process group of one of the Session's held Agents, or descends from one of
 * its holders. Another Session's Agent (same uid, same host) holding a copied bearer is refused.
 * Anything unprovable (no helper, no census, no live holder) is refused.
 */
export function createSessionMcpAgentPeerAdmission(input: Readonly<{ holderScope: object; agentUid: number }>): (socket: Socket) => Promise<boolean> {
    return async (socket) => {
        const executablePath = resolveProcessCustodyPeerIdentityExecutable(process.platform);
        if (!executablePath) return false;
        const peer = await observeLocalIpcPeerIdentity({ socket, executablePath }).catch(() => null);
        if (!peer || peer.uid !== input.agentUid) return false;
        const { holderPids, agentPids } = readSessionAgentTreeRoots(input.holderScope);
        if (holderPids.length === 0 && agentPids.length === 0) return false;
        const census = await readProcessCensus({ freshness: 'fresh', scope: 'all', pids: [peer.pid], includeAncestors: true, fields: [] })
            .catch(() => null);
        if (census?.status !== 'ok') return false;
        const index = indexCensus(census.rows);
        const row = index.byPid.get(peer.pid);
        if (!row) return false;
        if (row.pgid !== undefined && agentPids.includes(row.pgid)) return true;
        return ancestorsOf(index, peer.pid).some(ancestor => holderPids.includes(ancestor.pid) || agentPids.includes(ancestor.pid));
    };
}
