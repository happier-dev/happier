import { describe, expect, it } from 'vitest';

import {
    createClaudeTestSessionRuntime,
    type ClaudeRuntimeTurnOperations,
} from './sessionRuntime.testkit.js';
import type {
    ClaudeProviderPromptDeliveryOutcome,
    ClaudeProviderPromptDeliveryOutcomeCallback,
} from './providerOperations.js';
import type { ClaudeProviderEvent } from './providerEvents.js';

function createRecordingOperations(): Readonly<{
    operations: ClaudeRuntimeTurnOperations;
    normalPrompts: Array<Readonly<{
        prompt: string;
        meta?: Readonly<{
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>;
    }>>;
    steers: Array<Readonly<{
        message: string;
        meta?: Readonly<{
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>;
    }>>;
    emit(event: ClaudeProviderEvent): void;
    emitDeliveryOutcome(outcome: ClaudeProviderPromptDeliveryOutcome): void;
}> {
    const normalPrompts: Array<Readonly<{
        prompt: string;
        meta?: Readonly<{
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>;
    }>> = [];
    const steers: Array<Readonly<{
        message: string;
        meta?: Readonly<{
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>;
    }>> = [];
    const eventHandlers = new Set<(event: ClaudeProviderEvent) => void>();
    let deliveryOutcomeHandler: ClaudeProviderPromptDeliveryOutcomeCallback | null = null;
    const operations: ClaudeRuntimeTurnOperations = {
        beginTurnLifecycle() {},
        async startProviderSession() {
            return null;
        },
        async sendTurnPrompt(prompt, meta) {
            normalPrompts.push({ prompt, meta });
            return { kind: 'accepted' };
        },
        async steerInFlightTurn(message, meta) {
            steers.push({ message, meta });
            return { kind: 'accepted' };
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
        setOnPromptDeliveryOutcome(handler) {
            deliveryOutcomeHandler = handler;
        },
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
        emitDeliveryOutcome(outcome) {
            deliveryOutcomeHandler?.(outcome);
        },
    };
}

describe('createClaudeTestSessionRuntime', () => {

    it('drops non-integer or negative userMessageSeq values before runtime delivery', async () => {
        const { operations, normalPrompts, steers } = createRecordingOperations();
        const runtime = createClaudeTestSessionRuntime(operations);

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

    it('translates the exact Claude Agent SDK submission result without downstream event inference', async () => {
        const { operations, emit } = createRecordingOperations();
        const runtime = createClaudeTestSessionRuntime(operations);
        const accepted: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
        runtime.setOnPromptAcceptedByProvider?.((info) => accepted.push(info));

        await expect(runtime.send({ text: 'normal prompt' }, { userMessageSeq: 44 }))
            .resolves
            .toEqual({ status: 'accepted' });

        expect(accepted).toEqual([{ userMessageSeq: 44, userMessageSeqs: [44] }]);

        emit({
            kind: 'message-delta',
            sessionId: 'happier-session-1',
            turnId: 'claude-sdk-turn-1',
            emittedAtMs: 1,
            delta: { text: 'hello' },
        });

        expect(accepted).toEqual([{ userMessageSeq: 44, userMessageSeqs: [44] }]);
    });

    it('forwards typed prompt delivery outcomes from Claude operations with stable identity intact', () => {
        const { operations, emitDeliveryOutcome } = createRecordingOperations();
        const runtime = createClaudeTestSessionRuntime(operations);
        const outcomes: ClaudeProviderPromptDeliveryOutcome[] = [];
        runtime.setOnPromptDeliveryOutcome?.((outcome) => outcomes.push(outcome));

        emitDeliveryOutcome({
            type: 'custody_observed',
            localInputId: 'local-custody',
            localInputIds: ['local-custody'],
            userMessageSeq: 45,
            userMessageSeqs: [45],
        });

        expect(outcomes).toEqual([{
            type: 'custody_observed',
            localInputId: 'local-custody',
            localInputIds: ['local-custody'],
            userMessageSeq: 45,
            userMessageSeqs: [45],
        }]);
    });
});
