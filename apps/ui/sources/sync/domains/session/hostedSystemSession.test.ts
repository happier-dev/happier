import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeExternalActionRequestEnvelopeDigestV1, encodeTemplateBirthExecutionAuthorizationV1,
    TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    createSessionOwnerMetadataV1,
    openSessionOwnerDisplayEnvelopeV1,
    openSessionSharedDisplayEnvelopeV1,
    projectSessionSharedMetadataV1,
    SessionDisplayProjectionV1Schema,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { decodeBase64 } from '@/encryption/base64';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type {
    ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

import { createHostedSystemSessionEnsurer, createSessionCreateOrLoad, type SessionCreateOrLoadInput } from './hostedSystemSession';

const SERVER_BASIS = Object.freeze({ serverId: 'server-a', generation: 41 });
const ACCOUNT_A_AUTHORITY = {
    scope: { serverId: 'server-a', accountId: 'account-a' },
    context: { token: 'account-a-token' },
} as unknown as ServerAccountRequestAuthority;

function encodeBytes(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

function createDataKeyCredentials(token = 'token'): AuthCredentials {
    const contentKeyPair = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(12));
    return {
        token,
        encryption: {
            publicKey: encodeBytes(contentKeyPair.publicKey),
            machineKey: encodeBytes(contentKeyPair.secretKey),
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
    it('returns the server-selected row and refuses stale requester preparation', async () => {
        let current = true;
        const input = {
            credentials: { token: 'requester-token' }, accountMode: 'plain', encryption: null,
            tag: 'action:requester-creation', metadata: {},
            randomBytes: (length: number) => new Uint8Array(length),
            assertCurrent: () => { if (!current) throw new Error('scope_changed'); },
            request: async () => sessionResponse({ id: 'returned-session', metadata: '{}',
                ownerMetadata: plainOwnerEnvelope({ name: 'Retained row' }), encryptionMode: 'plain',
                dataEncryptionKey: null, created: false }),
        } satisfies SessionCreateOrLoadInput;
        const result = await createSessionCreateOrLoad(input);
        expect(result).toMatchObject({ disposition: 'rejoined', session: { id: 'returned-session',
            ownerMetadata: plainOwnerEnvelope({ name: 'Retained row' }), dataEncryptionKey: null } });
        await expect(createSessionCreateOrLoad({ ...input, request: async () => {
            current = false;
            return input.request();
        } })).rejects.toThrow('scope_changed');
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
                displayProjectionV1: {
                    v: 1,
                    sourceMetadataVersion: 0,
                    metadataLayoutVersion: 1,
                    shared: { t: 'plain', v: { v: 1, audience: 'shared', purpose: 'session_shared_display', display: { v: 1 } } },
                    owner: { t: 'plain', v: { v: 1, audience: 'owner', purpose: 'session_owner_display', display: { v: 1, hiddenSystemSession: true } } },
                },
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
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            const dataKey = encryption.encryptEncryptionKey.mock.calls[0]?.[0];
            expect(dataKey).toBeInstanceOf(Uint8Array);
            if (!dataKey) throw new Error('Expected canonical resource data key');
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
            randomBytes: vi.fn((length: number) => new Uint8Array(length).fill(8)),
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

        const dataKey = encryption.encryptEncryptionKey.mock.calls[0]?.[0];
        expect(dataKey).toBeInstanceOf(Uint8Array);
        expect(encryption.openEncryption).toHaveBeenCalledWith(dataKey);
        expect(hydrate).toHaveBeenCalledWith(
            'history-race-winner',
            ACCOUNT_A_AUTHORITY,
        );
    });

    it.each(['legacy', 'dataKey'] as const)('creates transferable fresh display envelopes for restored %s credentials without a Session ID', async (credentialType) => {
        const credentials = credentialType === 'legacy' ? createLegacyCredentials() : createDataKeyCredentials();
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const restoredEncryption = await createEncryptionFromAuthCredentials(credentials);
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(body.encryptionMode).toBe('e2ee');
            expect(body.dataEncryptionKey).toEqual(expect.any(String));
            const openedDataKey = await restoredEncryption.decryptEncryptionKey(
                body.dataEncryptionKey,
            );
            expect(openedDataKey).toBeInstanceOf(Uint8Array);
            expect(openedDataKey).toHaveLength(32);
            if (!openedDataKey) throw new Error('Expected the created Session content key');
            const display = SessionDisplayProjectionV1Schema.parse(body.displayProjectionV1);
            expect(display).toMatchObject({ sourceMetadataVersion: 0, metadataLayoutVersion: 1,
                shared: { t: 'encrypted' }, owner: { t: 'encrypted' } });
            const sessionEncryptor = await restoredEncryption.openEncryption(openedDataKey);
            expect(await openSessionSharedDisplayEnvelopeV1({
                sessionMode: 'e2ee', envelope: display.shared,
                decryptPayload: async (ciphertext) => (await sessionEncryptor
                    .decrypt([decodeBase64(ciphertext, 'base64')]))[0],
            })).toEqual({ ok: true, display: { v: 1, summaryText: 'Shared title' } });
            expect(openSessionOwnerDisplayEnvelopeV1({
                accountMode: 'e2ee', envelope: display.owner,
                material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
            })).toEqual({ ok: true, display: { v: 1, path: '/private/project', host: 'owner-host',
                homeDir: '/private/home', name: 'Private name', hiddenSystemSession: true } });
            expect(openSessionOwnerDisplayEnvelopeV1({
                accountMode: 'e2ee', envelope: display.owner,
                material: { type: 'legacy', secret: openedDataKey },
            })).toMatchObject({ ok: false });
            expect(body).not.toHaveProperty('sessionId');
            expect(body).not.toHaveProperty('id');
            return sessionResponse({
                id: 'history-legacy-e2ee',
                metadata: body.sharedMetadata.ciphertext,
                ownerMetadata: body.ownerMetadata,
                encryptionMode: 'e2ee',
                dataEncryptionKey: body.dataEncryptionKey,
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
            credentials,
            encryption,
            serverBasis: SERVER_BASIS,
            authority: ACCOUNT_A_AUTHORITY,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
                path: '/private/project', host: 'owner-host', homeDir: '/private/home', name: 'Private name',
                summary: { text: 'Shared title', updatedAt: 1 },
            },
        });

    });

    it('does not create an E2EE hosted session when the owner envelope cannot be sealed', async () => {
        const encryption = {
            ...createEncryptionFixture(),
            encryptEncryptionKey: vi.fn(async () => null),
        };
        const request = vi.fn();

        await expect(createSessionCreateOrLoad({
            credentials: createLegacyCredentials(),
            accountMode: 'e2ee',
            encryption,
            tag: 'system:voice-transcript-history:v1',
            metadata: {
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
            randomBytes: (length: number) => new Uint8Array(length).fill(9),
            request,
            assertCurrent: () => undefined,
        })).rejects.toThrow('Account encryption material is required');

        expect(encryption.openEncryption).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
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
        })).rejects.toThrow('Invalid Session create/load response');
        expect(hydrate).not.toHaveBeenCalled();
    });
});


it.each(['plain', 'e2ee'] as const)('carries the admitted template root and returns its committed birth authorization (%s)', async accountMode => {
        const tag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'browser-template-copy' });
        const originalActionEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'template-request',
            target: { kind: 'machine', machineId: 'asleep-machine' }, input: {} });
        // Home is the genuine boundary: this fixture supplies its typed issuer response.
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'issuer-root-token', binding: {
            accountId: 'requester-account', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_template',
            machineId: 'asleep-machine', custodianAccountId: 'requester-account', installationId: 'machine-installation',
            actionId: 'template.instantiate', requestId: originalActionEnvelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope), target: originalActionEnvelope.target,
        } });
        const bound = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, token: 'issuer-birth-token',
            binding: { ...authorization.binding, templateRequesterBirth: { sessionId: 'committed-bot', creationTag: tag } } });
        const delivered: unknown[] = [];
        let posted: unknown;
        const result = await createSessionCreateOrLoad({
            credentials: accountMode === 'plain' ? { token: 'requester-token' } : createDataKeyCredentials('requester-token'),
            accountMode, encryption: accountMode === 'e2ee' ? createEncryptionFixture() : null,
            tag, metadata: { name: 'My copy' }, randomBytes: length => new Uint8Array(length).fill(4), assertCurrent: () => {},
            templateRequesterAuthorization: { authorization, originalActionEnvelope },
            onCreationAuthorization: value => { delivered.push(value); },
            request: async (_path, init) => {
                const body = JSON.parse(String(init.body));
                posted = body.templateRequesterAuthorization;
                const response = sessionResponse({ id: 'committed-bot', metadata: body.sharedMetadata.ciphertext,
                    ownerMetadata: body.ownerMetadata, encryptionMode: accountMode, dataEncryptionKey: body.dataEncryptionKey });
                response.headers.set(TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1, encodeTemplateBirthExecutionAuthorizationV1(bound));
                return response;
            },
        });
        expect(posted).toEqual({ authorization, originalActionEnvelope });
        expect(delivered).toEqual([bound]);
        expect(result).toMatchObject({ disposition: 'created', session: { id: 'committed-bot', encryptionMode: accountMode } });
    });


it.each([{ accountMode: 'plain', recipientReady: false }, { accountMode: 'e2ee', recipientReady: false },
    { accountMode: 'e2ee', recipientReady: true }] as const)('preserves selected access, organization and Team binding on atomic browser birth ($accountMode/$recipientReady)', async ({ accountMode, recipientReady }) => {
    const credentials = accountMode === 'plain' ? { token: 'token' } : createDataKeyCredentials();
    const encryption = accountMode === 'plain' ? null : await createEncryptionFromAuthCredentials(credentials);
    const initialAccess = { grants: [{ subject: { kind: 'account' as const, accountId: 'recipient' }, accessLevel: 'view' as const, canApprovePermissions: false }] };
    const organizationPlacement = { folderId: 'folder', tagIds: ['tag'] };
    const recipient = tweetnacl.box.keyPair();
    const signing = tweetnacl.sign.keyPair();
    const calls: string[] = [];
    let posted: unknown;
    await createSessionCreateOrLoad({ credentials, accountMode, encryption, tag: 'selected-birth', metadata: { name: 'Bot' },
        initialAccess, primaryTeamId: 'team', organizationPlacement, teamCredentialBindings: [], manager: { sessionId: 'lead' },
        randomBytes: tweetnacl.randomBytes, assertCurrent: () => {},
        request: async (path, init) => {
            calls.push(path);
            if (path === '/v1/user/recipient') return Response.json({ user: { id: 'recipient', firstName: 'Recipient', lastName: null,
                avatar: null, username: 'recipient', bio: null, badges: [], status: 'none',
                publicKey: recipientReady ? [...signing.publicKey].map(value => value.toString(16).padStart(2, '0')).join('') : null,
                contentPublicKey: recipientReady ? encodeBytes(recipient.publicKey) : null,
                contentPublicKeySig: recipientReady ? encodeBytes(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey,
                    contentPublicKey: recipient.publicKey })) : null,
                recipientEnvelopeReadiness: recipientReady ? { status: 'available' } : { status: 'unavailable', reason: 'encryption_setup_required' } } });
            const body = JSON.parse(String(init.body)); posted = body;
            if (recipientReady) {
                const key = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(body.initialAccess.grants[0].accountEnvelopeInput.encryptedDataKey, 'base64'),
                    recipientSecretKeyOrSeed: recipient.secretKey });
                expect(key).toEqual(await encryption!.decryptEncryptionKey(body.dataEncryptionKey));
                const codec = await encryption!.openEncryption(key);
                const [shared] = await codec.decrypt([decodeBase64(body.sharedMetadata.ciphertext, 'base64')]);
                expect(shared).toMatchObject({ teamShareStatementV1: { v: 1, teamIds: ['team'] } });
            }
            return sessionResponse({ id: 'selected-bot', metadata: body.sharedMetadata.ciphertext, ownerMetadata: body.ownerMetadata,
                encryptionMode: accountMode, dataEncryptionKey: body.dataEncryptionKey });
        },
    });
    expect(posted).toMatchObject({ initialAccess, primaryTeamId: 'team', organizationPlacement, teamCredentialBindings: [], manager: { sessionId: 'lead' } });
    expect(calls).toEqual(accountMode === 'plain' ? ['/v1/sessions'] : ['/v1/user/recipient', '/v1/sessions']);
});
