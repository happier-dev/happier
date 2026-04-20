import { access, readFile } from 'node:fs/promises';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installRealtimeCommonModuleMocks } from './realtimeTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const handleProviderConnected = vi.fn();
const handleProviderDisconnected = vi.fn();
const handleProviderMessage = vi.fn();
const handleProviderError = vi.fn();
const handleProviderModeChange = vi.fn();
const handleProviderComponentUnmounted = vi.fn();
const registerConversationHandle = vi.fn();
const setActiveConversationHandle = vi.fn();
const registerTransportVoiceSession = vi.fn();

let lastConversationOptions: any = null;

installRealtimeCommonModuleMocks({
    storage: async () => {
        throw new Error('RealtimeVoiceSession.web should not read storage directly after transport ownership cutover');
    },
});

vi.mock('@elevenlabs/react', () => ({
    useConversation: (options: any) => {
        lastConversationOptions = options;
        return {
            startSession: vi.fn(async () => 'conv_1'),
            endSession: vi.fn(async () => {}),
            getId: vi.fn(() => 'conv_1'),
            sendUserMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        };
    },
}));

vi.mock('./realtimeClientTools', () => ({
    realtimeClientTools: {},
}));

vi.mock('@/voice/runtime/realtime/RealtimeTransport', () => ({
    realtimeTransport: {
        getConversationBackedVoiceSession: () => ({
            startSession: vi.fn(async () => 'conv_1'),
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        }),
        handleProviderConnected: () => handleProviderConnected(),
        handleProviderDisconnected: () => handleProviderDisconnected(),
        handleProviderMessage: (payload: unknown) => handleProviderMessage(payload),
        handleProviderError: (error: unknown) => handleProviderError(error),
        handleProviderModeChange: (mode: string) => handleProviderModeChange(mode),
        handleProviderComponentUnmounted: () => handleProviderComponentUnmounted(),
        registerConversationHandle: (params: unknown) => registerConversationHandle(params),
        registerVoiceSession: (session: unknown) => registerTransportVoiceSession(session),
        setActiveConversationHandle: (handle: unknown) => setActiveConversationHandle(handle),
    },
}));

describe('RealtimeVoiceSession.web ownership delegation', () => {
    let mountedTree: { unmount: () => void; update?: (element: React.ReactElement) => void } | null = null;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        lastConversationOptions = null;
    });

    afterEach(() => {
        if (mountedTree) {
            act(() => {
                mountedTree?.unmount();
            });
        }
        mountedTree = null;
    });

    it('delegates provider callbacks to RealtimeTransport without direct status or transcript writes', async () => {
        const { RealtimeVoiceSession } = await import('./RealtimeVoiceSession.web');

        await act(async () => {
            mountedTree = (await renderScreen(React.createElement(RealtimeVoiceSession))).tree;
        });

        expect(registerTransportVoiceSession).toHaveBeenCalledTimes(1);
        expect(registerConversationHandle).toHaveBeenCalled();
        expect(lastConversationOptions).toBeTruthy();

        const payload = { type: 'agent_response', agent_response_event: { agent_response: 'hello' } };
        await act(async () => {
            lastConversationOptions.onConnect();
            lastConversationOptions.onMessage(payload);
            lastConversationOptions.onError('provider-down');
            lastConversationOptions.onModeChange({ mode: 'speaking' });
            lastConversationOptions.onDisconnect();
        });

        expect(handleProviderConnected).toHaveBeenCalledTimes(1);
        expect(handleProviderMessage).toHaveBeenCalledWith(payload);
        expect(handleProviderError).toHaveBeenCalledWith('provider-down');
        expect(handleProviderModeChange).toHaveBeenCalledWith('speaking');
        expect(handleProviderDisconnected).toHaveBeenCalledTimes(1);
    });

    it('does not treat conversation handle replacement as a provider component unmount', async () => {
        const { RealtimeVoiceSession } = await import('./RealtimeVoiceSession.web');

        await act(async () => {
            mountedTree = (await renderScreen(React.createElement(RealtimeVoiceSession))).tree;
        });

        expect(handleProviderComponentUnmounted).toHaveBeenCalledTimes(0);

        await act(async () => {
            mountedTree?.update?.(React.createElement(RealtimeVoiceSession));
        });

        expect(handleProviderComponentUnmounted).toHaveBeenCalledTimes(0);
    });

    it('keeps mounted realtime session ownership out of the retired RealtimeSession compatibility facade', async () => {
        const nativeSource = await readFile(new URL('./RealtimeVoiceSession.tsx', import.meta.url), 'utf8');
        const webSource = await readFile(new URL('./RealtimeVoiceSession.web.tsx', import.meta.url), 'utf8');

        await expect(access(new URL('./RealtimeSession.ts', import.meta.url))).rejects.toBeDefined();
        expect(nativeSource).not.toContain("from './RealtimeSession'");
        expect(webSource).not.toContain("from './RealtimeSession'");
        expect(webSource).not.toContain('realtimeVoiceTranscriptBridge');
    });
});
