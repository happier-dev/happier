import { describe, expect, it } from 'vitest';

import { getSessionStorageKind } from './sessionStorageKind';

const canonicalLinkedSession = {
    v: 1,
    agentId: 'claude',
    machineId: 'machine-1',
    remoteSessionId: 'remote-1',
    source: {
        kind: 'claudeConfig',
        configDir: '/tmp/claude',
        projectId: 'project-1',
    },
} as const;

const { agentId: releasedAgentId, ...releasedLinkFields } = canonicalLinkedSession;
const releasedLinkedSession = { ...releasedLinkFields, providerId: releasedAgentId } as const;

describe('getSessionStorageKind', () => {
    it('classifies canonical and supported legacy external-session metadata through the same reader', () => {
        expect(getSessionStorageKind({
            metadata: {
                externalSessionV1: canonicalLinkedSession,
            },
        })).toBe('direct');

        expect(getSessionStorageKind({
            metadata: {
                directSessionV1: releasedLinkedSession,
            },
        })).toBe('direct');
    });

    it('rejects malformed external-session-shaped metadata', () => {
        expect(getSessionStorageKind({
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                },
            },
        })).toBe('persisted');
    });
});
