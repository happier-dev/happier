import { describe, expect, it } from 'vitest';

import {
    createClaudePublicSessionRuntime,
    type ClaudeRuntimeTurnOperations,
} from './sessionRuntime.js';
import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

function createRecordingOperations(): Readonly<{
    operations: ClaudeRuntimeTurnOperations;
    normalPrompts: Array<Readonly<{
        prompt: string;
        meta?: Readonly<{
            providerClaimedPendingLocalIds?: readonly string[];
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>;
    }>>;
    steers: Array<Readonly<{
        message: string;
        meta?: Readonly<{
            providerClaimedPendingLocalIds?: readonly string[];
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>;
    }>>;
    emit(event: RuntimeEventV1): void;
}> {
    const normalPrompts: Array<Readonly<{
        prompt: string;
        meta?: Readonly<{
            providerClaimedPendingLocalIds?: readonly string[];
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>;
    }>> = [];
    const steers: Array<Readonly<{
        message: string;
        meta?: Readonly<{
            providerClaimedPendingLocalIds?: readonly string[];
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>;
    }>> = [];
    const eventHandlers = new Set<(event: RuntimeEventV1) => void>();
    const operations: ClaudeRuntimeTurnOperations = {
        beginTurnLifecycle() {},
        async startOrLoadSession() {
            return null;
        },
        async sendTurnPrompt(prompt, meta) {
            normalPrompts.push({ prompt, meta });
        },
        async steerInFlightTurn(message, meta) {
            steers.push({ message, meta });
        },
        async waitForTurnCompletion() {},
        subscribeRuntimeEvents(handler) {
            eventHandlers.add(handler);
            return () => {
                eventHandlers.delete(handler);
            };
        },
        async respondToPermission() {
            return { delivered: true };
        },
        async cancelTurn() {},
        readSessionIdentity() {
            return { sessionId: null };
        },
        async updateSessionRuntimeConfig() {},
        async resetOrDisposeRuntime() {},
    };

    return {
        operations,
        normalPrompts,
        steers,
        emit(event) {
            for (const handler of eventHandlers) {
                handler(event);
            }
        },
    };
}

describe('createClaudePublicSessionRuntime', () => {
    it('preserves provider-claimed pending identity and userMessageSeq on normal public send delivery', async () => {
        const { operations, normalPrompts } = createRecordingOperations();
        const runtime = createClaudePublicSessionRuntime(operations);

        await expect(runtime.send(
            { text: 'normal prompt' },
            {
                providerClaimedPendingLocalIds: ['local-claimed-1', 'local-claimed-1', '  ', 'local-claimed-2'],
                userMessageSeq: 42,
            },
        ))
            .resolves
            .toEqual({ status: 'accepted' });

        expect(normalPrompts).toEqual([
            {
                prompt: 'normal prompt',
                meta: {
                    providerClaimedPendingLocalIds: ['local-claimed-1', 'local-claimed-2'],
                    userMessageSeq: 42,
                    userMessageSeqs: [42],
                },
            },
        ]);
    });

    it('preserves provider-claimed pending identity and userMessageSeq on steer public send delivery', async () => {
        const { operations, steers } = createRecordingOperations();
        const runtime = createClaudePublicSessionRuntime(operations);

        await expect(runtime.send(
            { text: 'steer prompt' },
            {
                deliverAs: 'steer',
                providerClaimedPendingLocalIds: ['local-claimed-steer'],
                userMessageSeq: 43,
            },
        ))
            .resolves
            .toEqual({ status: 'accepted' });

        expect(steers).toEqual([
            {
                message: 'steer prompt',
                meta: {
                    providerClaimedPendingLocalIds: ['local-claimed-steer'],
                    userMessageSeq: 43,
                    userMessageSeqs: [43],
                },
            },
        ]);
    });

    it('drops non-integer or negative userMessageSeq values before runtime delivery', async () => {
        const { operations, normalPrompts, steers } = createRecordingOperations();
        const runtime = createClaudePublicSessionRuntime(operations);

        await expect(runtime.send({ text: 'fractional prompt' }, { userMessageSeq: 4.5 }))
            .resolves
            .toEqual({ status: 'accepted' });
        await expect(runtime.send({ text: 'negative steer' }, { deliverAs: 'steer', userMessageSeq: -1 }))
            .resolves
            .toEqual({ status: 'accepted' });

        expect(normalPrompts).toEqual([
            {
                prompt: 'fractional prompt',
                meta: undefined,
            },
        ]);
        expect(steers).toEqual([
            {
                message: 'negative steer',
                meta: undefined,
            },
        ]);
    });

    it('confirms provider acceptance only after Claude Agent SDK runtime evidence', async () => {
        const { operations, emit } = createRecordingOperations();
        const runtime = createClaudePublicSessionRuntime(operations);
        const accepted: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
        runtime.setOnPromptAcceptedByProvider?.((info) => accepted.push(info));

        await expect(runtime.send({ text: 'normal prompt' }, { userMessageSeq: 44 }))
            .resolves
            .toEqual({ status: 'accepted' });

        expect(accepted).toEqual([]);

        emit({
            kind: 'message-delta',
            sessionId: 'happier-session-1',
            turnId: 'claude-sdk-turn-1',
            delta: { text: 'hello' },
        });

        expect(accepted).toEqual([{ userMessageSeq: 44, userMessageSeqs: [44] }]);
    });
});
