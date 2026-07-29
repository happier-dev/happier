import { describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type {
    ServerAccountSessionRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';

import { createHostedSystemSessionEnsurer } from './hostedSystemSession';

const SERVER_BASIS = Object.freeze({ serverId: 'server-a', generation: 41 });
const ACCOUNT_A_AUTHORITY = {
    scope: { serverId: 'server-a', accountId: 'account-a' },
    context: { token: 'account-a-token' },
} as unknown as ServerAccountSessionRequestAuthority;

function sessionResponse(input: Readonly<{
    id: string;
    metadata: string;
    encryptionMode: 'plain' | 'e2ee';
    dataEncryptionKey: string | null;
}>): Response {
    return new Response(JSON.stringify({
        created: true,
        session: {
            id: input.id,
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: false,
            activeAt: 10,
            encryptionMode: input.encryptionMode,
            metadata: input.metadata,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: input.dataEncryptionKey,
        },
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createEncryptionFixture() {
    return {
        openEncryption: vi.fn(async (key: Uint8Array | null) => ({
            encrypt: vi.fn(async ([value]: unknown[]) => [
                new TextEncoder().encode(`sealed:${key ? [...key].join(',') : 'legacy'}:${JSON.stringify(value)}`),
            ]),
        })),
        encryptEncryptionKey: vi.fn(async (key: Uint8Array) =>
            new Uint8Array([...key].reverse())),
    };
}

describe('createHostedSystemSessionEnsurer', () => {
    it('binds create/load dispatch to the captured account credential and server generation', async () => {
        const credentials: AuthCredentials = {
            token: 'account-a-token',
            encryption: { publicKey: 'public-a', machineKey: 'machine-a' },
        };
        const request = vi.fn(async (...args: unknown[]) => {
            const init = args[1] as RequestInit | undefined;
            const authority = args[2] as {
                expectedActiveServer?: { serverId?: string; generation?: number };
            } | undefined;
            const headers = new Headers(init?.headers);
            expect(headers.get('Authorization')).toBe('Bearer account-a-token');
            expect(authority?.expectedActiveServer).toEqual({
                serverId: 'server-a',
                generation: 41,
            });
            const body = JSON.parse(String(init?.body));
            return sessionResponse({
                id: 'history-account-a',
                metadata: body.metadata,
                encryptionMode: 'e2ee',
                dataEncryptionKey: body.dataEncryptionKey,
            });
        });
        const hydrate = vi.fn(async (sessionId: string) => ({
            kind: 'available' as const,
            sessionId,
        }));
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'e2ee' as const })),
            randomBytes: vi.fn(() => new Uint8Array(32).fill(3)),
            request,
            hydrate,
            isScopeCurrent: vi.fn(() => true),
        });
        const input = {
            scopeKey: 'server-a/account-a',
            credentials,
            encryption: createEncryptionFixture(),
            serverBasis: SERVER_BASIS,
            authority: ACCOUNT_A_AUTHORITY,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1 as const, key: 'voice_transcript_history', hidden: true },
            },
        };

        await expect(ensurer.ensure(input)).resolves.toEqual({
            sessionId: 'history-account-a',
        });
        expect(hydrate).toHaveBeenCalledWith(
            'history-account-a',
            ACCOUNT_A_AUTHORITY,
        );
    });

    it('creates and hydrates an inactive plaintext hosted system session', async () => {
        const encryption = createEncryptionFixture();
        const hydrate = vi.fn(async () => ({ kind: 'available' as const, sessionId: 'history-plain' }));
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body).toEqual({
                tag: 'system:voice-transcript-history:v1',
                metadata: JSON.stringify({
                    systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                }),
                agentState: null,
                dataEncryptionKey: null,
                encryptionMode: 'plain',
            });
            return sessionResponse({
                id: 'history-plain',
                metadata: body.metadata,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
            });
        });
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'plain' as const })),
            randomBytes: vi.fn(() => new Uint8Array(32).fill(7)),
            request,
            hydrate,
            isScopeCurrent: vi.fn(() => true),
        });

        await expect(ensurer.ensure({
            scopeKey: 'server-a/account-a',
            credentials: { token: 'token', secret: 'secret' },
            encryption,
            serverBasis: SERVER_BASIS,
            authority: ACCOUNT_A_AUTHORITY,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
        })).resolves.toEqual({ sessionId: 'history-plain' });

        expect(encryption.openEncryption).not.toHaveBeenCalled();
        expect(encryption.encryptEncryptionKey).not.toHaveBeenCalled();
        expect(hydrate).toHaveBeenCalledWith(
            'history-plain',
            ACCOUNT_A_AUTHORITY,
        );
    });

    it('uses a per-session data key for data-key credentials and hydrates the canonical race winner', async () => {
        const encryption = createEncryptionFixture();
        const credentials: AuthCredentials = {
            token: 'token',
            encryption: { publicKey: 'public', machineKey: 'machine' },
        };
        const dataKey = new Uint8Array(32).map((_, index) => index + 1);
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body.encryptionMode).toBe('e2ee');
            expect(body.metadata).toBe(
                btoa(`sealed:${[...dataKey].join(',')}:${JSON.stringify({
                    systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                })}`),
            );
            expect(body.dataEncryptionKey).toBe(
                btoa(String.fromCharCode(...[...dataKey].reverse())),
            );
            return sessionResponse({
                id: 'history-race-winner',
                metadata: body.metadata,
                encryptionMode: 'e2ee',
                dataEncryptionKey: 'server-winner-envelope',
            });
        });
        const hydrate = vi.fn(async () => ({
            kind: 'available' as const,
            sessionId: 'history-race-winner',
        }));
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'e2ee' as const })),
            randomBytes: vi.fn(() => dataKey),
            request,
            hydrate,
            isScopeCurrent: vi.fn(() => true),
        });

        await expect(ensurer.ensure({
            scopeKey: 'server-a/account-a',
            credentials,
            encryption,
            serverBasis: SERVER_BASIS,
            authority: ACCOUNT_A_AUTHORITY,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
        })).resolves.toEqual({ sessionId: 'history-race-winner' });

        expect(encryption.openEncryption).toHaveBeenCalledWith(dataKey);
        expect(encryption.encryptEncryptionKey).toHaveBeenCalledWith(dataKey);
        expect(hydrate).toHaveBeenCalledWith(
            'history-race-winner',
            ACCOUNT_A_AUTHORITY,
        );
    });

    it('preserves legacy e2ee account encryption without inventing a session data key', async () => {
        const encryption = createEncryptionFixture();
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body).toMatchObject({
                encryptionMode: 'e2ee',
                dataEncryptionKey: null,
            });
            return sessionResponse({
                id: 'history-legacy-e2ee',
                metadata: body.metadata,
                encryptionMode: 'e2ee',
                dataEncryptionKey: null,
            });
        });
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'e2ee' as const })),
            randomBytes: vi.fn(() => new Uint8Array(32).fill(9)),
            request,
            hydrate: vi.fn(async (sessionId: string) => ({
                kind: 'available' as const,
                sessionId,
            })),
            isScopeCurrent: vi.fn(() => true),
        });

        await ensurer.ensure({
            scopeKey: 'server-a/account-a',
            credentials: { token: 'token', secret: 'legacy-secret' },
            encryption,
            serverBasis: SERVER_BASIS,
            authority: ACCOUNT_A_AUTHORITY,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
        });

        expect(encryption.openEncryption).toHaveBeenCalledWith(null);
        expect(encryption.encryptEncryptionKey).not.toHaveBeenCalled();
    });

    it('coalesces only concurrent acquisition and allows deletion followed by recreation', async () => {
        const encryption = createEncryptionFixture();
        let resolveFirst!: (response: Response) => void;
        const firstResponse = new Promise<Response>((resolve) => {
            resolveFirst = resolve;
        });
        const request = vi.fn()
            .mockImplementationOnce(async () => await firstResponse)
            .mockImplementationOnce(async (_path: string, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body));
                return sessionResponse({
                    id: 'history-recreated',
                    metadata: body.metadata,
                    encryptionMode: 'plain',
                    dataEncryptionKey: null,
                });
            });
        const hydrate = vi.fn(async (sessionId: string) => ({
            kind: 'available' as const,
            sessionId,
        }));
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'plain' as const })),
            randomBytes: vi.fn(() => new Uint8Array(32)),
            request,
            hydrate,
            isScopeCurrent: vi.fn(() => true),
        });
        const input = {
            scopeKey: 'server-a/account-a',
            credentials: { token: 'token', secret: 'secret' } as const,
            encryption,
            serverBasis: SERVER_BASIS,
            authority: ACCOUNT_A_AUTHORITY,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1 as const, key: 'voice_transcript_history', hidden: true },
            },
        };

        const first = ensurer.ensure(input);
        const concurrent = ensurer.ensure(input);
        await vi.waitFor(() => {
            expect(request).toHaveBeenCalledTimes(1);
        });
        resolveFirst(sessionResponse({
            id: 'history-original',
            metadata: JSON.stringify(input.metadata),
            encryptionMode: 'plain',
            dataEncryptionKey: null,
        }));
        await expect(Promise.all([first, concurrent])).resolves.toEqual([
            { sessionId: 'history-original' },
            { sessionId: 'history-original' },
        ]);

        await expect(ensurer.ensure(input)).resolves.toEqual({
            sessionId: 'history-recreated',
        });
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('rejects unavailable hydration and does not retain a failed acquisition', async () => {
        const encryption = createEncryptionFixture();
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            return sessionResponse({
                id: 'history-unavailable',
                metadata: body.metadata,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
            });
        });
        const hydrate = vi.fn()
            .mockResolvedValueOnce({
                kind: 'retryable_failure' as const,
                sessionId: 'history-unavailable',
                cause: 'server_unavailable' as const,
            })
            .mockResolvedValueOnce({
                kind: 'available' as const,
                sessionId: 'history-unavailable',
            });
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'plain' as const })),
            randomBytes: vi.fn(() => new Uint8Array(32)),
            request,
            hydrate,
            isScopeCurrent: vi.fn(() => true),
        });
        const input = {
            scopeKey: 'server-a/account-a',
            credentials: { token: 'token', secret: 'secret' } as const,
            encryption,
            serverBasis: SERVER_BASIS,
            authority: ACCOUNT_A_AUTHORITY,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1 as const, key: 'voice_transcript_history', hidden: true },
            },
        };

        await expect(ensurer.ensure(input)).rejects.toThrow('could not be hydrated');
        await expect(ensurer.ensure(input)).resolves.toEqual({
            sessionId: 'history-unavailable',
        });
        expect(request).toHaveBeenCalledTimes(2);
    });
});
