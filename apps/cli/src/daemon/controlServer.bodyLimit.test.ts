import { request as requestHttp } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { createDaemonControlApp } from './controlServer';

describe('createDaemonControlApp /session-started body limit', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('accepts large session-started metadata payloads', async () => {
        const onHappySessionWebhook = vi.fn();
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine-1',
            stopSession: vi.fn(async () => ({ status: 'stopped' as const })),
            spawnSession: vi.fn(async () => ({
                type: 'error' as const,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unused',
            })),
            requestShutdown: vi.fn(),
            onHappySessionWebhook,
            controlToken: 'control-token',
        });

        try {
            const metadata: Metadata = {
                path: '/test/large-path',
                host: 'test-host',
                homeDir: '/test/home',
                happyHomeDir: '/test/happy-home',
                happyLibDir: '/test/happy-lib',
                happyToolsDir: '/test/happy-tools',
                hostPid: 99998,
                startedBy: 'terminal',
                machineId: 'test-machine-large',
                summary: {
                    text: 'x'.repeat(2 * 1024 * 1024),
                    updatedAt: Date.now(),
                },
            };

            const response = await app.inject({
                method: 'POST',
                url: '/session-started',
                headers: {
                    'x-happier-daemon-token': 'control-token',
                },
                payload: {
                    sessionId: 'test-session-large',
                    metadata,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: 'ok' });
            expect(onHappySessionWebhook).toHaveBeenCalledWith('test-session-large', metadata);
        } finally {
            await app.close();
        }
    });

    it('does not acknowledge session-started until required readiness completes', async () => {
        let resolveReadiness!: () => void;
        const readiness = new Promise<void>((resolve) => {
            resolveReadiness = resolve;
        });
        const onHappySessionWebhook = vi.fn(async () => {
            await readiness;
        });
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine-1',
            stopSession: vi.fn(async () => ({ status: 'stopped' as const })),
            spawnSession: vi.fn(async () => ({
                type: 'error' as const,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unused',
            })),
            requestShutdown: vi.fn(),
            onHappySessionWebhook,
            controlToken: 'control-token',
        });

        try {
            let settled = false;
            const responsePromise = app.inject({
                method: 'POST',
                url: '/session-started',
                headers: { 'x-happier-daemon-token': 'control-token' },
                payload: {
                    sessionId: 'test-session-required-readiness',
                    metadata: {
                        path: '/test/path',
                        hostPid: 99997,
                        startedBy: 'daemon',
                    },
                },
            }).finally(() => {
                settled = true;
            });

            await vi.waitFor(() => expect(onHappySessionWebhook).toHaveBeenCalledOnce());
            expect(settled).toBe(false);

            resolveReadiness();
            const response = await responsePromise;
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: 'ok' });
        } finally {
            await app.close();
        }
    });

    it('dispatches the strict persisted-takeover variant without replaying ordinary startup reconciliation', async () => {
        const onHappySessionWebhook = vi.fn();
        const admitPersistedTakeover = vi.fn(async () => undefined);
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine-1',
            stopSession: vi.fn(async () => ({ status: 'stopped' as const })),
            spawnSession: vi.fn(async () => ({
                type: 'error' as const,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unused',
            })),
            requestShutdown: vi.fn(),
            onHappySessionWebhook,
            admitPersistedTakeover,
            controlToken: 'control-token',
        });

        try {
            const metadata: Metadata = {
                path: '/test/takeover',
                host: 'test-host',
                homeDir: '/test/home',
                happyHomeDir: '/test/happy-home',
                happyLibDir: '/test/happy-lib',
                happyToolsDir: '/test/happy-tools',
                hostPid: 99996,
                startedBy: 'daemon',
            };
            const ordinaryResponse = await app.inject({
                method: 'POST',
                url: '/session-started',
                headers: { 'x-happier-daemon-token': 'control-token' },
                payload: {
                    sessionId: 'session-takeover',
                    metadata,
                },
            });
            const response = await app.inject({
                method: 'POST',
                url: '/session-started',
                headers: { 'x-happier-daemon-token': 'control-token' },
                payload: {
                    sessionId: 'session-takeover',
                    metadata,
                    persistedTakeoverAdmission: {
                        operationId: 'operation-1',
                        attemptId: 'attempt-1',
                        phase: 'admit',
                    },
                },
            });

            expect(ordinaryResponse.statusCode).toBe(200);
            expect(response.statusCode).toBe(200);
            expect(admitPersistedTakeover).toHaveBeenCalledWith({
                sessionId: 'session-takeover',
                operationId: 'operation-1',
                attemptId: 'attempt-1',
                phase: 'admit',
                signal: expect.any(AbortSignal),
            });
            expect(onHappySessionWebhook).toHaveBeenCalledOnce();
            expect(onHappySessionWebhook).toHaveBeenCalledWith('session-takeover', metadata);
        } finally {
            await app.close();
        }
    });

    it('aborts persisted-takeover admission when the control request ends before acknowledgement', async () => {
        let resolveObservedSignal!: (signal: AbortSignal) => void;
        const observedSignal = new Promise<AbortSignal>((resolve) => {
            resolveObservedSignal = resolve;
        });
        let resolveObservedAbort!: () => void;
        const observedAbort = new Promise<void>((resolve) => {
            resolveObservedAbort = resolve;
        });
        const admitPersistedTakeover = vi.fn(async (input: Readonly<{
            signal: AbortSignal;
        }>) => {
            resolveObservedSignal(input.signal);
            await new Promise<void>((_resolve, reject) => {
                const onAbort = () => {
                    resolveObservedAbort();
                    reject(input.signal.reason);
                };
                if (input.signal.aborted) {
                    onAbort();
                    return;
                }
                input.signal.addEventListener('abort', onAbort, { once: true });
            });
        });
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine-1',
            stopSession: vi.fn(async () => ({ status: 'stopped' as const })),
            spawnSession: vi.fn(async () => ({
                type: 'error' as const,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unused',
            })),
            requestShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            admitPersistedTakeover,
            controlToken: 'control-token',
        });

        try {
            await app.listen({ host: '127.0.0.1', port: 0 });
            const address = app.server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Expected daemon control test server TCP address');
            }
            const payload = JSON.stringify({
                sessionId: 'session-takeover',
                metadata: { startedBy: 'daemon' },
                persistedTakeoverAdmission: {
                    operationId: 'operation-1',
                    attemptId: 'attempt-1',
                    phase: 'admit',
                },
            });
            const request = requestHttp({
                host: '127.0.0.1',
                port: address.port,
                path: '/session-started',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                    'x-happier-daemon-token': 'control-token',
                },
            });
            const requestClosed = new Promise<void>((resolve) => {
                request.once('error', () => resolve());
                request.once('close', () => resolve());
            });
            request.end(payload);
            const signal = await observedSignal;

            request.destroy();

            await requestClosed;
            await expect(observedAbort).resolves.toBeUndefined();
            expect(signal.aborted).toBe(true);
        } finally {
            await app.close();
        }
    });

    it('fails an older persisted-takeover runtime without strict phases as upgrade-required', async () => {
        const admitPersistedTakeover = vi.fn(async () => undefined);
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine-1',
            stopSession: vi.fn(async () => ({ status: 'stopped' as const })),
            spawnSession: vi.fn(async () => ({
                type: 'error' as const,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unused',
            })),
            requestShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            admitPersistedTakeover,
            controlToken: 'control-token',
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/session-started',
                headers: { 'x-happier-daemon-token': 'control-token' },
                payload: {
                    sessionId: 'session-takeover',
                    metadata: { startedBy: 'daemon' },
                    persistedTakeoverAdmission: {
                        operationId: 'operation-1',
                        attemptId: 'attempt-1',
                    },
                },
            });

            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({
                status: 'error',
                errorCode: 'persisted_takeover_admission_upgrade_required',
            });
            expect(admitPersistedTakeover).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it.each([
        ['synchronous', () => {
            throw new Error('sync readiness failure');
        }],
        ['asynchronous', async () => {
            throw new Error('async readiness failure');
        }],
    ])('returns a typed 503 when %s required readiness fails', async (_kind, onHappySessionWebhook) => {
        const app = createDaemonControlApp({
            getChildren: () => [],
            machineId: 'machine-1',
            stopSession: vi.fn(async () => ({ status: 'stopped' as const })),
            spawnSession: vi.fn(async () => ({
                type: 'error' as const,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unused',
            })),
            requestShutdown: vi.fn(),
            onHappySessionWebhook,
            controlToken: 'control-token',
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/session-started',
                headers: { 'x-happier-daemon-token': 'control-token' },
                payload: {
                    sessionId: 'test-session-failed-readiness',
                    metadata: {
                        path: '/test/path',
                        hostPid: 99996,
                        startedBy: 'daemon',
                    },
                },
            });

            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({
                status: 'error',
                errorCode: 'session_startup_reconciliation_failed',
            });
        } finally {
            await app.close();
        }
    });
});
