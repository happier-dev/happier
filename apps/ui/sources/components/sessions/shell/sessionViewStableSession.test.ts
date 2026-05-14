import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';

import { buildSessionViewShellSessionSignature } from './sessionViewStableSession';

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        seq: 25,
        createdAt: 1,
        updatedAt: 100,
        active: true,
        activeAt: 100,
        thinking: true,
        thinkingAt: 100,
        presence: 'online',
        accessLevel: 'edit',
        canApprovePermissions: true,
        pendingVersion: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        latestUsage: {
            inputTokens: 1,
            outputTokens: 2,
        },
        metadata: {
            name: 'Session',
            path: '/repo',
            homeDir: '/Users/leeroy',
            host: 'mac',
            machineId: 'machine-1',
            flavor: 'codex',
            version: '0.0.0',
        },
        agentState: {},
        ...overrides,
    } as Session;
}

describe('buildSessionViewShellSessionSignature', () => {
    it('stays stable for timestamp-only session heartbeats', () => {
        const base = createSession();
        const heartbeat = createSession({
            updatedAt: 200,
            activeAt: 200,
            thinkingAt: 200,
            latestUsage: {
                inputTokens: 2,
                outputTokens: 4,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 8,
                timestamp: 200,
            },
        });

        expect(buildSessionViewShellSessionSignature(heartbeat)).toBe(buildSessionViewShellSessionSignature(base));
    });

    it('stays stable for transcript seq-only streaming updates after transcript history exists', () => {
        const base = createSession({ seq: 25 });
        const nextToken = createSession({ seq: 26 });

        expect(buildSessionViewShellSessionSignature(nextToken)).toBe(buildSessionViewShellSessionSignature(base));
    });

    it('changes when the session first gains transcript history', () => {
        const empty = createSession({ seq: 0 });
        const firstRecord = createSession({ seq: 1 });

        expect(buildSessionViewShellSessionSignature(firstRecord)).not.toBe(
            buildSessionViewShellSessionSignature(empty),
        );
    });

    it('stays stable for read-cursor-only updates while viewing the session', () => {
        const base = createSession({
            lastViewedSessionSeq: 25,
            metadata: {
                name: 'Session',
                path: '/repo',
                homeDir: '/Users/leeroy',
                host: 'mac',
                machineId: 'machine-1',
                flavor: 'codex',
                version: '0.0.0',
                readStateV1: {
                    v: 1,
                    sessionSeq: 25,
                    pendingActivityAt: 0,
                    updatedAt: 100,
                },
            },
        });
        const readCursorHeartbeat = createSession({
            lastViewedSessionSeq: 26,
            metadataVersion: 2,
            metadata: {
                name: 'Session',
                path: '/repo',
                homeDir: '/Users/leeroy',
                host: 'mac',
                machineId: 'machine-1',
                flavor: 'codex',
                version: '0.0.0',
                readStateV1: {
                    v: 1,
                    sessionSeq: 26,
                    pendingActivityAt: 0,
                    updatedAt: 200,
                },
            },
        });

        expect(buildSessionViewShellSessionSignature(readCursorHeartbeat)).toBe(
            buildSessionViewShellSessionSignature(base),
        );
    });

    it('changes when shell-visible session data changes', () => {
        const base = createSession();
        const renamed = createSession({
            metadata: {
                ...base.metadata,
                path: base.metadata?.path ?? '/repo',
                host: base.metadata?.host ?? 'mac',
                name: 'Renamed',
            },
        });

        expect(buildSessionViewShellSessionSignature(renamed)).not.toBe(buildSessionViewShellSessionSignature(base));
    });
});
