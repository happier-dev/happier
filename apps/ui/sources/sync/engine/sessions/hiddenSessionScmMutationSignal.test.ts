import { type SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import type { DecryptedMessage, Session } from '@/sync/domains/state/storageTypes';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
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

function buildPlainEditToolMessage(filePath: string): SessionMessageV1 {
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
        serverId: null,
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
                sessionEncryptionMode: 'plain',
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
            sessionEncryptionMode: 'plain',
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
                    sessionEncryptionMode: 'plain',
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
        const decryptMessage = vi.fn(async (message: SessionMessageV1) => ({
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
                sessionEncryptionMode: 'e2ee',
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

    it('does not invalidate the workspace when its socket lifetime retires during decryption', async () => {
        const serverId = 'home-a';
        storage.getState().applySessions(Object.values(storage.getState().sessions).map(session => ({ ...session, serverId })));
        const machine = createMachineFixture({ id: 'machine-a' });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        const unregister = registerSessionRealtimeScmConsumerScope({ serverId, sessionId: 'scm-consumer',
            canonicalProjectKey: 'machine-a:/repo', machineScopeId: 'machine-a', repoRoot: '/repo' });
        const target = resolveWorkspaceTargetForSession({ serverId, sessionId: 'hidden-producer' });
        if (!target) throw new Error('Expected the mounted workspace');
        const key = { sessionId: target.workspaceCacheKey, snapshotSignature: 'retired-socket',
            diffArea: 'pending' as const, path: '/repo/packages/app/src/retired.ts' };
        scmDiffCache.set(key, 'current diff');
        let completeDecryption!: (value: DecryptedMessage) => void;
        const decrypted = new Promise<DecryptedMessage>(resolve => { completeDecryption = resolve; });
        let current = true;
        vi.useFakeTimers();
        try {
            const delivery = deliverHiddenSessionScmMutationSignal({
                sessionId: 'hidden-producer', serverId, sessionEncryptionMode: 'e2ee',
                rawMessage: { ...buildPlainEditToolMessage(key.path), content: { t: 'encrypted', c: 'pending-crypto' } },
                // Crypto is the system boundary; normalization, scope resolution and SCM ingestion stay real.
                getSessionEncryption: () => ({ decryptMessage: () => decrypted }),
                shouldContinue: () => current,
            });
            current = false;
            completeDecryption({ id: 'retired-message', seq: 7, localId: null, messageRole: 'agent',
                createdAt: 2_000, content: buildEditToolRawRecord(key.path) });
            await delivery;
            await vi.advanceTimersByTimeAsync(201);
            expect(scmDiffCache.get(key)).toMatchObject({ diff: 'current diff' });
            expect(storage.getState().sessionMessages['hidden-producer']).toBeUndefined();
        } finally {
            vi.useRealTimers(); unregister(); scmDiffCache.invalidateSession(target.workspaceCacheKey);
        }
    });
});
