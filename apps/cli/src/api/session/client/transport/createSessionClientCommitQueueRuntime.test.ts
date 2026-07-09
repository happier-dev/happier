import { describe, expect, it, vi } from 'vitest';

import {
    createSessionClientCommitQueueRuntime,
    isDefinitiveSessionMessageCommitError,
} from './createSessionClientCommitQueueRuntime';

function createRuntime(overrides: Partial<Parameters<typeof createSessionClientCommitQueueRuntime>[0]> = {}) {
    return createSessionClientCommitQueueRuntime({
        token: 'token-1',
        sessionId: 'session-1',
        transcriptStorage: 'persisted',
        sessionEncryptionMode: 'plain',
        encryptionKey: new Uint8Array(),
        encryptionVariant: 'dataKey',
        getSocket: () => ({
            connected: true,
            timeout: () => ({
                connected: true,
                emitWithAck: async () => ({ ok: false, error: 'server rejected commit' }),
            }),
        } as never),
        getClosed: () => false,
        addPendingMaterializedLocalId: vi.fn(),
        hasPendingMaterializedLocalId: () => true,
        markCommittedLocalIdAwaitingEcho: vi.fn(),
        deleteMaterializedLocalId: vi.fn(),
        scheduleMaterializationRecovery: vi.fn(),
        recoverMaterializedLocalId: async () => false,
        observeCommittedAck: vi.fn(),
        ...overrides,
    });
}

describe('createSessionClientCommitQueueRuntime definitive commit failures', () => {
    it('marks explicit server commit rejection as definitive', async () => {
        const runtime = createRuntime();

        let thrown: unknown;
        await runtime.commitSessionMessage({
            message: { t: 'plain', v: { role: 'agent', content: 'hello' } },
            localId: 'local-1',
            sidechainId: null,
            messageRole: 'agent',
            requireCommit: true,
        }).catch((error: unknown) => {
            thrown = error;
        });

        expect(isDefinitiveSessionMessageCommitError(thrown)).toBe(true);
    });

    it('does not mark ACK timeout and recovery failure as definitive', async () => {
        const runtime = createRuntime({
            getSocket: () => ({
                connected: true,
                timeout: () => ({
                    connected: true,
                    emitWithAck: async () => undefined,
                }),
            } as never),
            recoverMaterializedLocalId: async () => false,
        });

        let thrown: unknown;
        await runtime.commitSessionMessage({
            message: { t: 'plain', v: { role: 'agent', content: 'hello' } },
            localId: 'local-1',
            sidechainId: null,
            messageRole: 'agent',
            requireCommit: true,
        }).catch((error: unknown) => {
            thrown = error;
        });

        expect(thrown).toBeInstanceOf(Error);
        expect(isDefinitiveSessionMessageCommitError(thrown)).toBe(false);
    });
});
