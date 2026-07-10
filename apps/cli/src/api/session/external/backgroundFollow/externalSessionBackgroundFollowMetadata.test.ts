import { describe, expect, it } from 'vitest';

import {
    updateMetadataWithExternalSessionBackgroundFollow,
    updateMetadataWithExternalSessionObservedProgress,
    updateSessionMetadataWithExternalSessionBackgroundFollow as updateSessionMetadataWithExternalSessionBackgroundFollowCompat,
} from './externalSessionBackgroundFollowMetadata';

describe('externalSessionBackgroundFollowMetadata', () => {
    it('keeps the legacy direct-session background-follow metadata updater export aligned with the observed-progress updater', () => {
        expect(typeof updateSessionMetadataWithExternalSessionBackgroundFollowCompat).toBe('function');

        const metadata = {
            externalSessionV1: {
                agentId: 'claude',
            },
        } as const;
        const params = {
            observedProgress: {
                token: '123:message_1',
                atMs: 123,
            },
            lastKnownActivityAtMs: 123,
        } as const;

        expect(updateMetadataWithExternalSessionBackgroundFollow(metadata as never, params)).toEqual(
            updateMetadataWithExternalSessionObservedProgress(metadata as never, params),
        );
    });
});
