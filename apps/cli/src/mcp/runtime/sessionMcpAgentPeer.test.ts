import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import { runAddedHostedSession, readHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { trackSessionManagedProcess } from '@/subprocess/supervision/sessionHolder';

const osBoundary = vi.hoisted(() => ({
    peer: null as null | { uid: number; pid: number },
    rows: [] as Array<{ pid: number; ppid: number | null; pgid?: number }>,
}));

// The kernel peer observation (process-custody helper) and the /proc census are the OS boundary.
// Session Agent-tree roots, candidate selection and the ambiguity rule are real.
vi.mock('@/subprocess/supervision/processCustody', async importOriginal => ({
    ...await importOriginal<typeof import('@/subprocess/supervision/processCustody')>(),
    resolveProcessCustodyPeerIdentityExecutable: () => '/fixture/process-custody',
    observeLocalIpcPeerIdentity: async () => osBoundary.peer,
}));
vi.mock('@/processes/census/processCensus', async importOriginal => ({
    ...await importOriginal<typeof import('@/processes/census/processCensus')>(),
    readProcessCensus: async () => ({ status: 'ok', rows: osBoundary.rows }),
}));

import { resolveSessionMcpAgentPeer } from './sessionMcpAgentPeer';

/** A Session whose Agent tree is rooted at `pid` (a managed process it owns), as the host records it. */
function sessionRootedAt(pid: number, agentUid: number) {
    return runAddedHostedSession({ environment: {}, workingDirectory: '/', end: () => {} }, () => {
        trackSessionManagedProcess(Object.assign(new EventEmitter(), { pid }));
        return { holderScope: readHostedSessionScope()!, agentUid };
    });
}

describe('Session MCP peer resolution on a shared host endpoint', () => {
    const socket = {} as Socket;
    const a = sessionRootedAt(100, 1000);
    const b = sessionRootedAt(200, 1000);
    const isolatedOther = sessionRootedAt(300, 2402);

    it('resolves a peer in exactly one Session\'s Agent tree to that Session only', async () => {
        osBoundary.peer = { uid: 1000, pid: 101 };
        osBoundary.rows = [{ pid: 101, ppid: 100 }, { pid: 100, ppid: 1 }];
        expect(await resolveSessionMcpAgentPeer(socket, [a, b, isolatedOther])).toBe(a);
    });

    it('refuses a peer running as another Account\'s isolated uid, even inside a Session tree of that host', async () => {
        osBoundary.peer = { uid: 2402, pid: 101 };
        osBoundary.rows = [{ pid: 101, ppid: 100 }, { pid: 100, ppid: 1 }];
        expect(await resolveSessionMcpAgentPeer(socket, [a, b, isolatedOther])).toBeNull();
        osBoundary.peer = { uid: 1000, pid: 301 };
        osBoundary.rows = [{ pid: 301, ppid: 300 }, { pid: 300, ppid: 1 }];
        expect(await resolveSessionMcpAgentPeer(socket, [a, b, isolatedOther])).toBeNull();
    });

    it('refuses a peer that two Sessions\' trees would both claim, and one in no tree', async () => {
        osBoundary.peer = { uid: 1000, pid: 101 };
        osBoundary.rows = [{ pid: 101, ppid: 100, pgid: 200 }, { pid: 100, ppid: 1 }];
        expect(await resolveSessionMcpAgentPeer(socket, [a, b])).toBeNull();
        osBoundary.rows = [{ pid: 101, ppid: 1 }];
        expect(await resolveSessionMcpAgentPeer(socket, [a, b])).toBeNull();
    });
});
