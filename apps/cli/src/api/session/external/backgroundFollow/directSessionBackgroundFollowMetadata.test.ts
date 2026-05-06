import { describe, expect, it } from 'vitest';

import {
    updateMetadataWithDirectSessionBackgroundFollow,
    updateMetadataWithDirectSessionObservedProgress,
    updateSessionMetadataWithDirectSessionBackgroundFollow as updateSessionMetadataWithDirectSessionBackgroundFollowCompat,
} from './directSessionBackgroundFollowMetadata';

describe('directSessionBackgroundFollowMetadata', () => {
    it('keeps the legacy direct-session background-follow metadata updater export aligned with the observed-progress updater', () => {
        expect(typeof updateSessionMetadataWithDirectSessionBackgroundFollowCompat).toBe('function');

        const metadata = {
            directSessionV1: {
                providerId: 'claude',
            },
        } as const;
        const params = {
            observedProgress: {
                token: '123:message_1',
                atMs: 123,
            },
            lastKnownActivityAtMs: 123,
        } as const;

        expect(updateMetadataWithDirectSessionBackgroundFollow(metadata as never, params)).toEqual(
            updateMetadataWithDirectSessionObservedProgress(metadata as never, params),
        );
    });
});
