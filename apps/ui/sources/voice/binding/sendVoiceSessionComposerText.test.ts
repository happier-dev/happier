import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { RPC_ERROR_CODES } from '@happier-dev/protocol';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import { createVoiceSessionBindingStore } from './voiceConversationBindingStore';
import { sendVoiceSessionComposerText, submitDurableVoiceTextTurn } from './sendVoiceSessionComposerText';

const initialStorageState = getStorage().getState();

function setCurrentConversationSession(conversationSessionId: string): void {
    getStorage().setState((state) => ({
        sessions: {
            ...state.sessions,
            [conversationSessionId]: createSessionFixture({ id: conversationSessionId }),
        },
    }));
}

function createAcceptedPendingPort() {
    return {
        enqueuePendingMessage: vi.fn(async ({ localId }: Readonly<{ localId: string }>) => ({
            localId,
            accepted: true,
            externalHandoffClaimed: true,
        } as const)),
        blockPendingDelivery: vi.fn(async () => {}),
        markPendingDeliveryHandled: vi.fn(async () => {}),
    };
}

describe('sendVoiceSessionComposerText', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        getStorage().setState(initialStorageState, true);
    });

    it('commits the exact external-handoff row through the canonical pending owner after provider acceptance', async () => {
        const events: string[] = [];
        const enqueuePendingMessage = vi.spyOn(sync, 'enqueuePendingMessage').mockImplementation(async (
            _conversationSessionId,
            _text,
            _displayText,
            _meta,
            options,
        ) => {
            const localId = options?.localId ?? '';
            events.push(`enqueue:${localId}`);
            return { localId, accepted: true, externalHandoffClaimed: true } as const;
        });
        const dispatch = vi.fn(async ({ localId, onAccepted }: Readonly<{
            localId: string;
            onAccepted(): Promise<void>;
        }>) => {
            events.push(`dispatch:${localId}`);
            await onAccepted();
        });
        const markPendingDeliveryHandled = vi.spyOn(sync, 'markPendingDeliveryHandled').mockImplementation(async (
            _conversationSessionId,
            localId,
        ) => {
            events.push(`settle:${localId}`);
        });

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            dispatch,
        })).resolves.toEqual({
            ok: true,
            localId: 'voice-local-1',
            disposition: 'settled',
        });

        expect(enqueuePendingMessage).toHaveBeenCalledWith('carrier-s1', 'hello', undefined, {
            happier: {
                kind: 'conversation_turn.v1',
                payload: { v: 1 },
                conversationTurnOriginV1: {
                    v: 1,
                    channel: 'realtime_conversation',
                    modality: 'voice',
                },
            },
        }, {
            localId: 'voice-local-1',
            deliveryMode: 'external_handoff',
            requestedAction: { v: 1, kind: 'send_now' },
        });
        expect(markPendingDeliveryHandled).toHaveBeenCalledExactlyOnceWith(
            'carrier-s1',
            'voice-local-1',
        );
        expect(events).toEqual([
            'enqueue:voice-local-1',
            'dispatch:voice-local-1',
            'settle:voice-local-1',
        ]);
    });

    it('lets the dispatcher settle the pending row at its exact provider-acceptance boundary', async () => {
        const events: string[] = [];
        const pendingPort = {
            enqueuePendingMessage: vi.fn(async ({ localId }: Readonly<{ localId: string }>) => ({
                localId,
                accepted: true,
                externalHandoffClaimed: true,
            } as const)),
            blockPendingDelivery: vi.fn(async () => {}),
            markPendingDeliveryHandled: vi.fn(async () => {
                events.push('settled');
            }),
        };

        const result = await submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort,
            dispatch: async (input) => {
                events.push('provider-accepted');
                await (input as typeof input & Readonly<{ onAccepted(): Promise<void> }>).onAccepted();
                events.push('provider-continuation');
            },
        });

        expect(result).toEqual({
            ok: true,
            localId: 'voice-local-1',
            disposition: 'settled',
        });
        expect(events).toEqual([
            'provider-accepted',
            'settled',
            'provider-continuation',
        ]);
        expect(pendingPort.markPendingDeliveryHandled).toHaveBeenCalledTimes(1);
    });

    it('does not report a settled turn when the durable settlement write fails after dispatch resolves', async () => {
        const blockPendingDelivery = vi.fn(async () => {});
        const markPendingDeliveryHandled = vi.fn(async () => {
            await Promise.resolve();
            throw new Error('pending_settlement_failed');
        });

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({
                    localId: 'voice-local-1',
                    accepted: true,
                    externalHandoffClaimed: true,
                } as const)),
                blockPendingDelivery,
                markPendingDeliveryHandled,
            },
            // The provider acknowledges acceptance but does not await the durable
            // settlement write, so its rejection lands after dispatch resolves.
            dispatch: async ({ onAccepted }) => {
                void onAccepted();
            },
        })).resolves.toEqual({
            ok: true,
            localId: 'voice-local-1',
            disposition: 'ambiguous',
            message: 'pending settlement failed: pending_settlement_failed',
        });

        expect(markPendingDeliveryHandled).toHaveBeenCalledTimes(1);
        expect(blockPendingDelivery).not.toHaveBeenCalled();
    });

    it('keeps a turn settled when a post-acceptance dispatch failure races an in-flight settlement write', async () => {
        const blockPendingDelivery = vi.fn(async () => {});
        const markPendingDeliveryHandled = vi.fn(async () => {
            await Promise.resolve();
        });

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({
                    localId: 'voice-local-1',
                    accepted: true,
                    externalHandoffClaimed: true,
                } as const)),
                blockPendingDelivery,
                markPendingDeliveryHandled,
            },
            // Acceptance is acknowledged, then the dispatcher fails (or is
            // aborted) while the durable settlement write is still in flight.
            dispatch: async ({ onAccepted }) => {
                void onAccepted();
                throw new Error('turn_aborted');
            },
        })).resolves.toEqual({
            ok: true,
            localId: 'voice-local-1',
            disposition: 'settled',
            message: 'turn_aborted',
        });

        expect(markPendingDeliveryHandled).toHaveBeenCalledTimes(1);
        expect(blockPendingDelivery).not.toHaveBeenCalled();
    });

    it('does not infer provider acceptance from a dispatcher that returns without acknowledging it', async () => {
        const dispatch = vi.fn(async () => undefined);
        const blockPendingDelivery = vi.fn(async () => {});
        const markPendingDeliveryHandled = vi.fn(async () => {});

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({
                    localId: 'voice-local-1',
                    accepted: true,
                    externalHandoffClaimed: true,
                } as const)),
                blockPendingDelivery,
                markPendingDeliveryHandled,
            },
            dispatch,
        })).resolves.toEqual({
            ok: true,
            localId: 'voice-local-1',
            disposition: 'ambiguous',
            message: 'voice_turn_acceptance_not_reported',
        });

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(markPendingDeliveryHandled).not.toHaveBeenCalled();
        expect(blockPendingDelivery).toHaveBeenCalledExactlyOnceWith({
            conversationSessionId: 'carrier-s1',
            localId: 'voice-local-1',
            reason: 'delivery_outcome_uncertain',
        });
    });

    it('maps terminal rejection to a failure and never dispatches', async () => {
        const dispatch = vi.fn(async () => undefined);

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({
                    localId: 'voice-local-1',
                    accepted: false,
                    terminal: true,
                } as const)),
                blockPendingDelivery: vi.fn(async () => {}),
                markPendingDeliveryHandled: vi.fn(async () => {}),
            },
            dispatch,
        })).resolves.toEqual({
            ok: false,
            reason: 'terminal_rejected',
            localId: 'voice-local-1',
        });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('maps an already-settled enqueue to a successful no-op and never dispatches', async () => {
        const dispatch = vi.fn(async () => undefined);

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({
                    localId: 'voice-local-1',
                    accepted: true,
                    settled: true,
                } as const)),
                blockPendingDelivery: vi.fn(async () => {}),
                markPendingDeliveryHandled: vi.fn(async () => {}),
            },
            dispatch,
        })).resolves.toEqual({
            ok: true,
            disposition: 'settled',
            localId: 'voice-local-1',
        });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('preserves a contract-valid opaque pending identity without using it as a provider event id', async () => {
        const enqueuePendingMessage = vi.fn(async ({ localId }: Readonly<{ localId: string }>) => ({
            localId,
            accepted: true,
            externalHandoffClaimed: true,
        } as const));
        const dispatch = vi.fn(async () => undefined);

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: ' opaque-local-id ',
            pendingPort: {
                enqueuePendingMessage,
                blockPendingDelivery: vi.fn(async () => {}),
                markPendingDeliveryHandled: vi.fn(async () => {}),
            },
            dispatch,
        })).resolves.toMatchObject({ ok: true, localId: expect.any(String) });

        const enqueuedLocalId = enqueuePendingMessage.mock.calls[0]?.[0].localId;
        expect(enqueuedLocalId).toBe(' opaque-local-id ');
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ localId: enqueuedLocalId }));
    });

    it('durably enqueues before exact adapter dispatch and reuses one local id', async () => {
        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            lifetime: 'runtime_attempt',
            transcriptMode: 'synthetic',
            targetSessionId: 's1',
            updatedAt: 123,
        });
        const events: string[] = [];
        const enqueuePendingMessage = vi.fn(async ({ localId }: Readonly<{ localId: string }>) => {
            events.push(`enqueue:${localId}`);
            return { localId, accepted: true, externalHandoffClaimed: true } as const;
        });
        const sendTextTurn = vi.fn(async ({
            localId,
            onAccepted,
        }: Readonly<{ localId: string; onAccepted(): Promise<void> }>) => {
            events.push(`dispatch:${localId}`);
            await onAccepted();
        });
        const params = {
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            store,
            pendingPort: {
                enqueuePendingMessage,
                blockPendingDelivery: vi.fn(async () => {}),
                markPendingDeliveryHandled: vi.fn(async () => {
                    events.push('settle:voice-local-1');
                }),
            },
            getAdapter: () => ({
                id: 'happier.voice.elevenlabs/realtime-elevenlabs',
                engineKind: 'realtime' as const,
                transcriptSource: {
                    pluginId: 'happier.voice.elevenlabs',
                    contributionId: 'realtime-elevenlabs',
                },
                start: vi.fn(), stop: vi.fn(), toggle: vi.fn(), interrupt: vi.fn(),
                setMuted: vi.fn(), sendContextUpdate: vi.fn(), getSnapshot: vi.fn(), sendTextTurn,
            }) as any,
        };

        const result = await sendVoiceSessionComposerText(params);

        expect(result).toEqual({ ok: true, localId: 'voice-local-1', disposition: 'settled' });
        expect(sendTextTurn).toHaveBeenCalledWith({
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            deliveryCommand: 'interrupt_and_send',
            onAccepted: expect.any(Function),
        });
        expect(events).toEqual([
            'enqueue:voice-local-1',
            'dispatch:voice-local-1',
            'settle:voice-local-1',
        ]);
        expect(enqueuePendingMessage).toHaveBeenCalledWith(expect.objectContaining({
            source: {
                pluginId: 'happier.voice.elevenlabs',
                contributionId: 'realtime-elevenlabs',
            },
        }));
    });

    it('routes synthetic voice conversation sessions through adapter text turns', async () => {
        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            lifetime: 'runtime_attempt',
            transcriptMode: 'synthetic',
            targetSessionId: 's1',
            updatedAt: 123,
        });

        const sendTextTurn = vi.fn(async (input: Readonly<{ onAccepted(): Promise<void> }>) => {
            await input.onAccepted();
        });

        const result = await sendVoiceSessionComposerText({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            store,
            pendingPort: createAcceptedPendingPort(),
            getAdapter: () => ({
                id: 'happier.voice.elevenlabs/realtime-elevenlabs',
                start: vi.fn(),
                stop: vi.fn(),
                toggle: vi.fn(),
                interrupt: vi.fn(),
                sendContextUpdate: vi.fn(),
                getSnapshot: vi.fn(),
                sendTextTurn,
            }) as any,
        });

        expect(result).toMatchObject({ ok: true, disposition: 'settled' });
        expect(sendTextTurn).toHaveBeenCalledWith({
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: expect.any(String),
            deliveryCommand: 'interrupt_and_send',
            onAccepted: expect.any(Function),
        });
    });

    it('routes native hidden voice sessions through adapter text turns too', async () => {
        const store = createVoiceSessionBindingStore();
        setCurrentConversationSession('carrier-s1');
        store.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            transcriptMode: 'native_session',
            targetSessionId: null,
            updatedAt: 123,
        });

        const sendTextTurn = vi.fn(async (input: Readonly<{ onAccepted(): Promise<void> }>) => {
            await input.onAccepted();
        });
        const result = await sendVoiceSessionComposerText({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            store,
            pendingPort: createAcceptedPendingPort(),
            getAdapter: () => ({
                id: 'local_conversation',
                start: vi.fn(),
                stop: vi.fn(),
                toggle: vi.fn(),
                interrupt: vi.fn(),
                sendContextUpdate: vi.fn(),
                getSnapshot: vi.fn(),
                sendTextTurn,
            }) as any,
        });

        expect(result).toMatchObject({ ok: true, disposition: 'settled' });
        expect(sendTextTurn).toHaveBeenCalledWith({
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: expect.any(String),
            deliveryCommand: 'interrupt_and_send',
            onAccepted: expect.any(Function),
        });
    });

    it('keeps unconfirmed durable input pending and never dispatches it', async () => {
        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs', controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1', lifetime: 'runtime_attempt', transcriptMode: 'synthetic',
            targetSessionId: 's1', updatedAt: 123,
        });
        const sendTextTurn = vi.fn(async () => {});
        const params = {
            conversationSessionId: 'carrier-s1', text: 'hello', localId: 'voice-local-1', store,
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({ localId: 'voice-local-1', accepted: false } as const)),
                blockPendingDelivery: vi.fn(async () => {}),
                markPendingDeliveryHandled: vi.fn(async () => {}),
            },
            getAdapter: () => ({
                id: 'happier.voice.elevenlabs/realtime-elevenlabs', engineKind: 'realtime' as const,
                start: vi.fn(), stop: vi.fn(), toggle: vi.fn(), interrupt: vi.fn(),
                setMuted: vi.fn(), sendContextUpdate: vi.fn(), getSnapshot: vi.fn(), sendTextTurn,
            }),
        };

        await expect(sendVoiceSessionComposerText(params)).resolves.toEqual({
            ok: true, localId: 'voice-local-1', disposition: 'pending',
        });
        expect(sendTextTurn).not.toHaveBeenCalled();
    });

    it('returns typed cancellation and never dispatches the cancelled id', async () => {
        const store = createVoiceSessionBindingStore();
        setCurrentConversationSession('carrier-s1');
        store.getState().bind({
            adapterId: 'local_conversation', controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1', transcriptMode: 'native_session',
            targetSessionId: null, updatedAt: 123,
        });
        const sendTextTurn = vi.fn(async () => {});
        const params = {
            conversationSessionId: 'carrier-s1', text: 'hello', localId: 'voice-local-1', store,
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({ localId: 'voice-local-1', accepted: true, cancelled: true } as const)),
                blockPendingDelivery: vi.fn(async () => {}),
                markPendingDeliveryHandled: vi.fn(async () => {}),
            },
            getAdapter: () => ({
                id: 'local_conversation', engineKind: 'local' as const,
                start: vi.fn(), stop: vi.fn(), toggle: vi.fn(), interrupt: vi.fn(),
                setMuted: vi.fn(), sendContextUpdate: vi.fn(), getSnapshot: vi.fn(), sendTextTurn,
            }),
        };

        await expect(sendVoiceSessionComposerText(params)).resolves.toEqual({
            ok: false, reason: 'cancelled', localId: 'voice-local-1',
        });
        expect(sendTextTurn).not.toHaveBeenCalled();
    });

    it('retains ambiguous adapter failure without retrying provider delivery', async () => {
        const store = createVoiceSessionBindingStore();
        setCurrentConversationSession('carrier-s1');
        store.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            transcriptMode: 'native_session',
            targetSessionId: 's1',
            updatedAt: 123,
        });

        const sendTextTurn = vi.fn(async () => {
            throw new Error('send_failed');
        });
        const blockPendingDelivery = vi.fn(async () => {});
        const result = await sendVoiceSessionComposerText({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            store,
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({ localId: 'voice-local-1', accepted: true, externalHandoffClaimed: true } as const)),
                blockPendingDelivery,
                markPendingDeliveryHandled: vi.fn(async () => {}),
            },
            getAdapter: () => ({
                id: 'local_conversation',
                start: vi.fn(),
                stop: vi.fn(),
                toggle: vi.fn(),
                interrupt: vi.fn(),
                sendContextUpdate: vi.fn(),
                getSnapshot: vi.fn(),
                sendTextTurn,
            }) as any,
        });

        expect(result).toEqual({
            ok: true,
            localId: 'voice-local-1',
            disposition: 'ambiguous',
            message: 'send_failed',
        });
        expect(sendTextTurn).toHaveBeenCalledTimes(1);
        expect(blockPendingDelivery).toHaveBeenCalledWith({
            conversationSessionId: 'carrier-s1',
            localId: 'voice-local-1',
            reason: 'delivery_outcome_uncertain',
        });
    });

    it('keeps a typed method-unavailable pending settlement failure ambiguous after agent admission', async () => {
        const blockPendingDelivery = vi.fn(async () => {});
        const methodUnavailable = new RpcError(
            'RPC method not available: execution.run.stream.start.v2',
            RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        );

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({
                    localId: 'voice-local-1',
                    accepted: true,
                    externalHandoffClaimed: true,
                } as const)),
                blockPendingDelivery,
                markPendingDeliveryHandled: vi.fn(async () => {
                    throw methodUnavailable;
                }),
            },
            dispatch: vi.fn(async ({ onAccepted }) => {
                await onAccepted();
            }),
        })).resolves.toEqual({
            ok: true,
            localId: 'voice-local-1',
            disposition: 'ambiguous',
            message: methodUnavailable.message,
        });
        expect(blockPendingDelivery).toHaveBeenCalledWith({
            conversationSessionId: 'carrier-s1',
            localId: 'voice-local-1',
            reason: 'delivery_outcome_uncertain',
        });
    });

    it('blocks a typed before-effect rejection as definitely provider-rejected and returns failure', async () => {
        const blockPendingDelivery = vi.fn(async () => {});
        const beforeEffectRejection = Object.assign(new Error('voice_transcript_carrier_changed'), {
            code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
            pendingDeliveryBlockedReason: 'provider_rejected_before_acceptance' as const,
        });

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({
                    localId: 'voice-local-1',
                    accepted: true,
                    externalHandoffClaimed: true,
                } as const)),
                blockPendingDelivery,
                markPendingDeliveryHandled: vi.fn(async () => {}),
            },
            dispatch: vi.fn(async () => {
                throw beforeEffectRejection;
            }),
        })).resolves.toEqual({
            ok: false,
            reason: 'terminal_rejected',
            localId: 'voice-local-1',
            message: 'voice_transcript_carrier_changed',
        });
        expect(blockPendingDelivery).toHaveBeenCalledWith({
            conversationSessionId: 'carrier-s1',
            localId: 'voice-local-1',
            reason: 'provider_rejected_before_acceptance',
        });
    });

    it('keeps an untyped method-unavailable message ambiguous instead of inferring definite rejection', async () => {
        const blockPendingDelivery = vi.fn(async () => {});

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({
                    localId: 'voice-local-1',
                    accepted: true,
                    externalHandoffClaimed: true,
                } as const)),
                blockPendingDelivery,
                markPendingDeliveryHandled: vi.fn(async () => {}),
            },
            dispatch: vi.fn(async () => {
                throw new Error('RPC method not available');
            }),
        })).resolves.toEqual({
            ok: true,
            localId: 'voice-local-1',
            disposition: 'ambiguous',
            message: 'RPC method not available',
        });
        expect(blockPendingDelivery).toHaveBeenCalledWith({
            conversationSessionId: 'carrier-s1',
            localId: 'voice-local-1',
            reason: 'delivery_outcome_uncertain',
        });
    });

    it('keeps a definite rejection failed when exact-row blocking also fails', async () => {
        const beforeEffectRejection = Object.assign(new Error('voice_transcript_carrier_changed'), {
            code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
            pendingDeliveryBlockedReason: 'provider_rejected_before_acceptance' as const,
        });

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({
                    localId: 'voice-local-1',
                    accepted: true,
                    externalHandoffClaimed: true,
                } as const)),
                blockPendingDelivery: vi.fn(async () => {
                    throw new Error('pending_block_failed');
                }),
                markPendingDeliveryHandled: vi.fn(async () => {}),
            },
            dispatch: vi.fn(async () => {
                throw beforeEffectRejection;
            }),
        })).resolves.toEqual({
            ok: false,
            reason: 'terminal_rejected',
            localId: 'voice-local-1',
            message: 'voice_transcript_carrier_changed; pending settlement failed: pending_block_failed',
        });
    });

    it('fails closed when the durable row was not atomically fenced for external handoff', async () => {
        const dispatch = vi.fn(async () => {});
        const { submitDurableVoiceTextTurn } = await import('./sendVoiceSessionComposerText');

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({ localId: 'voice-local-1', accepted: true } as const)),
                blockPendingDelivery: vi.fn(async () => {}),
                markPendingDeliveryHandled: vi.fn(async () => {}),
            },
            dispatch,
        })).resolves.toEqual({
            ok: false,
            reason: 'send_failed',
            localId: 'voice-local-1',
            message: 'voice_pending_external_handoff_not_claimed',
        });
        expect(dispatch).not.toHaveBeenCalled();
    });
});
