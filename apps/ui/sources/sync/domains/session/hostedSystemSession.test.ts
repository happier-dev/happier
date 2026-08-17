import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    createSessionOwnerMetadataV1,
    projectSessionSharedMetadataV1,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { AccountStoredContentClientUpgradeRequiredError } from '@/sync/api/capabilities/accountStoredContentCompatibility';
import type {
    ServerAccountSessionRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';

import { createHostedSystemSessionEnsurer } from './hostedSystemSession';

const compatibilitySpies = vi.hoisted(() => ({
    requireCurrent: vi.fn(async () => undefined),
}));

vi.mock('@/sync/api/capabilities/accountStoredContentCompatibility', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/api/capabilities/accountStoredContentCompatibility')>()),
    requireCurrentAccountStoredContentServerCompatibility: compatibilitySpies.requireCurrent,
}));

const SERVER_BASIS = Object.freeze({ serverId: 'server-a', generation: 41 });
const ACCOUNT_A_AUTHORITY = {
    scope: { serverId: 'server-a', accountId: 'account-a' },
    context: { token: 'account-a-token' },
} as unknown as ServerAccountSessionRequestAuthority;

function encodeBytes(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

function createDataKeyCredentials(token = 'token'): AuthCredentials {
    return {
        token,
        encryption: {
            publicKey: encodeBytes(new Uint8Array(32).fill(11)),
            machineKey: encodeBytes(new Uint8Array(32).fill(12)),
        },
    };
}

function createLegacyCredentials(token = 'token'): AuthCredentials {
    return {
        token,
        secret: encodeBytes(new Uint8Array(32).fill(13)),
    };
}

function plainOwnerEnvelope(metadata: Readonly<Record<string, unknown>>) {
    const created = createSessionOwnerMetadataV1({ metadata });
    if (!created.ok) throw new Error('test metadata must be supported');
    return createPlainSessionOwnerMetadataEnvelopeV1(created.ownerMetadata);
}

function sessionResponse(input: Readonly<{
    id: string;
    metadata: string;
    ownerMetadata: unknown;
    encryptionMode: 'plain' | 'e2ee';
    dataEncryptionKey: string | null;
    created?: boolean;
}>): Response {
    return new Response(JSON.stringify({
        created: input.created ?? true,
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
            metadataLayoutVersion: 1,
            ownerMetadata: input.ownerMetadata,
            share: null,
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
    beforeEach(() => {
        compatibilitySpies.requireCurrent.mockReset();
        compatibilitySpies.requireCurrent.mockResolvedValue(undefined);
    });

    it('binds create/load dispatch to the captured account credential and server generation', async () => {
        const credentials = createDataKeyCredentials('account-a-token');
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
                metadata: body.sharedMetadata.ciphertext,
                ownerMetadata: body.ownerMetadata,
                encryptionMode: 'e2ee',
                dataEncryptionKey: body.dataEncryptionKey,
            });
        });
        const hydrate = vi.fn(async (sessionId: string) => ({
            kind: 'available' as const,
            sessionId,
        }));
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'e2ee' as const })),
            randomBytes: vi.fn((length: number) => new Uint8Array(length).fill(3)),
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
        expect(compatibilitySpies.requireCurrent).toHaveBeenCalledWith({
            serverId: 'server-a',
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
            const createdOwner = createSessionOwnerMetadataV1({
                metadata: {
                    systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                },
            });
            expect(createdOwner.ok).toBe(true);
            if (!createdOwner.ok) throw new Error('test metadata must be supported');
            expect(body).toEqual({
                tag: 'system:voice-transcript-history:v1',
                metadataLayoutVersion: 1,
                sharedMetadata: {
                    ciphertext: JSON.stringify(projectSessionSharedMetadataV1({
                        metadata: {
                            systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                        },
                        agentState: null,
                    })),
                },
                ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
                    createdOwner.ownerMetadata,
                ),
                agentState: null,
                dataEncryptionKey: null,
                encryptionMode: 'plain',
            });
            return sessionResponse({
                id: 'history-plain',
                metadata: body.sharedMetadata.ciphertext,
                ownerMetadata: body.ownerMetadata,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
            });
        });
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'plain' as const })),
            randomBytes: vi.fn((length: number) => new Uint8Array(length).fill(7)),
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
        const credentials = createDataKeyCredentials();
        const dataKey = new Uint8Array(32).map((_, index) => index + 1);
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body.encryptionMode).toBe('e2ee');
            expect(body.metadataLayoutVersion).toBe(1);
            expect(body.sharedMetadata).toEqual({
                ciphertext: btoa(`sealed:${[...dataKey].join(',')}:${JSON.stringify(
                    projectSessionSharedMetadataV1({
                        metadata: {
                            systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                        },
                        agentState: null,
                    }),
                )}`),
            });
            expect(body.ownerMetadata).toMatchObject({
                t: 'encrypted',
                c: expect.any(String),
            });
            expect(body.agentState).toBeNull();
            expect(body).not.toHaveProperty('metadata');
            expect(body.dataEncryptionKey).toBe(
                btoa(String.fromCharCode(...[...dataKey].reverse())),
            );
            return sessionResponse({
                id: 'history-race-winner',
                metadata: body.sharedMetadata.ciphertext,
                ownerMetadata: body.ownerMetadata,
                encryptionMode: 'e2ee',
                dataEncryptionKey: 'server-winner-envelope',
            });
        });
        const hydrate = vi.fn(async () => ({
            kind: 'available' as const,
            sessionId: 'history-race-winner',
        }));
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'e2ee' as const })),
            randomBytes: vi.fn((length: number) =>
                length === dataKey.length
                    ? dataKey
                    : new Uint8Array(length).fill(8)),
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
                metadata: body.sharedMetadata.ciphertext,
                ownerMetadata: body.ownerMetadata,
                encryptionMode: 'e2ee',
                dataEncryptionKey: null,
            });
        });
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'e2ee' as const })),
            randomBytes: vi.fn((length: number) => new Uint8Array(length).fill(9)),
            request,
            hydrate: vi.fn(async (sessionId: string) => ({
                kind: 'available' as const,
                sessionId,
            })),
            isScopeCurrent: vi.fn(() => true),
        });

        await ensurer.ensure({
            scopeKey: 'server-a/account-a',
            credentials: createLegacyCredentials(),
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

    it('loads a current layout-one session whose fixed transcript mode differs from Account mode', async () => {
        const hydrate = vi.fn(async () => ({
            kind: 'available' as const,
            sessionId: 'history-retained-e2ee',
        }));
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body.encryptionMode).toBe('plain');
            return sessionResponse({
                id: 'history-retained-e2ee',
                metadata: body.sharedMetadata.ciphertext,
                ownerMetadata: body.ownerMetadata,
                encryptionMode: 'e2ee',
                dataEncryptionKey: 'retained-session-key',
                created: false,
            });
        });
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'plain' as const })),
            randomBytes: vi.fn((length: number) => new Uint8Array(length)),
            request,
            hydrate,
            isScopeCurrent: vi.fn(() => true),
        });

        await expect(ensurer.ensure({
            scopeKey: 'server-a/account-a',
            credentials: { token: 'token' },
            encryption: null,
            serverBasis: SERVER_BASIS,
            authority: ACCOUNT_A_AUTHORITY,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
        })).resolves.toEqual({ sessionId: 'history-retained-e2ee' });
        expect(hydrate).toHaveBeenCalledWith(
            'history-retained-e2ee',
            ACCOUNT_A_AUTHORITY,
        );
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
                    metadata: body.sharedMetadata.ciphertext,
                    ownerMetadata: body.ownerMetadata,
                    encryptionMode: 'plain',
                    dataEncryptionKey: null,
                });
            });
        const hydrate = vi.fn(async (sessionId: string) => ({
            kind: 'available' as const,
            sessionId,
        }));
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'plain' as const })),
            randomBytes: vi.fn((length: number) => new Uint8Array(length)),
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
            metadata: JSON.stringify(projectSessionSharedMetadataV1({
                metadata: input.metadata,
                agentState: null,
            })),
            ownerMetadata: plainOwnerEnvelope(input.metadata),
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
                metadata: body.sharedMetadata.ciphertext,
                ownerMetadata: body.ownerMetadata,
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
            fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'plain' as const })),
            randomBytes: vi.fn((length: number) => new Uint8Array(length)),
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

    it.each(['missing', 'malformed', 'server-too-old'] as const)(
        'fails %s current-format admission before Account mode lookup or create POST', async (decision) => {
            const upgrade = new AccountStoredContentClientUpgradeRequiredError(
                decision,
            );
            compatibilitySpies.requireCurrent.mockRejectedValueOnce(upgrade);
            const fetchAccountEncryptionCurrentness = vi.fn(async () => ({ mode: 'plain' as const }));
            const request = vi.fn();
            const ensurer = createHostedSystemSessionEnsurer({
                fetchAccountEncryptionCurrentness,
                randomBytes: vi.fn((length: number) => new Uint8Array(length)),
                request,
                hydrate: vi.fn(),
                isScopeCurrent: vi.fn(() => true),
            });

            await expect(ensurer.ensure({
                scopeKey: 'server-a/account-a',
                credentials: { token: 'token' },
                encryption: null,
                serverBasis: SERVER_BASIS,
                authority: ACCOUNT_A_AUTHORITY,
                tag: 'system:voice-transcript-history:v1',
                metadata: {
                    systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                },
            })).rejects.toBe(upgrade);

            expect(fetchAccountEncryptionCurrentness).not.toHaveBeenCalled();
            expect(request).not.toHaveBeenCalled();
        },
    );

    it('does not relabel a current invalid-params 400 as an upgrade failure', async () => {
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'plain' as const })),
            randomBytes: vi.fn((length: number) => new Uint8Array(length)),
            request: vi.fn(async () => new Response(JSON.stringify({
                error: 'invalid-params',
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            })),
            hydrate: vi.fn(),
            isScopeCurrent: vi.fn(() => true),
        });

        await expect(ensurer.ensure({
            scopeKey: 'server-a/account-a',
            credentials: { token: 'token' },
            encryption: null,
            serverBasis: SERVER_BASIS,
            authority: ACCOUNT_A_AUTHORITY,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
        })).rejects.toEqual(expect.not.objectContaining({
            code: 'client-upgrade-required',
        }));
    });

    it('rejects a successful layout-zero create-or-load response before hydration', async () => {
        const hydrate = vi.fn();
        const ensurer = createHostedSystemSessionEnsurer({
            fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'plain' as const })),
            randomBytes: vi.fn((length: number) => new Uint8Array(length)),
            request: vi.fn(async () => new Response(JSON.stringify({
                created: false,
                session: {
                    id: 'legacy-layout-zero',
                    seq: 0,
                    createdAt: 10,
                    updatedAt: 10,
                    active: false,
                    activeAt: 10,
                    encryptionMode: 'plain',
                    metadata: '{}',
                    metadataVersion: 0,
                    agentState: null,
                    agentStateVersion: 0,
                    dataEncryptionKey: null,
                },
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })),
            hydrate,
            isScopeCurrent: vi.fn(() => true),
        });

        await expect(ensurer.ensure({
            scopeKey: 'server-a/account-a',
            credentials: { token: 'token' },
            encryption: null,
            serverBasis: SERVER_BASIS,
            authority: ACCOUNT_A_AUTHORITY,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
        })).rejects.toThrow('Invalid hosted system session create/load response');
        expect(hydrate).not.toHaveBeenCalled();
    });
});
