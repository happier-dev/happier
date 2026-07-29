import { afterEach, describe, expect, it } from 'vitest';

import {
    clearMountedSessionRealtimeTranscriptConsumers,
    readMountedSessionRealtimeTranscriptConsumerSessionIds,
    readMountedSessionTranscriptConsumerSessionIdsForRetention,
    registerSessionRealtimeTranscriptConsumer,
    registerSessionTranscriptRetentionConsumer,
    subscribeSessionTranscriptConsumerReleases,
} from './sessionRealtimeTranscriptConsumers';

describe('sessionRealtimeTranscriptConsumers retention holds', () => {
    afterEach(() => {
        clearMountedSessionRealtimeTranscriptConsumers();
    });

    it('excludes retention-only holds from realtime routing reads but includes them for retention', () => {
        const unregister = registerSessionTranscriptRetentionConsumer('s-retained');

        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds()).toEqual([]);
        expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual(['s-retained']);

        unregister();
        expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual([]);
    });

    it('counts realtime consumers as retention holds too', () => {
        const unregister = registerSessionRealtimeTranscriptConsumer('s-realtime');

        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds()).toEqual(['s-realtime']);
        expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual(['s-realtime']);

        unregister();
        expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual([]);
    });

    it('keeps the retention hold while any consumer for the session remains mounted', () => {
        const first = registerSessionTranscriptRetentionConsumer('s-shared');
        const second = registerSessionTranscriptRetentionConsumer('s-shared');

        first();
        expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual(['s-shared']);

        second();
        expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual([]);
    });

    it('notifies release subscribers when a consumer unregisters', () => {
        const released: string[] = [];
        const unsubscribe = subscribeSessionTranscriptConsumerReleases((sessionId) => {
            released.push(sessionId);
        });

        const unregisterRetention = registerSessionTranscriptRetentionConsumer('s-a');
        const unregisterRealtime = registerSessionRealtimeTranscriptConsumer('s-b');
        expect(released).toEqual([]);

        unregisterRetention();
        expect(released).toEqual(['s-a']);

        unregisterRealtime();
        expect(released).toEqual(['s-a', 's-b']);

        // Unregistering twice must not double-notify.
        unregisterRetention();
        expect(released).toEqual(['s-a', 's-b']);

        unsubscribe();
        registerSessionTranscriptRetentionConsumer('s-c')();
        expect(released).toEqual(['s-a', 's-b']);
    });

    it('ignores blank session ids for retention holds', () => {
        const unregister = registerSessionTranscriptRetentionConsumer('   ');
        expect(readMountedSessionTranscriptConsumerSessionIdsForRetention()).toEqual([]);
        unregister();
    });
});
