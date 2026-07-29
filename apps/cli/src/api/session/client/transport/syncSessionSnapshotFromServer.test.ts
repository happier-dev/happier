import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

const mocks = vi.hoisted(() => ({
    fetchSessionSnapshotUpdateFromServer: vi.fn(),
}));

vi.mock('../../snapshotSync', () => ({
    fetchSessionSnapshotUpdateFromServer: mocks.fetchSessionSnapshotUpdateFromServer,
}));

import { syncSessionSnapshotFromServer } from './syncSessionSnapshotFromServer';

describe('syncSessionSnapshotFromServer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('passes and atomically persists the authoritative metadata layout revision', async () => {
        const metadata = createTestMetadata({ path: '' });
        const metadataTuple = {
            metadataLayoutVersion: 1,
            metadata,
            metadataVersion: 1,
            ownerMetadata: { v: 1, metadata: {} },
            ownerMetadataCiphertext: 'owner-ciphertext',
            agentState: null,
            agentStateVersion: 1,
        };
        mocks.fetchSessionSnapshotUpdateFromServer.mockResolvedValueOnce({
            metadataLayoutVersion: 1,
            metadataTuple,
        });
        const setMetadataSnapshot = vi.fn();
        const setAgentStateSnapshot = vi.fn();
        const setMetadataEnvelopeTupleSnapshot = vi.fn();

        await expect(syncSessionSnapshotFromServer({
            token: 'token',
            sessionId: 'session',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            currentMetadataLayoutVersion: 0,
            currentMetadataVersion: 9,
            currentAgentStateVersion: 8,
            currentMetadata: createTestMetadata({ path: '/private' }),
            currentAgentState: { controlledByUser: true },
            sessionConnectionSupervisor: null,
            isClosed: () => false,
            setMetadataSnapshot,
            setAgentStateSnapshot,
            setMetadataEnvelopeTupleSnapshot,
            applyPendingQueueState: vi.fn(),
            applyLatestTurnStatus: vi.fn(),
            reason: 'connect',
        })).resolves.toBe(true);

        expect(mocks.fetchSessionSnapshotUpdateFromServer).toHaveBeenCalledWith(
            expect.objectContaining({
                currentMetadataLayoutVersion: 0,
                currentMetadataVersion: 9,
                currentAgentStateVersion: 8,
            }),
        );
        expect(setMetadataEnvelopeTupleSnapshot).toHaveBeenCalledWith(metadataTuple);
        expect(setMetadataSnapshot).not.toHaveBeenCalled();
        expect(setAgentStateSnapshot).not.toHaveBeenCalled();
    });
});
