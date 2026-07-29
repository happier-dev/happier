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
    };
}

describe('sendVoiceSessionComposerText', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        getStorage().setState(initialStorageState, true);
    });

    it('leaves externally claimed pending custody to the canonical echo settlement owner after acknowledged dispatch', async () => {
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
        const dispatch = vi.fn(async ({ localId }: Readonly<{ localId: string }>) => {
            events.push(`dispatch:${localId}`);
        });
        const markPendingDeliveryHandled = vi.spyOn(sync, 'markPendingDeliveryHandled');

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            dispatch,
        })).resolves.toEqual({
            ok: true,
            localId: 'voice-local-1',
            disposition: 'handoff_acknowledged',
        });

        expect(enqueuePendingMessage).toHaveBeenCalledWith('carrier-s1', 'hello', undefined, undefined, {
            localId: 'voice-local-1',
            deliveryMode: 'external_handoff',
            requestedAction: { v: 1, kind: 'send_now' },
        });
        expect(markPendingDeliveryHandled).not.toHaveBeenCalled();
        expect(events).toEqual([
            'enqueue:voice-local-1',
            'dispatch:voice-local-1',
        ]);
    });

    it('does not expose obsolete explicit settlement authority on the voice pending port', async () => {
        const dispatch = vi.fn(async () => undefined);

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
                blockPendingDelivery: vi.fn(async () => {}),
            },
            dispatch,
        })).resolves.toEqual({
            ok: true,
            localId: 'voice-local-1',
            disposition: 'handoff_acknowledged',
        });

        expect(dispatch).toHaveBeenCalledTimes(1);
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
            },
            dispatch,
        })).resolves.toEqual({
            ok: true,
            disposition: 'settled',
            localId: 'voice-local-1',
        });

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('preserves an opaque caller-owned Pending local id byte-for-byte', async () => {
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
            },
            dispatch,
        })).resolves.toMatchObject({ ok: true, localId: ' opaque-local-id ' });

        expect(enqueuePendingMessage).toHaveBeenCalledWith(expect.objectContaining({
            localId: ' opaque-local-id ',
        }));
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            localId: ' opaque-local-id ',
        }));
    });

    it('durably enqueues before exact adapter dispatch and reuses one local id', async () => {
        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'realtime_elevenlabs',
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
        const sendTextTurn = vi.fn(async ({ localId }: Readonly<{ localId: string }>) => {
            events.push(`dispatch:${localId}`);
        });
        const params = {
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            store,
            pendingPort: {
                enqueuePendingMessage,
                blockPendingDelivery: vi.fn(async () => {}),
            },
            getAdapter: () => ({
                id: 'realtime_elevenlabs',
                engineKind: 'realtime' as const,
                start: vi.fn(), stop: vi.fn(), toggle: vi.fn(), interrupt: vi.fn(),
                setMuted: vi.fn(), sendContextUpdate: vi.fn(), getSnapshot: vi.fn(), sendTextTurn,
            }),
        };

        const result = await sendVoiceSessionComposerText(params);

        expect(result).toEqual({ ok: true, localId: 'voice-local-1', disposition: 'handoff_acknowledged' });
        expect(sendTextTurn).toHaveBeenCalledWith({
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            deliveryCommand: 'interrupt_and_send',
        });
        expect(events).toEqual([
            'enqueue:voice-local-1',
            'dispatch:voice-local-1',
        ]);
    });

    it('routes synthetic voice conversation sessions through adapter text turns', async () => {
        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'realtime_elevenlabs',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            lifetime: 'runtime_attempt',
            transcriptMode: 'synthetic',
            targetSessionId: 's1',
            updatedAt: 123,
        });

        const sendTextTurn = vi.fn(async () => {});

        const result = await sendVoiceSessionComposerText({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            store,
            pendingPort: createAcceptedPendingPort(),
            getAdapter: () => ({
                id: 'realtime_elevenlabs',
                start: vi.fn(),
                stop: vi.fn(),
                toggle: vi.fn(),
                interrupt: vi.fn(),
                sendContextUpdate: vi.fn(),
                getSnapshot: vi.fn(),
                sendTextTurn,
            }) as any,
        });

        expect(result).toMatchObject({ ok: true, disposition: 'handoff_acknowledged' });
        expect(sendTextTurn).toHaveBeenCalledWith({
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: expect.any(String),
            deliveryCommand: 'interrupt_and_send',
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

        const sendTextTurn = vi.fn(async () => {});
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

        expect(result).toMatchObject({ ok: true, disposition: 'handoff_acknowledged' });
        expect(sendTextTurn).toHaveBeenCalledWith({
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: expect.any(String),
            deliveryCommand: 'interrupt_and_send',
        });
    });

    it('keeps unconfirmed durable input pending and never dispatches it', async () => {
        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'realtime_elevenlabs', controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1', lifetime: 'runtime_attempt', transcriptMode: 'synthetic',
            targetSessionId: 's1', updatedAt: 123,
        });
        const sendTextTurn = vi.fn(async () => {});
        const params = {
            conversationSessionId: 'carrier-s1', text: 'hello', localId: 'voice-local-1', store,
            pendingPort: {
                enqueuePendingMessage: vi.fn(async () => ({ localId: 'voice-local-1', accepted: false } as const)),
                blockPendingDelivery: vi.fn(async () => {}),
            },
            getAdapter: () => ({
                id: 'realtime_elevenlabs', engineKind: 'realtime' as const,
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

    it('blocks typed method-unavailable rejection as definitely provider-unavailable and returns failure', async () => {
        vi.spyOn(sync, 'enqueuePendingMessage').mockResolvedValue({
            localId: 'voice-local-1',
            accepted: true,
            externalHandoffClaimed: true,
        });
        const blockPendingDelivery = vi.spyOn(sync, 'blockPendingDelivery').mockResolvedValue();
        const methodUnavailable = new RpcError(
            'RPC method not available: execution.run.stream.start.v2',
            RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        );

        await expect(submitDurableVoiceTextTurn({
            conversationSessionId: 'carrier-s1',
            text: 'hello',
            localId: 'voice-local-1',
            dispatch: vi.fn(async () => {
                throw methodUnavailable;
            }),
        })).resolves.toEqual({
            ok: false,
            reason: 'terminal_rejected',
            localId: 'voice-local-1',
            message: methodUnavailable.message,
        });
        expect(blockPendingDelivery).toHaveBeenCalledWith(
            'carrier-s1',
            'voice-local-1',
            'provider_unavailable_before_acceptance',
        );
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
                blockPendingDelivery: vi.fn(async () => {
                    throw new Error('pending_block_failed');
                }),
            },
            dispatch: vi.fn(async () => {
                throw methodUnavailable;
            }),
        })).resolves.toEqual({
            ok: false,
            reason: 'terminal_rejected',
            localId: 'voice-local-1',
            message: 'RPC method not available: execution.run.stream.start.v2; pending settlement failed: pending_block_failed',
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
