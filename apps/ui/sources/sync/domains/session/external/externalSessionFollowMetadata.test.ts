import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import {
    readExternalSessionFollowPolicy,
    updateMetadataWithExternalSessionFollowPolicy,
} from './externalSessionFollowMetadata';

function createExternalSessionMetadata(policy?: 'attached_only' | 'background_follow'): Metadata {
    return {
        path: '/tmp',
        host: 'localhost',
        externalSessionV1: {
            v: 1,
            providerId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
            ...(policy ? { followPolicyV1: { v: 1 as const, policy } } : {}),
        },
    } as Metadata;
}

describe('externalSessionFollowMetadata', () => {
    it('defaults to attached_only when no follow policy is present', () => {
        expect(readExternalSessionFollowPolicy(createExternalSessionMetadata())).toBe('attached_only');
    });

    it('reads background_follow from canonical direct-session metadata', () => {
        expect(readExternalSessionFollowPolicy(createExternalSessionMetadata('background_follow'))).toBe('background_follow');
    });

    it('updates the nested direct-session policy without disturbing attention metadata', () => {
        const next = updateMetadataWithExternalSessionFollowPolicy(createExternalSessionMetadata(), {
            policy: 'background_follow',
            updatedAtMs: 42,
        });

        expect((next as any).externalSessionV1).toEqual(expect.objectContaining({
            followPolicyV1: {
                v: 1,
                policy: 'background_follow',
                updatedAtMs: 42,
            },
        }));
    });

    it('is a no-op when the requested policy already matches', () => {
        const metadata = createExternalSessionMetadata('background_follow');
        expect(updateMetadataWithExternalSessionFollowPolicy(metadata, { policy: 'background_follow' })).toBe(metadata);
    });
});
