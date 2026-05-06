import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import {
    readDirectSessionFollowPolicy,
    updateMetadataWithDirectSessionFollowPolicy,
} from './directSessionFollowMetadata';

function createDirectSessionMetadata(policy?: 'attached_only' | 'background_follow'): Metadata {
    return {
        path: '/tmp',
        host: 'localhost',
        directSessionV1: {
            v: 1,
            providerId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
            ...(policy ? { followPolicyV1: { v: 1 as const, policy } } : {}),
        },
    } as Metadata;
}

describe('directSessionFollowMetadata', () => {
    it('defaults to attached_only when no follow policy is present', () => {
        expect(readDirectSessionFollowPolicy(createDirectSessionMetadata())).toBe('attached_only');
    });

    it('reads background_follow from canonical direct-session metadata', () => {
        expect(readDirectSessionFollowPolicy(createDirectSessionMetadata('background_follow'))).toBe('background_follow');
    });

    it('updates the nested direct-session policy without disturbing attention metadata', () => {
        const next = updateMetadataWithDirectSessionFollowPolicy(createDirectSessionMetadata(), {
            policy: 'background_follow',
            updatedAtMs: 42,
        });

        expect((next as any).directSessionV1).toEqual(expect.objectContaining({
            followPolicyV1: {
                v: 1,
                policy: 'background_follow',
                updatedAtMs: 42,
            },
        }));
    });

    it('is a no-op when the requested policy already matches', () => {
        const metadata = createDirectSessionMetadata('background_follow');
        expect(updateMetadataWithDirectSessionFollowPolicy(metadata, { policy: 'background_follow' })).toBe(metadata);
    });
});
