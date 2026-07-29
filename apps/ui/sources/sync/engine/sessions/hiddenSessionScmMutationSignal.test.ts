import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiMessage } from '@/sync/api/types/apiTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { resetSessionSurfaceVisibilityForTests } from '@/sync/domains/session/sessionSurfaceVisibility';
import { storage } from '@/sync/domains/state/storage';
import {
    clearMountedSessionRealtimeScmConsumerScopes,
    registerSessionRealtimeScmConsumerScope,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { deliverHiddenSessionScmMutationSignal } from './hiddenSessionScmMutationSignal';

const initialStorageState = storage.getInitialState();

function buildSession(params: Readonly<{ id: string; path: string; machineId: string }>): Session {
    return {
        id: params.id,
        seq: 1,
        createdAt: 1_000,
        updatedAt: 1_000,
        active: true,
        activeAt: 1_000,
        metadata: {
            path: params.path,
            machineId: params.machineId,
        } as Session['metadata'],
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        encryptionMode: 'plain',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: 900,
    };
}

function buildEditToolRawRecord(filePath: string) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: 'uuid-edit',
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'toolu_edit_1',
                            name: 'Edit',
                            input: { file_path: filePath, old_string: 'a', new_string: 'b' },
                        },
                    ],
                },
            },
        },
    };
}

function buildPlainEditToolMessage(filePath: string): ApiMessage {
    return {
        id: 'message-edit',
        seq: 7,
        localId: null,
        messageRole: 'agent',
        createdAt: 2_000,
        updatedAt: 2_000,
        content: { t: 'plain', v: buildEditToolRawRecord(filePath) },
    };
}

function registerRepoScmScope(): () => void {
    return registerSessionRealtimeScmConsumerScope({
        sessionId: 'scm-consumer',
        canonicalProjectKey: 'machine-a:/repo',
        machineScopeId: 'machine-a',
        repoRoot: '/repo',
    });
}

describe('deliverHiddenSessionScmMutationSignal', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        clearMountedSessionRealtimeScmConsumerScopes();
        resetSessionSurfaceVisibilityForTests();
        storage.getState().applySessions([
            buildSession({ id: 'hidden-producer', machineId: 'machine-a', path: '/repo/packages/app' }),
            buildSession({ id: 'scm-consumer', machineId: 'machine-a', path: '/repo/packages/ui' }),
        ]);
    });

    afterEach(() => {
        storage.setState(initialStorageState, true);
        clearMountedSessionRealtimeScmConsumerScopes();
        resetSessionSurfaceVisibilityForTests();
    });

    it('ingests plain durable tool-call messages for hidden same-project sessions without touching the store', async () => {
        const unregister = registerRepoScmScope();
        const ingestMessages = vi.fn();

        try {
            await deliverHiddenSessionScmMutationSignal({
                sessionId: 'hidden-producer',
                rawMessage: buildPlainEditToolMessage('/repo/packages/app/src/index.ts'),
                getSessionEncryption: () => null,
                ingestMessages,
            });
        } finally {
            unregister();
        }

        expect(ingestMessages).toHaveBeenCalledTimes(1);
        const [sessionId, messages] = ingestMessages.mock.calls[0] as [string, NormalizedMessage[]];
        expect(sessionId).toBe('hidden-producer');
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            id: 'message-edit',
            role: 'agent',
            content: [
                {
                    type: 'tool-call',
                    name: 'Edit',
                    input: { file_path: '/repo/packages/app/src/index.ts' },
                },
            ],
        });
        // The signal side channel must not hydrate the hidden session transcript.
        expect(storage.getState().sessionMessages['hidden-producer']).toBeUndefined();
    });

    it('does nothing when no mounted SCM scope matches the session project', async () => {
        const ingestMessages = vi.fn();
        const getSessionEncryption = vi.fn(() => null);

        await deliverHiddenSessionScmMutationSignal({
            sessionId: 'hidden-producer',
            rawMessage: buildPlainEditToolMessage('/repo/packages/app/src/index.ts'),
            getSessionEncryption,
            ingestMessages,
        });

        expect(ingestMessages).not.toHaveBeenCalled();
        expect(getSessionEncryption).not.toHaveBeenCalled();
    });

    it('skips user and event durable messages without resolving encryption', async () => {
        const unregister = registerRepoScmScope();
        const ingestMessages = vi.fn();
        const getSessionEncryption = vi.fn(() => null);

        try {
            for (const messageRole of ['user', 'event'] as const) {
                await deliverHiddenSessionScmMutationSignal({
                    sessionId: 'hidden-producer',
                    rawMessage: { ...buildPlainEditToolMessage('/repo/x.ts'), messageRole },
                    getSessionEncryption,
                    ingestMessages,
                });
            }
        } finally {
            unregister();
        }

        expect(ingestMessages).not.toHaveBeenCalled();
        expect(getSessionEncryption).not.toHaveBeenCalled();
    });

    it('decrypts a single encrypted durable message through the session encryption boundary', async () => {
        const unregister = registerRepoScmScope();
        const ingestMessages = vi.fn();
        const rawRecord = buildEditToolRawRecord('/repo/packages/app/src/encrypted.ts');
        // Boundary mock: session encryption is a crypto boundary; we assert the decrypted
        // outcome (normalized tool-call) rather than call counts alone.
        const decryptMessage = vi.fn(async (message: ApiMessage) => ({
            id: message.id,
            seq: message.seq,
            localId: message.localId ?? null,
            messageRole: message.messageRole ?? null,
            content: rawRecord,
            createdAt: message.createdAt,
        }));

        try {
            await deliverHiddenSessionScmMutationSignal({
                sessionId: 'hidden-producer',
                rawMessage: {
                    id: 'message-encrypted',
                    seq: 9,
                    localId: null,
                    messageRole: 'agent',
                    createdAt: 2_500,
                    updatedAt: 2_500,
                    content: { t: 'encrypted', c: 'ciphertext' },
                },
                getSessionEncryption: () => ({ decryptMessage }),
                ingestMessages,
            });
        } finally {
            unregister();
        }

        expect(decryptMessage).toHaveBeenCalledTimes(1);
        expect(ingestMessages).toHaveBeenCalledTimes(1);
        const [, messages] = ingestMessages.mock.calls[0] as [string, NormalizedMessage[]];
        expect(messages[0]).toMatchObject({
            id: 'message-encrypted',
            role: 'agent',
            content: [
                {
                    type: 'tool-call',
                    name: 'Edit',
                    input: { file_path: '/repo/packages/app/src/encrypted.ts' },
                },
            ],
        });
    });
});
