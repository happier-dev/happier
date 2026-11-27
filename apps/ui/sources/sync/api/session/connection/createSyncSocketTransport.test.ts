import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';
// Visibility state is keyed on globalThis so it survives vi.resetModules(); clear it between cases.
import { clearActiveViewingSessionsForServerScopeReset } from '@/sync/domains/session/activeViewingSession';

type SocketHandler = (...args: any[]) => void;

function createSocketStub() {
    const handlersByEvent = new Map<string, Set<SocketHandler>>();
    const anyHandlers = new Set<SocketHandler>();
    const socket = {
        connected: false,
        emit: vi.fn(),
        on: vi.fn((event: string, handler: SocketHandler) => {
            const bucket = handlersByEvent.get(event) ?? new Set<SocketHandler>();
            bucket.add(handler);
            handlersByEvent.set(event, bucket);
            return socket;
        }),
        onAny: vi.fn((handler: SocketHandler) => {
            anyHandlers.add(handler);
            return socket;
        }),
        offAny: vi.fn(() => {
            anyHandlers.clear();
            return socket;
        }),
        connect: vi.fn(() => {
            socket.connected = true;
            for (const handler of handlersByEvent.get('connect') ?? []) {
                handler();
            }
        }),
        disconnect: vi.fn(() => {
            const wasConnected = socket.connected;
            socket.connected = false;
            if (!wasConnected) {
                return;
            }
            for (const handler of handlersByEvent.get('disconnect') ?? []) {
                handler('io client disconnect');
            }
        }),
        removeAllListeners: vi.fn(() => {
            handlersByEvent.clear();
        }),
        __emit(event: string, ...args: any[]) {
            for (const handler of handlersByEvent.get(event) ?? []) {
                handler(...args);
            }
        },
    };
    return socket;
}

describe('createSyncSocketTransport', () => {
    beforeEach(async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        vi.doMock('react-native', () => createReactNativeWebMock({ Platform: { OS: 'web' } }));
    });
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('configures socket.io to avoid Manager cache retention', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        const ioSpy = vi.fn((_url: string, _options: { auth?: Record<string, unknown> }) => socket);
        vi.doMock('socket.io-client', () => ({
            io: ioSpy,
        }));

        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        createSyncSocketTransport({
            endpoint: 'https://api.example.test',
            token: 'token-a',
            transports: ['websocket'],
        });

        expect(ioSpy).toHaveBeenCalledWith(
            'https://api.example.test',
            expect.objectContaining({
                path: '/v1/updates/',
                auth: {
                    connectedServiceIds: ConnectedServiceIdSchema.options,
                    token: 'token-a',
                    clientType: 'user-scoped',
                    clientPurpose: 'sync',
                    // The sync socket renders live transcripts, so it declares runtime interest instead of the empty set.
                    transcriptInterestDeclared: true,
                },
                transports: ['websocket'],
                forceNew: true,
                multiplex: false,
                reconnection: false,
                withCredentials: false,
                autoConnect: false,
            }),
        );
        expect(ioSpy.mock.calls[0]?.[1]?.auth).not.toHaveProperty('sessionUpdateInterest');
    });

    it('forwards socket error events to transport.onError listeners', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({
            io: vi.fn(() => socket),
        }));

        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const { transport } = createSyncSocketTransport({
            endpoint: 'https://api.example.test',
            token: 'token-a',
        });

        const errorListener = vi.fn();
        transport.onError(errorListener);

        const error = new Error('boom');
        socket.__emit('error', error);

        expect(errorListener).toHaveBeenCalledWith(error);
    });

    it('handles upgrade-required connect errors without classifying the server as unreachable', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({
            io: vi.fn(() => socket),
        }));

        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const { transport } = createSyncSocketTransport({
            endpoint: 'https://api.example.test',
            token: 'token-a',
        });
        const errorListener = vi.fn();
        transport.onError(errorListener);

        socket.__emit('connect_error', {
            data: {
                error: 'client-upgrade-required',
                requirement: {
                    v: 1,
                    clientKind: 'ui-web',
                    minimumAppVersion: '0.3.0',
                    updateUrl: null,
                },
            },
        });

        expect(errorListener).not.toHaveBeenCalled();
    });

    it('disconnects the underlying socket when transport.destroy is called', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({
            io: vi.fn(() => socket),
        }));

        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const { transport } = createSyncSocketTransport({
            endpoint: 'https://api.example.test',
            token: 'token-a',
        });

        const disconnectedListener = vi.fn();
        transport.onDisconnected(disconnectedListener);

        await transport.connect();
        expect(socket.connected).toBe(true);

        await transport.destroy();

        expect(socket.disconnect).toHaveBeenCalledTimes(1);
        expect(socket.connected).toBe(false);
        expect(disconnectedListener).not.toHaveBeenCalled();
    });

    it('clears socket.onAny listeners when transport.destroy is called (prevents handler leaks across rebuilds)', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({
            io: vi.fn(() => socket),
        }));

        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const { transport } = createSyncSocketTransport({
            endpoint: 'https://api.example.test',
            token: 'token-a',
        });

        await transport.destroy();

        expect(socket.offAny).toHaveBeenCalledTimes(1);
    });

    it('treats disconnect() while already disconnected as idempotent and does not poison the next disconnect', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        socket.disconnect.mockImplementation(() => {
            if (!socket.connected) {
                throw new Error('socket has been disconnected');
            }
            socket.connected = false;
            socket.__emit('disconnect', 'io client disconnect');
        });
        vi.doMock('socket.io-client', () => ({
            io: vi.fn(() => socket),
        }));

        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const { transport } = createSyncSocketTransport({
            endpoint: 'https://api.example.test',
            token: 'token-a',
        });

        const disconnectedListener = vi.fn();
        transport.onDisconnected(disconnectedListener);

        await expect(transport.disconnect({ intentional: true })).resolves.toBeUndefined();
        expect(socket.disconnect).not.toHaveBeenCalled();
        expect(disconnectedListener).not.toHaveBeenCalled();

        await transport.connect();
        socket.__emit('disconnect', 'transport close');

        expect(disconnectedListener).toHaveBeenCalledWith(
            expect.objectContaining({ intentional: false }),
        );
    });
});


describe('computer focus publication', () => {
    beforeEach(async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        vi.doMock('react-native', () => createReactNativeWebMock({ Platform: { OS: 'web' } }));
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

    it('publishes current focus on connect/reconnect, blur, and destroys its subscription', async () => {
        const doc = new EventTarget();
        let focused = true;
        Object.assign(doc, { visibilityState: 'visible', hasFocus: () => focused });
        vi.stubGlobal('document', doc);
        vi.stubGlobal('window', doc);
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({ io: () => socket }));
        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const { transport } = createSyncSocketTransport({ endpoint: 'https://api.example.test', token: 't' });
        await transport.connect();
        expect(socket.emit).toHaveBeenLastCalledWith('ui-focus', { computer: true, focused: true });
        focused = false;
        doc.dispatchEvent(new Event('blur'));
        expect(socket.emit).toHaveBeenLastCalledWith('ui-focus', { computer: true, focused: false });
        await transport.disconnect();
        focused = true;
        await transport.connect();
        expect(socket.emit).toHaveBeenLastCalledWith('ui-focus', { computer: true, focused: true });
        await transport.destroy();
        socket.emit.mockClear();
        doc.dispatchEvent(new Event('focus'));
        expect(socket.emit).not.toHaveBeenCalled();
    });

    it('does not classify a focused mobile browser as a computer', async () => {
        const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true });
        vi.stubGlobal('document', doc);
        vi.stubGlobal('window', doc);
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' });
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({ io: () => socket }));
        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const { transport } = createSyncSocketTransport({ endpoint: 'https://api.example.test', token: 't' });
        await transport.connect();
        expect(socket.emit).toHaveBeenLastCalledWith('ui-focus', { computer: false, focused: false });
        await transport.destroy();
    });

    it('publishes an unfocused computer when a still-focused window becomes hidden', async () => {
        const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true });
        vi.stubGlobal('document', doc);
        vi.stubGlobal('window', doc);
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({ io: () => socket }));
        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const { transport } = createSyncSocketTransport({ endpoint: 'https://api.example.test', token: 't' });
        try {
            await transport.connect();
            expect(socket.emit).toHaveBeenLastCalledWith('ui-focus', { computer: true, focused: true });
            doc.visibilityState = 'hidden';
            doc.dispatchEvent(new Event('visibilitychange'));
            expect(socket.emit).toHaveBeenLastCalledWith('ui-focus', { computer: true, focused: false });
            await transport.disconnect();
            await transport.connect();
            expect(socket.emit).toHaveBeenLastCalledWith('ui-focus', { computer: true, focused: false });
            doc.visibilityState = 'visible';
            doc.dispatchEvent(new Event('visibilitychange'));
            expect(socket.emit).toHaveBeenLastCalledWith('ui-focus', { computer: true, focused: true });
        } finally {
            await transport.destroy();
        }
    });
});

describe('transcript interest publication', () => {
    const DEBOUNCE_MS = 250;

    /** Imports the stores from the same module registry as the freshly imported transport. */
    async function createConnectedTransport() {
        vi.resetModules();
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({ io: () => socket }));
        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const viewing = await import('@/sync/domains/session/activeViewingSession');
        const transcriptConsumers = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const voiceTarget = await import('@/voice/runtime/voiceTargetStore');
        const { transport } = createSyncSocketTransport({ endpoint: 'https://api.example.test', token: 't' });
        await transport.connect();
        const declarations = () => socket.emit.mock.calls
            .filter(([event]) => event === 'transcript-interest:set')
            .map(([, payload]) => payload);
        return { socket, transport, declarations, viewing, transcriptConsumers, voiceTarget };
    }

    beforeEach(async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        vi.doMock('react-native', () => createReactNativeWebMock({ Platform: { OS: 'web' } }));
        vi.useFakeTimers();
        clearActiveViewingSessionsForServerScopeReset();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.resetModules();
        clearActiveViewingSessionsForServerScopeReset();
    });

    it('declares the current set on connect and after the debounce window once an interest source changes', async () => {
        const { transport, declarations, viewing } = await createConnectedTransport();
        try {
            // The server starts every connection with an empty set, so an empty client set is not announced.
            expect(declarations()).toEqual([]);

            const release = viewing.registerSessionVisibleSurface('s-visible', 'profile-a');
            expect(declarations()).toEqual([]);
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
            expect(declarations()).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            expect(declarations()).toEqual([{ sessionIds: ['s-visible'] }]);
            release();
        } finally {
            await transport.destroy();
        }
    });

    it('coalesces a burst of source changes into one declaration and stays silent for unrelated store churn', async () => {
        const { transport, declarations, viewing, transcriptConsumers, voiceTarget } = await createConnectedTransport();
        try {
            const releaseVisible = viewing.registerSessionVisibleSurface('s-panes', 'profile-a');
            const releaseConsumer = transcriptConsumers.registerSessionRealtimeTranscriptConsumer('s-detail', 'profile-a');
            voiceTarget.useVoiceTargetStore.getState().addTrackedSessionId('s-tracked');
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
            expect(declarations()).toEqual([{ sessionIds: ['s-detail', 's-panes', 's-tracked'] }]);

            voiceTarget.useVoiceTargetStore.getState().setScope('session');
            viewing.markSessionVisible('s-panes', 'profile-b');
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
            expect(declarations()).toHaveLength(1);

            voiceTarget.useVoiceTargetStore.getState().removeTrackedSessionId('s-tracked');
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
            expect(declarations()).toEqual([
                { sessionIds: ['s-detail', 's-panes', 's-tracked'] },
                { sessionIds: ['s-detail', 's-panes'] },
            ]);
            releaseVisible();
            releaseConsumer();
        } finally {
            await transport.destroy();
        }
    });

    it('does not buffer changes across a disconnect and resends the current set on reconnect', async () => {
        const { transport, declarations, viewing } = await createConnectedTransport();
        try {
            const releaseFirst = viewing.registerSessionVisibleSurface('s-first', 'profile-a');
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
            expect(declarations()).toEqual([{ sessionIds: ['s-first'] }]);

            await transport.disconnect();
            const releaseSecond = viewing.registerSessionVisibleSurface('s-second', 'profile-a');
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
            expect(declarations()).toHaveLength(1);

            await transport.connect();
            expect(declarations()).toEqual([
                { sessionIds: ['s-first'] },
                { sessionIds: ['s-first', 's-second'] },
            ]);
            await transport.disconnect();
            releaseFirst();
            releaseSecond();
            await transport.connect();
            // An empty client set matches the server's handshake state, so reconnect announces nothing.
            expect(declarations()).toHaveLength(2);
        } finally {
            await transport.destroy();
        }
    });

    it('stops its subscription and pending declaration when destroyed', async () => {
        const { transport, declarations, viewing, voiceTarget } = await createConnectedTransport();
        const releaseFirst = viewing.registerSessionVisibleSurface('s-first', 'profile-a');
        await transport.destroy();
        releaseFirst();

        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        const releaseSecond = viewing.registerSessionVisibleSurface('s-second', 'profile-a');
        voiceTarget.useVoiceTargetStore.getState().setPrimaryActionSessionId('s-voice');
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
        releaseSecond();
        expect(declarations()).toEqual([]);
    });

    it('reports a refused declaration instead of failing silently', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { transport, socket, declarations, viewing } = await createConnectedTransport();
        try {
            viewing.registerSessionVisibleSurface('s-visible', 'profile-a');
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
            const ack = socket.emit.mock.calls.find(([event]) => event === 'transcript-interest:set')?.[2] as (response: unknown) => void;

            ack({ ok: true });
            expect(warn).not.toHaveBeenCalled();
            ack({ ok: false, error: 'not-allowed' });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(declarations()).toHaveLength(1);
        } finally {
            warn.mockRestore();
            await transport.destroy();
        }
    });
});
