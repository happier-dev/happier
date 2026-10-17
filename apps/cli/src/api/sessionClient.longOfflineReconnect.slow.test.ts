import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketPairMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readCredentials: vi.fn(async () => ({
        token: 'fake-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    })),
    readAccountChangesCursor: vi.fn(async () => 0),
    writeAccountChangesCursor: vi.fn(async () => {}),
}));

vi.mock('axios');

describe('ApiSessionClient long-offline reconnect fallback', () => {
    it('falls back to snapshot sync when /v2/changes hits the page cap (>=200) and still catches up messages on reconnect', async () => {
        const { ApiSessionClient } = await import('./session/sessionClient');
        const { writeAccountChangesCursor } = await import('@/persistence');
        (writeAccountChangesCursor as any).mockClear?.();

        const mockSocket = createApiSessionSocketStub();
        const mockUserSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket: mockSocket, userSocket: mockUserSocket });

        const encryptionKey = new Uint8Array(32).fill(7);
        const encryptionVariant = 'legacy' as const;
        const sessionId = 'test-session-id';

        const CHANGES_PAGE_LIMIT = 200;
        const changes = Array.from({ length: CHANGES_PAGE_LIMIT }, (_v, i) => ({
            cursor: i + 1,
            kind: 'session',
            entityId: `s-${i}`,
            changedAt: Date.now(),
            hint: null,
        }));

        const lastObservedMessageSeq = 10;

        (axios.get as any).mockImplementation(async (url: string, config?: any) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }

            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: { changes, nextCursor: CHANGES_PAGE_LIMIT },
                };
            }

            if (url.endsWith('/v2/account/settings')) {
                return {
                    status: 200,
                    data: { content: { t: 'plain', v: {} }, version: 0 },
                };
            }

            if (url.includes(`/v1/sessions/${sessionId}/messages`)) {
                expect(config?.params?.afterSeq).toBe(lastObservedMessageSeq);
                return {
                    status: 200,
                    data: { messages: [], nextAfterSeq: null },
                };
            }

            throw new Error(`Unexpected axios.get: ${url}`);
        });

        const client = new ApiSessionClient(
            'fake-token',
            createMockSession({
                id: sessionId,
                encryptionKey,
                encryptionVariant,
            }),
        );

        const snapshotSpy = vi.fn(async () => {});
        (client as any).syncSessionSnapshotFromServer = snapshotSpy;

        (client as any).hasConnectedOnce = true;
        (client as any).lastObservedMessageSeq = lastObservedMessageSeq;

        mockSocket.trigger('connect');
        await vi.waitFor(() => {
            expect(snapshotSpy).toHaveBeenCalledWith({ reason: 'socket-reconnect-catchup' });
        }, { timeout: 15_000 });
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();

        await client.close();
    });

    it('falls back to snapshot sync when /v2/changes is missing (e.g. old server 404) and still catches up messages on reconnect', async () => {
        const { ApiSessionClient } = await import('./session/sessionClient');
        const { writeAccountChangesCursor } = await import('@/persistence');
        (writeAccountChangesCursor as any).mockClear?.();

        const mockSocket = createApiSessionSocketStub();
        const mockUserSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket: mockSocket, userSocket: mockUserSocket });

        const encryptionKey = new Uint8Array(32).fill(7);
        const encryptionVariant = 'legacy' as const;
        const sessionId = 'test-session-id';

        const lastObservedMessageSeq = 10;

        (axios.get as any).mockImplementation(async (url: string, config?: any) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }

            if (url.includes('/v2/changes')) {
                return {
                    status: 404,
                    data: { error: 'not-found' },
                };
            }

            if (url.includes(`/v1/sessions/${sessionId}/messages`)) {
                expect(config?.params?.afterSeq).toBe(lastObservedMessageSeq);
                return {
                    status: 200,
                    data: { messages: [], nextAfterSeq: null },
                };
            }

            throw new Error(`Unexpected axios.get: ${url}`);
        });

        const client = new ApiSessionClient(
            'fake-token',
            createMockSession({
                id: sessionId,
                encryptionKey,
                encryptionVariant,
            }),
        );

        const snapshotSpy = vi.fn(async () => {});
        (client as any).syncSessionSnapshotFromServer = snapshotSpy;

        (client as any).hasConnectedOnce = true;
        (client as any).lastObservedMessageSeq = lastObservedMessageSeq;

        mockSocket.trigger('connect');
        await vi.waitFor(() => {
            expect(snapshotSpy).toHaveBeenCalledWith({ reason: 'socket-reconnect-catchup' });
        }, { timeout: 15_000 });
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();

        await client.close();
    });

    it.each([401, 403] as const)('reports /v2/changes auth status %i to the session supervisor without fallback sync', async (status) => {
        const { ApiSessionClient } = await import('./session/sessionClient');
        const { writeAccountChangesCursor } = await import('@/persistence');
        (writeAccountChangesCursor as any).mockClear?.();

        const mockSocket = createApiSessionSocketStub();
        const mockUserSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket: mockSocket, userSocket: mockUserSocket });

        const encryptionKey = new Uint8Array(32).fill(7);
        const encryptionVariant = 'legacy' as const;
        const sessionId = 'test-session-id';

        (axios.get as any).mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }

            if (url.includes('/v2/changes')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }

            throw new Error(`Unexpected axios.get: ${url}`);
        });

        const client = new ApiSessionClient(
            'fake-token',
            createMockSession({
                id: sessionId,
                encryptionKey,
                encryptionVariant,
            }),
        );

        const snapshotSpy = vi.fn(async () => {});
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'sessionConnectionSupervisor', {
            configurable: true,
            value: {
                stop: vi.fn(async () => {}),
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });
        (client as any).syncSessionSnapshotFromServer = snapshotSpy;
        (client as any).hasConnectedOnce = true;
        (client as any).lastObservedMessageSeq = 10;
        (axios.get as any).mockClear();

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
        expect(snapshotSpy).not.toHaveBeenCalled();
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();

        await client.close();
    });

    it.each([401, 403] as const)('reports profile auth status %i to the session supervisor before /v2/changes sync', async (status) => {
        const { ApiSessionClient } = await import('./session/sessionClient');
        const { writeAccountChangesCursor } = await import('@/persistence');
        (writeAccountChangesCursor as any).mockClear?.();

        const mockSocket = createApiSessionSocketStub();
        const mockUserSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket: mockSocket, userSocket: mockUserSocket });

        (axios.get as any).mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }

            throw new Error(`Unexpected axios.get: ${url}`);
        });

        const client = new ApiSessionClient(
            'fake-token',
            createMockSession({
                id: 'test-session-id',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
            }),
        );

        const snapshotSpy = vi.fn(async () => {});
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'sessionConnectionSupervisor', {
            configurable: true,
            value: {
                stop: vi.fn(async () => {}),
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });
        (client as any).syncSessionSnapshotFromServer = snapshotSpy;
        (client as any).hasConnectedOnce = true;
        (client as any).lastObservedMessageSeq = 10;
        (axios.get as any).mockClear();

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
        const axiosGetCalls = vi.mocked(axios.get).mock.calls;
        expect(axiosGetCalls.some((call) => String(call[0]).includes('/v2/changes'))).toBe(false);
        expect(snapshotSpy).not.toHaveBeenCalled();
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();

        await client.close();
    });

    it.each([401, 403] as const)('throws /v2/changes auth status %i without a session supervisor instead of falling back', async (status) => {
        const { ApiSessionClient } = await import('./session/sessionClient');
        const { writeAccountChangesCursor } = await import('@/persistence');
        (writeAccountChangesCursor as any).mockClear?.();

        const mockSocket = createApiSessionSocketStub();
        const mockUserSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket: mockSocket, userSocket: mockUserSocket });

        (axios.get as any).mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }

            if (url.includes('/v2/changes')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }

            throw new Error(`Unexpected axios.get: ${url}`);
        });

        const client = new ApiSessionClient(
            'fake-token',
            createMockSession({
                id: 'test-session-id',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
            }),
        );

        const snapshotSpy = vi.fn(async () => {});
        Object.defineProperty(client, 'sessionConnectionSupervisor', {
            configurable: true,
            value: null,
        });
        (client as any).syncSessionSnapshotFromServer = snapshotSpy;
        (client as any).hasConnectedOnce = true;
        (client as any).lastObservedMessageSeq = 10;

        await expect((client as any).syncChangesOnConnect({ reason: 'reconnect' })).rejects.toMatchObject({
            code: 'not_authenticated',
            response: { status },
        });

        expect(snapshotSpy).not.toHaveBeenCalled();
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();

        await client.close();
    });

});
