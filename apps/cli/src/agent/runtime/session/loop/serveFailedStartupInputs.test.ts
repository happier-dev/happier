import { describe, expect, it } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts } from '@/agent/runtime/permissions/queuedPrompt';
import type { PermissionModeQueuedPrompt, PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import type { HostProviderInputOutcomeEvidence } from '@/agent/runtime/session/input/providerInputOutcome';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';

import { serveFailedStartupInputs } from './serveFailedStartupInputs';

describe('serveFailedStartupInputs', () => {
    it('retires a refused launch when its authoritative input projection is empty', async () => {
        const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'default');
        const consumer = createSessionProviderInputConsumer({
            messageQueue: queue,
            session: {
                waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
                readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
            },
        });
        await expect(serveFailedStartupInputs({ consumer, signal: new AbortController().signal,
            diagnostic: { code: 'resource_unavailable', severity: 'error' },
            observe: () => { throw new Error('No input was admitted'); },
            retireAfterInput: true, retryable: true,
        })).resolves.toBe(false);
    });
    it.each([false, true])('retires the failed receiver independently of refusal retryability %s', async retryable => {
        const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'default', {
            batcher: combinePermissionModeQueuedPrompts,
        });
        queue.pushIsolate({ text: 'Original request', localId: 'original', userMessageSeq: 7 }, { permissionMode: 'default' });
        queue.pushIsolate({ text: 'Later request', localId: 'later' }, { permissionMode: 'default' });
        const consumer = createSessionProviderInputConsumer({
            messageQueue: queue,
            session: { waitForMetadataUpdate: () => new Promise<boolean>(() => {}) },
        });
        const outcomes: HostProviderInputOutcomeEvidence[] = [];
        const signal = new AbortController().signal;
        const refusal = {
            consumer, signal, diagnostic: { code: 'continuation_unreachable', severity: 'error' as const },
            observe: (outcome: HostProviderInputOutcomeEvidence) => { outcomes.push(outcome); },
            retireAfterInput: true, retryable,
        };

        await expect(serveFailedStartupInputs(refusal)).resolves.toBe(true);

        expect(outcomes).toEqual([{
            type: 'input-rejected', localInputId: 'original', userMessageSeq: 7, userMessageSeqs: [7],
            diagnostic: refusal.diagnostic, retryable,
        }]);
        await expect(consumer.waitForNextInput({ abortSignal: signal })).resolves.toMatchObject({
            message: { localId: 'later' },
        });
        consumer.releaseInputBatch();
    });
});
