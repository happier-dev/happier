import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storageStore';
import {
    clearMountedSessionRealtimeTranscriptConsumers,
    readMountedSessionRealtimeTranscriptConsumerSessionIds,
} from '@/sync/runtime/sessionRealtimeTranscriptConsumers';

import { useSessionRealtimeTranscriptConsumer } from './useSessionRealtimeTranscriptConsumer';

const initialStorageState = storage.getInitialState();

function buildSession(sessionId: string, serverId: string): Session {
    return {
        id: sessionId,
        seq: 1,
        createdAt: 1_000,
        updatedAt: 1_000,
        active: true,
        activeAt: 1_000,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        encryptionMode: 'plain',
        serverId,
    };
}

describe('useSessionRealtimeTranscriptConsumer', () => {
    afterEach(() => {
        clearMountedSessionRealtimeTranscriptConsumers();
        storage.setState(initialStorageState, true);
        standardCleanup();
    });

    it('rebinds a pre-hydration consumer to the hydrated session server id', async () => {
        const sessionId = 'shared-session';
        const hook = await renderHook(() => useSessionRealtimeTranscriptConsumer(sessionId));

        try {
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('server-a')).toEqual([]);
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('server-b')).toEqual([]);

            await act(async () => {
                storage.getState().applySessions([buildSession(sessionId, 'server-b')]);
            });

            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('server-a')).toEqual([]);
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('server-b')).toEqual([sessionId]);
        } finally {
            await hook.unmount();
        }

        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('server-b')).toEqual([]);
    });
});
