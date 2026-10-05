import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

const MANAGER_CONTENT_KEYS = tweetnacl.box.keyPair();

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
});

async function setup(options?: Readonly<{ accountEncryption?: 'plain' | 'e2ee' }>) {
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `follow-${crypto.randomUUID()}`);
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    const active = await upsertAndActivateServer({ serverUrl: 'https://active.example', name: 'Active' });
    const target = await upsertServerProfile({ serverUrl: 'https://target.example', name: 'Target' });
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().activateProfileScope({ serverId: active.id, accountId: 'active-account' });
    storage.setState({ settingsScope: { serverId: target.id, accountId: 'target-account' } });
    const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { encodeBase64 } = await import('@/encryption/base64');
    // Persistent credentials and the network are the only replaced boundaries.
    const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url) => ({
        token: token(url === 'https://target.example' ? 'target-account' : 'active-account'),
        ...(options?.accountEncryption === 'e2ee' ? {
            encryption: {
                publicKey: encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
                machineKey: encodeBase64(MANAGER_CONTENT_KEYS.secretKey, 'base64'),
            },
        } : {}),
    }));
    const request = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
        const path = new URL(url).pathname;
        if (path.includes('/v1/account/encryption')) return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
        return new Response(JSON.stringify({ sources: [] }), { status: 200 });
    });
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/auth/ping') return new Response('{}', { status: 200 });
        // The shared Action front door reads the Account's own settings before it
        // dispatches. That is front-door lifecycle, not this transport's contract,
        // so it is answered here rather than in every per-test route table.
        if (path === '/v2/account/settings') return new Response(JSON.stringify({ content: null, version: 0 }));
        return request(String(url), init);
    });
    return { target, request, credentials, token, storage, active, TokenStorage };
}

describe('Session access exact Account transport', () => {
    it('uses the descriptor transport for explicit Team context changes', async () => {
        const env = await setup();
        const { executeSessionAccessHttpAction } = await import('./sessionAccessApi');
        const result = { changed: true, primaryTeamId: 'team-1' };
        env.request.mockImplementation(async () => new Response(JSON.stringify(result), { status: 200 }));
        await expect(executeSessionAccessHttpAction({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available', actionId: 'session.access.context.set',
            input: { sessionId: 'same/id', primaryTeamId: 'team-1' },
        })).resolves.toEqual(result);
        const call = env.request.mock.calls.find(([url]) => url.includes('/access-context/'));
        expect(call?.[0]).toBe('https://target.example/v2/sessions/access-context/set');
        expect(JSON.parse(String(call?.[1]?.body))).toEqual({ sessionId: 'same/id', primaryTeamId: 'team-1' });
    });

    it('uses the requested Account and descriptor transport, preserving the strict grant result', async () => {
        const env = await setup();
        const { executeSessionAccessHttpAction } = await import('./sessionAccessApi');
        const subject = { kind: 'account', accountId: 'recipient' };
        const grant = { subject, accessLevel: 'edit', canApprovePermissions: false };
        env.request.mockImplementation(async (url) => {
            const path = new URL(url).pathname;
            if (path === '/v2/sessions/same%2Fid') return new Response(JSON.stringify({ session: {
                id: 'same/id', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                encryptionMode: 'plain', dataEncryptionKey: null,
                metadataLayoutVersion: 0, metadataVersion: 1, metadata: '',
                agentStateVersion: 1, agentState: null, share: null,
            } }));
            if (path.endsWith('/turns')) return new Response('{}', { status: 404 });
            if (path === '/v2/sessions/access-grants/set') {
                return new Response(JSON.stringify({ changed: true, grant }));
            }
            throw new Error(`Plain grant unexpectedly requested ${path}`);
        });
        await expect(executeSessionAccessHttpAction({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available', actionId: 'session.access.grant.set',
            input: { sessionId: 'same/id', ...grant },
        })).resolves.toEqual({ changed: true, grant });
        const call = env.request.mock.calls.find(([url]) => url.includes('/access-grants/'));
        expect(call?.[0]).toBe('https://target.example/v2/sessions/access-grants/set');
        expect(JSON.parse(String(call?.[1]?.body))).toEqual({ sessionId: 'same/id', ...grant });
        expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe(`Bearer ${env.token('target-account')}`);
        expect(env.request.mock.calls.map(([url]) => new URL(url).pathname)).not.toContain('/v1/account/encryption');
    });

    it('materializes the mounted logical Action into a physical envelope the recipient can open', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { createSessionAccessClient } = await import('./sessionAccessApi');
        const { encodeBase64, decodeBase64 } = await import('@/encryption/base64');
        const { encodeHex } = await import('@/encryption/hex');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { openEncryptedDataKeyEnvelopeV1, signAccountContentKeyBindingV1 } = await import('@happier-dev/protocol');
        const sessionDataKey = new Uint8Array(32).fill(11);
        const callerEnvelope = encryptDataKeyForRecipientV0(
            sessionDataKey,
            encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
        );
        const recipient = { content: tweetnacl.box.keyPair(), signing: tweetnacl.sign.keyPair() };
        const contentPublicKey = encodeBase64(recipient.content.publicKey, 'base64');
        let physicalBody: Record<string, unknown> | null = null;
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption') return new Response(JSON.stringify({
                mode: 'e2ee', updatedAt: 1,
            }));
            if (path === '/v2/sessions/same') return new Response(JSON.stringify({ session: {
                id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                encryptionMode: 'e2ee', dataEncryptionKey: callerEnvelope,
                metadataLayoutVersion: 0, metadataVersion: 1, metadata: 'sealed',
                agentStateVersion: 1, agentState: null, share: null,
            } }));
            if (path.endsWith('/turns')) return new Response('{}', { status: 404 });
            if (path === '/v1/user/recipient') return new Response(JSON.stringify({ user: {
                id: 'recipient', firstName: 'Recipient', lastName: null, avatar: null,
                username: 'recipient', bio: null, badges: [], status: 'friend',
                recipientEnvelopeReadiness: { status: 'available' },
                publicKey: encodeHex(recipient.signing.publicKey),
                contentPublicKey,
                contentPublicKeySig: encodeBase64(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: recipient.signing.secretKey,
                    contentPublicKey: recipient.content.publicKey,
                }), 'base64'),
            } }));
            if (path === '/v2/sessions/access-grants/set') {
                physicalBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
                return new Response(JSON.stringify({
                    changed: true,
                    grant: {
                        subject: { kind: 'account', accountId: 'recipient' },
                        accessLevel: 'edit',
                        canApprovePermissions: false,
                    },
                }));
            }
            throw new Error(`Unexpected path ${path}`);
        });

        const logicalGrant = {
            subject: { kind: 'account' as const, accountId: 'recipient' },
            accessLevel: 'edit' as const,
            canApprovePermissions: false,
        };
        await expect(createSessionAccessClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same',
            availability: 'available',
        }).set(logicalGrant)).resolves.toMatchObject({ changed: true });

        expect(logicalGrant).not.toHaveProperty('accountEnvelopeInput');
        const encryptedDataKey = (
            physicalBody as {
                accountEnvelopeInput: { encryptedDataKey: string };
            } | null
        )?.accountEnvelopeInput.encryptedDataKey;
        expect(encryptedDataKey).toEqual(expect.any(String));
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(encryptedDataKey!),
            recipientSecretKeyOrSeed: recipient.content.secretKey,
        })).toEqual(sessionDataKey);
    });

    it('does not submit a direct-recipient envelope after the Account encryption generation changes while opening the Session DEK', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { Encryption } = await import('@/sync/encryption/encryption');
        const originalDecryptEncryptionKey = Encryption.prototype.decryptEncryptionKey;
        vi.spyOn(Encryption.prototype, 'decryptEncryptionKey').mockImplementation(async function (this: typeof Encryption.prototype, encrypted, scope) {
            const opened = await originalDecryptEncryptionKey.call(this, encrypted, scope);
            const captured = this.getCurrentEncryptionGenerationScope({ serverId: env.target.id });
            this.configureNativeCryptoWorker({
                scope: {
                    accountId: captured.accountId,
                    serverId: captured.serverId,
                    generation: captured.generation + 1,
                },
            });
            return opened;
        });

        const { createSessionAccessClient } = await import('./sessionAccessApi');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { encodeHex } = await import('@/encryption/hex');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { signAccountContentKeyBindingV1 } = await import('@happier-dev/protocol');
        const sessionDataKey = new Uint8Array(32).fill(11);
        const callerEnvelope = encryptDataKeyForRecipientV0(
            sessionDataKey,
            encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
        );
        const recipient = { content: tweetnacl.box.keyPair(), signing: tweetnacl.sign.keyPair() };
        let mutationCalls = 0;
        env.request.mockImplementation(async (url) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption') return new Response(JSON.stringify({
                mode: 'e2ee', updatedAt: 1,
            }));
            if (path === '/v2/sessions/same') return new Response(JSON.stringify({ session: {
                id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                encryptionMode: 'e2ee', dataEncryptionKey: callerEnvelope,
                metadataLayoutVersion: 0, metadataVersion: 1, metadata: 'sealed',
                agentStateVersion: 1, agentState: null, share: null,
            } }));
            if (path.endsWith('/turns')) return new Response('{}', { status: 404 });
            if (path === '/v1/user/recipient') return new Response(JSON.stringify({ user: {
                id: 'recipient', firstName: 'Recipient', lastName: null, avatar: null,
                username: 'recipient', bio: null, badges: [], status: 'friend',
                recipientEnvelopeReadiness: { status: 'available' },
                publicKey: encodeHex(recipient.signing.publicKey),
                contentPublicKey: encodeBase64(recipient.content.publicKey, 'base64'),
                contentPublicKeySig: encodeBase64(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: recipient.signing.secretKey,
                    contentPublicKey: recipient.content.publicKey,
                }), 'base64'),
            } }));
            if (path === '/v2/sessions/access-grants/set') {
                mutationCalls += 1;
                return new Response('{}');
            }
            throw new Error(`Unexpected path ${path}`);
        });

        await expect(createSessionAccessClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same',
            availability: 'available',
        }).set({
            subject: { kind: 'account', accountId: 'recipient' },
            accessLevel: 'edit',
            canApprovePermissions: false,
        })).rejects.toMatchObject({ code: 'session_access_stale_scope' });
        expect(mutationCalls).toBe(0);
    });

    it('does not bless a Session snapshot fetched across an Account encryption generation change', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { Encryption } = await import('@/sync/encryption/encryption');
        const originalCreate = Encryption.createFromContentKeyPair;
        let managerEncryption: typeof Encryption.prototype | null = null;
        vi.spyOn(Encryption, 'createFromContentKeyPair').mockImplementation(async (params) => {
            managerEncryption = await originalCreate(params);
            return managerEncryption;
        });

        const { createSessionAccessClient } = await import('./sessionAccessApi');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { encodeHex } = await import('@/encryption/hex');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { signAccountContentKeyBindingV1 } = await import('@happier-dev/protocol');
        const sessionDataKey = new Uint8Array(32).fill(14);
        const callerEnvelope = encryptDataKeyForRecipientV0(
            sessionDataKey,
            encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
        );
        const recipient = { content: tweetnacl.box.keyPair(), signing: tweetnacl.sign.keyPair() };
        let mutationCalls = 0;
        env.request.mockImplementation(async (url) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }));
            if (path === '/v2/sessions/same') {
                const encryption = managerEncryption;
                if (!encryption) throw new Error('Expected Account encryption context before Session fetch');
                const captured = encryption.getCurrentEncryptionGenerationScope({ serverId: env.target.id });
                encryption.configureNativeCryptoWorker({
                    scope: {
                        accountId: captured.accountId,
                        serverId: captured.serverId,
                        generation: captured.generation + 1,
                    },
                });
                return new Response(JSON.stringify({ session: {
                    id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                    encryptionMode: 'e2ee', dataEncryptionKey: callerEnvelope,
                    metadataLayoutVersion: 0, metadataVersion: 1, metadata: 'sealed',
                    agentStateVersion: 1, agentState: null, share: null,
                } }));
            }
            if (path.endsWith('/turns')) return new Response('{}', { status: 404 });
            if (path === '/v1/user/recipient') return new Response(JSON.stringify({ user: {
                id: 'recipient', firstName: 'Recipient', lastName: null, avatar: null,
                username: 'recipient', bio: null, badges: [], status: 'friend',
                recipientEnvelopeReadiness: { status: 'available' },
                publicKey: encodeHex(recipient.signing.publicKey),
                contentPublicKey: encodeBase64(recipient.content.publicKey, 'base64'),
                contentPublicKeySig: encodeBase64(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: recipient.signing.secretKey,
                    contentPublicKey: recipient.content.publicKey,
                }), 'base64'),
            } }));
            if (path === '/v2/sessions/access-grants/set') {
                mutationCalls += 1;
                return new Response('{}');
            }
            throw new Error(`Unexpected path ${path}`);
        });

        await expect(createSessionAccessClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same',
            availability: 'available',
        }).set({
            subject: { kind: 'account', accountId: 'recipient' },
            accessLevel: 'edit',
            canApprovePermissions: false,
        })).rejects.toMatchObject({ code: 'session_access_stale_scope' });
        expect(mutationCalls).toBe(0);
    });

    it('rechecks Account encryption after sealing and before starting the grant mutation', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { Encryption } = await import('@/sync/encryption/encryption');
        const directShare = await import('@/sync/encryption/directShareEncryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { encodeHex } = await import('@/encryption/hex');
        const { signAccountContentKeyBindingV1 } = await import('@happier-dev/protocol');
        const sessionDataKey = new Uint8Array(32).fill(21);
        const callerEnvelope = directShare.encryptDataKeyForRecipientV0(
            sessionDataKey,
            encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
        );
        const recipient = { content: tweetnacl.box.keyPair(), signing: tweetnacl.sign.keyPair() };
        const originalCreate = Encryption.createFromContentKeyPair;
        let managerEncryption: typeof Encryption.prototype | null = null;
        vi.spyOn(Encryption, 'createFromContentKeyPair').mockImplementation(async params => {
            managerEncryption = await originalCreate(params);
            return managerEncryption;
        });
        const originalSeal = directShare.encryptDataKeyForRecipientV0;
        vi.spyOn(directShare, 'encryptDataKeyForRecipientV0').mockImplementation((dataKey, publicKey) => {
            const envelope = originalSeal(dataKey, publicKey);
            queueMicrotask(() => {
                const encryption = managerEncryption;
                if (!encryption) return;
                const captured = encryption.getCurrentEncryptionGenerationScope({ serverId: env.target.id });
                encryption.configureNativeCryptoWorker({ scope: { ...captured, generation: captured.generation + 1 } });
            });
            return envelope;
        });
        const { createSessionAccessClient } = await import('./sessionAccessApi');

        let mutationCalls = 0;
        env.request.mockImplementation(async (url) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }));
            if (path === '/v2/sessions/same') return new Response(JSON.stringify({ session: {
                id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                encryptionMode: 'e2ee', dataEncryptionKey: callerEnvelope,
                metadataLayoutVersion: 0, metadataVersion: 1, metadata: 'sealed',
                agentStateVersion: 1, agentState: null, share: null,
            } }));
            if (path.endsWith('/turns')) return new Response('{}', { status: 404 });
            if (path === '/v1/user/recipient') return new Response(JSON.stringify({ user: {
                id: 'recipient', firstName: 'Recipient', lastName: null, avatar: null,
                username: 'recipient', bio: null, badges: [], status: 'friend',
                recipientEnvelopeReadiness: { status: 'available' },
                publicKey: encodeHex(recipient.signing.publicKey),
                contentPublicKey: encodeBase64(recipient.content.publicKey, 'base64'),
                contentPublicKeySig: encodeBase64(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: recipient.signing.secretKey,
                    contentPublicKey: recipient.content.publicKey,
                }), 'base64'),
            } }));
            if (path === '/v2/sessions/access-grants/set') {
                mutationCalls += 1;
                return new Response('{}');
            }
            throw new Error(`Unexpected path ${path}`);
        });

        await expect(createSessionAccessClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same',
            availability: 'available',
        }).set({
            subject: { kind: 'account', accountId: 'recipient' },
            accessLevel: 'edit',
            canApprovePermissions: false,
        })).rejects.toMatchObject({ code: 'session_access_stale_scope' });
        expect(mutationCalls).toBe(0);
    });

    it('lets the canonical route reuse a retained recipient envelope when this host cannot reopen the Session DEK', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { createSessionAccessClient } = await import('./sessionAccessApi');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { encodeHex } = await import('@/encryption/hex');
        const { signAccountContentKeyBindingV1 } = await import('@happier-dev/protocol');
        const recipient = { content: tweetnacl.box.keyPair(), signing: tweetnacl.sign.keyPair() };
        const grant = {
            subject: { kind: 'account' as const, accountId: 'recipient' },
            accessLevel: 'view' as const,
            canApprovePermissions: false,
        };
        const physicalBodies: unknown[] = [];
        const requestOrigins: string[] = [];
        let retainedTupleState: 'valid' | 'missing' | 'invalid' | 'other_error' = 'valid';
        env.request.mockImplementation(async (url, init) => {
            const parsedUrl = new URL(url);
            requestOrigins.push(parsedUrl.origin);
            const path = parsedUrl.pathname;
            if (path === '/v1/account/encryption') return new Response(JSON.stringify({
                mode: 'e2ee', updatedAt: 1,
            }));
            if (path === '/v2/sessions/same') return new Response(JSON.stringify({ session: {
                id: 'same', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                encryptionMode: 'e2ee', dataEncryptionKey: null,
                metadataLayoutVersion: 0, metadataVersion: 1, metadata: 'sealed',
                agentStateVersion: 1, agentState: null, share: null,
            } }));
            if (path.endsWith('/turns')) return new Response('{}', { status: 404 });
            if (path === '/v1/user/recipient') return new Response(JSON.stringify({ user: {
                id: 'recipient', firstName: 'Recipient', lastName: null, avatar: null,
                username: 'recipient', bio: null, badges: [], status: 'friend',
                recipientEnvelopeReadiness: { status: 'available' },
                publicKey: encodeHex(recipient.signing.publicKey),
                contentPublicKey: encodeBase64(recipient.content.publicKey, 'base64'),
                contentPublicKeySig: encodeBase64(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: recipient.signing.secretKey,
                    contentPublicKey: recipient.content.publicKey,
                }), 'base64'),
            } }));
            if (path === '/v2/sessions/access-grants/set') {
                physicalBodies.push(JSON.parse(String(init?.body)));
                if (retainedTupleState === 'valid') return new Response(JSON.stringify({ changed: true, grant }));
                return new Response(JSON.stringify({
                    error: retainedTupleState === 'other_error'
                        ? 'recipient_key_unavailable'
                        : 'recipient_envelope_required',
                }), { status: 400 });
            }
            throw new Error(`Unexpected path ${path}`);
        });

        await expect(createSessionAccessClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same',
            availability: 'available',
        }).set(grant)).resolves.toMatchObject({ changed: true });

        expect(physicalBodies).toEqual([{ sessionId: 'same', ...grant }]);
        retainedTupleState = 'missing';
        await expect(createSessionAccessClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same',
            availability: 'available',
        }).set(grant)).rejects.toMatchObject({ code: 'session_data_key_unavailable' });
        retainedTupleState = 'invalid';
        await expect(createSessionAccessClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same',
            availability: 'available',
        }).set(grant)).rejects.toMatchObject({ code: 'session_data_key_unavailable' });
        retainedTupleState = 'other_error';
        await expect(createSessionAccessClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same',
            availability: 'available',
        }).set(grant)).rejects.toMatchObject({ code: 'recipient_key_unavailable' });
        expect(physicalBodies).toEqual([
            { sessionId: 'same', ...grant },
            { sessionId: 'same', ...grant },
            { sessionId: 'same', ...grant },
            { sessionId: 'same', ...grant },
        ]);
        expect(new Set(requestOrigins)).toEqual(new Set(['https://target.example']));
        expect(env.request.mock.calls
            .filter(([url]) => new URL(url).pathname === '/v2/sessions/access-grants/set')
            .every(([url]) => new URL(url).origin === 'https://target.example')).toBe(true);
    });

    it('trusts Plain, setup-pending, and inconsistent recipient readiness for an E2EE direct grant', async () => {
        const env = await setup();
        const { executeSessionAccessHttpAction } = await import('./sessionAccessApi');
        const subject = { kind: 'account' as const, accountId: 'recipient' };
        const grant = { subject, accessLevel: 'view' as const, canApprovePermissions: false };
        const physicalBodies: unknown[] = [];
        let recipientReadiness: unknown = { status: 'unavailable', reason: 'plain_account' };
        let recipientRequestFails = false;
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption') {
                return new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }));
            }
            if (path === '/v2/sessions/access-grants/list') {
                return new Response(JSON.stringify({
                    visibility: 'complete',
                    owner: { kind: 'account', accountId: 'target-account', firstName: 'Owner', lastName: null, username: 'owner', avatarUrl: null },
                    primaryTeamId: null,
                    grants: [],
                    effectiveAccess: {
                        v: 1,
                        level: 'owner',
                        sources: [{ kind: 'owner' }],
                        capabilities: {
                            readTranscript: true, submitAgentInput: true, editSessionRecords: true,
                            approveRuntimePermissions: true, manageAccess: true,
                            managePermissionDelegation: true, managePublicLink: true,
                            archiveSession: true, renameSession: true, assignResponsibility: true,
                            stopSession: true, deleteSession: true,
                        },
                    },
                }));
            }
            if (path === '/v2/sessions/same%2Fid') {
                return new Response(JSON.stringify({ session: {
                    id: 'same/id', createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                    encryptionMode: 'e2ee', dataEncryptionKey: 'retained-owner-envelope',
                    metadataLayoutVersion: 0, metadataVersion: 1, metadata: '',
                    agentStateVersion: 1, agentState: null, share: null,
                } }));
            }
            if (path.endsWith('/turns')) return new Response('{}', { status: 404 });
            if (path === '/v1/user/recipient') {
                if (recipientRequestFails) return new Response('{}', { status: 503 });
                return new Response(JSON.stringify({ user: {
                    id: 'recipient', firstName: 'Recipient', lastName: null, avatar: null,
                    username: 'recipient', bio: null, badges: [], status: 'friend',
                    recipientEnvelopeReadiness: recipientReadiness,
                    publicKey: '00'.repeat(32),
                    contentPublicKey: 'BQ'.padEnd(44, '='),
                    contentPublicKeySig: 'Bg'.padEnd(88, '='),
                } }));
            }
            if (path === '/v2/sessions/access-grants/set') {
                physicalBodies.push(JSON.parse(String(init?.body)));
                return new Response(JSON.stringify({ changed: true, grant }));
            }
            throw new Error(`Unexpected path ${path}`);
        });

        await expect(executeSessionAccessHttpAction({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available',
            actionId: 'session.access.grant.set',
            input: { sessionId: 'same/id', ...grant },
        })).resolves.toEqual({ changed: true, grant });
        recipientReadiness = { status: 'unavailable', reason: 'encryption_setup_required' };
        await expect(executeSessionAccessHttpAction({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available',
            actionId: 'session.access.grant.set',
            input: { sessionId: 'same/id', ...grant },
        })).resolves.toEqual({ changed: true, grant });
        recipientReadiness = { status: 'unavailable', reason: 'encryption_inconsistent' };
        await expect(executeSessionAccessHttpAction({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available',
            actionId: 'session.access.grant.set',
            input: { sessionId: 'same/id', ...grant },
        })).resolves.toEqual({ changed: true, grant });
        // Only a strict authoritative unavailable state permits key-free admission.
        // Missing/malformed readiness, invalid advertised-ready binding and transport
        // failure must not turn into another successful pending grant.
        for (const [readiness, code] of [
            [undefined, 'unsupported_action'],
            [{ status: 'unavailable', reason: 'unknown' }, 'unsupported_action'],
            [{ status: 'available' }, 'session_access_invalid_recipient_envelope'],
        ] as const) {
            recipientReadiness = readiness;
            await expect(executeSessionAccessHttpAction({
                scope: { serverId: env.target.id, accountId: 'target-account' },
                availability: 'available',
                actionId: 'session.access.grant.set',
                input: { sessionId: 'same/id', ...grant },
            })).rejects.toMatchObject({ code });
        }
        recipientReadiness = { status: 'unavailable', reason: 'encryption_inconsistent' };
        recipientRequestFails = true;
        await expect(executeSessionAccessHttpAction({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available',
            actionId: 'session.access.grant.set',
            input: { sessionId: 'same/id', ...grant },
        })).rejects.toMatchObject({ code: 'session_access_request_failed', status: 503 });
        expect(physicalBodies).toEqual([
            { sessionId: 'same/id', ...grant },
            { sessionId: 'same/id', ...grant },
            { sessionId: 'same/id', ...grant },
        ]);
    });

    it('publishes a public link through the declared Action transport at the exact Home', async () => {
        const env = await setup();
        const { createSessionAccessClient } = await import('./sessionAccessApi');
        const bodies: Array<Record<string, unknown>> = [];
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
            if (path === '/v2/sessions/same') return new Response(JSON.stringify({ session: {
                id: 'same', createdAt: 1, updatedAt: 2, seq: 0, active: true, activeAt: 2,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1, metadata: '{}',
                agentStateVersion: 1, agentState: null, share: null,
            } }));
            if (path.endsWith('/turns')) return new Response('{}', { status: 404 });
            if (path === '/v1/public-shares') {
                if (init?.method === 'POST') {
                    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
                    return new Response(JSON.stringify({ publicShare: {
                        id: 'publication', sessionId: 'same', expiresAt: null, maxUses: 4,
                        useCount: 0, isConsentRequired: true, createdAt: 1, updatedAt: 5,
                        keyDerivation: 'fragment_v1',
                    }, isolatedOrigin: 'https://public.example' }));
                }
            }
            if (path === '/v1/sessions/same/public-share') {
                if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true }));
                return new Response(JSON.stringify({ publicShare: null }));
            }
            throw new Error(`Unexpected path ${path}`);
        });

        // Publication has its own released decision, so a Home without gated
        // collaboration must still reach it.
        const client = createSessionAccessClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same',
            availability: 'unavailable',
        });
        await expect(client.getPublicLink()).resolves.toBeNull();
        await expect(client.createPublicLink({ maxUses: 4, isConsentRequired: true })).resolves.toEqual({
            id: 'publication', expiresAt: null, maxUses: 4, useCount: 0, isConsentRequired: true, updatedAt: 5,
            keyDerivation: 'fragment_v1', isolatedOrigin: 'https://public.example',
            url: expect.stringMatching(/^https:\/\/public.example\/s\/[^#]+#k=.+$/),
        });
        await expect(client.removePublicLink()).resolves.toEqual({ changed: true });

        // The public Action input is secret-free; only this trusted host adds
        // the independent lookup, and a plain Session carries no wrapped key.
        expect(bodies).toHaveLength(1);
        // `sessionId` is a declared path parameter, so the descriptor binder consumes
        // it into the URL and it must not be duplicated into the released body.
        expect(env.request.mock.calls.some(([url, init]) =>
            new URL(url).pathname === '/v1/public-shares' && init?.method === 'POST')).toBe(true);
        expect(bodies[0]).not.toHaveProperty('sessionId');
        expect(bodies[0]).toHaveProperty('subject', { kind: 'session', id: 'same' });
        expect(bodies[0]).toMatchObject({ maxUses: 4, isConsentRequired: true });
        expect(String(bodies[0]!.lookupId)).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(bodies[0]).toHaveProperty('keyDerivation', 'fragment_v1');
        expect(bodies[0]).not.toHaveProperty('token');
        expect(bodies[0]).not.toHaveProperty('encryptedDataKey');
        expect(env.request.mock.calls.every(([url]) => new URL(url).origin === 'https://target.example')).toBe(true);
    });

    it('replays one lost public-link create with the identical physical body', async () => {
        const env = await setup();
        const { createSessionAccessClient } = await import('./sessionAccessApi');
        const bodies: string[] = [];
        let sessionReads = 0;
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
            if (path === '/v2/sessions/same') {
                sessionReads += 1;
                return new Response(JSON.stringify({ session: {
                    id: 'same', createdAt: 1, updatedAt: 2, seq: 0, active: true, activeAt: 2,
                    encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1, metadata: '{}',
                    agentStateVersion: 1, agentState: null, share: null,
                } }));
            }
            if (path.endsWith('/turns')) return new Response('{}', { status: 404 });
            if (path === '/v1/public-shares') {
                bodies.push(String(init?.body));
                if (bodies.length === 1) throw new TypeError('response lost after dispatch');
                return new Response(JSON.stringify({ publicShare: {
                    id: 'publication', expiresAt: null, maxUses: null, useCount: 0,
                    isConsentRequired: false, createdAt: 1, updatedAt: 2,
                    keyDerivation: 'fragment_v1',
                }, isolatedOrigin: 'https://public.example' }));
            }
            throw new Error(`Unexpected path ${path}`);
        });

        await expect(createSessionAccessClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            sessionId: 'same',
            availability: 'available',
            onPublicLinkIssued: () => {},
        }).createPublicLink({ isConsentRequired: false })).resolves.toMatchObject({ id: 'publication' });

        expect(sessionReads).toBe(1);
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toBe(bodies[0]);
    });

    it('separates a pre-dispatch cancellation from a lost publication response', async () => {
        const env = await setup();
        const { executeSessionAccessHttpAction, SessionAccessApiError } = await import('./sessionAccessApi');
        const aborted = new AbortController();
        aborted.abort();
        await expect(executeSessionAccessHttpAction({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available',
            actionId: 'session.public_link.remove',
            input: { sessionId: 'same' },
            signal: aborted.signal,
        })).rejects.toMatchObject({ code: 'cancelled' });
        expect(env.request).not.toHaveBeenCalled();

        // A 2xx acknowledgement this host cannot use leaves the committed
        // outcome unproven; the mutation is never replayed or inverted.
        env.request.mockImplementation(async () => new Response('not json', { status: 200 }));
        await expect(executeSessionAccessHttpAction({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available',
            actionId: 'session.public_link.remove',
            input: { sessionId: 'same' },
        })).rejects.toMatchObject({ code: 'outcome_unknown' });
        expect(env.request.mock.calls).toHaveLength(1);
    });

    it('treats an already-absent publication as the settled desired state and keeps typed refusals', async () => {
        const env = await setup();
        const { executeSessionAccessHttpAction } = await import('./sessionAccessApi');
        const request = {
            scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available' as const,
            actionId: 'session.public_link.remove' as const,
            input: { sessionId: 'same' },
        };
        env.request.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Share not found' }), { status: 404 }));
        await expect(executeSessionAccessHttpAction(request)).resolves.toEqual({ changed: false });

        env.request.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));
        await expect(executeSessionAccessHttpAction(request)).rejects.toMatchObject({ code: 'session_access_sharing_unavailable' });

        env.request.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'session_access_forbidden' }), { status: 403 }));
        await expect(executeSessionAccessHttpAction(request)).rejects.toMatchObject({ code: 'session_access_forbidden' });
    });

    it('rejects stale Accounts before mutation and never falls back after a current route error', async () => {
        const env = await setup();
        const { executeSessionAccessHttpAction } = await import('./sessionAccessApi');
        const args = { scope: { serverId: env.target.id, accountId: 'wrong-account' },
            availability: 'available' as const, actionId: 'session.access.grants.list' as const,
            input: { sessionId: 'same' } };
        await expect(executeSessionAccessHttpAction(args)).rejects.toThrow();
        expect(env.request).not.toHaveBeenCalled();
        env.request.mockImplementation(async () => new Response(JSON.stringify({ error: 'session_access_forbidden' }), { status: 403 }));
        await expect(executeSessionAccessHttpAction({ ...args, scope: { ...args.scope, accountId: 'target-account' } })).rejects.toMatchObject({ code: 'session_access_forbidden', status: 403 });
        expect(env.request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/v2/sessions/access-grants/list']);
    });

    it('distinguishes the canonical feature-gate 404 from a typed missing Session', async () => {
        const env = await setup();
        const { executeSessionAccessHttpAction } = await import('./sessionAccessApi');
        const request = {
            scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available' as const,
            actionId: 'session.access.grants.list' as const,
            input: { sessionId: 'same' },
        };

        env.request.mockResolvedValueOnce(new Response(
            JSON.stringify({ error: 'not_found' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
        ));
        // The feature gate withheld the route because this Home's sharing is off.
        await expect(executeSessionAccessHttpAction(request)).rejects.toMatchObject({
            code: 'session_access_sharing_unavailable',
            status: 404,
        });
        // The same cause is named before any request when the Home's decision is already known.
        await expect(executeSessionAccessHttpAction({ ...request, availability: 'unavailable' })).rejects.toMatchObject({
            code: 'session_access_sharing_unavailable',
        });

        env.request.mockResolvedValueOnce(new Response(
            JSON.stringify({ error: 'session_access_session_not_found' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
        ));
        await expect(executeSessionAccessHttpAction(request)).rejects.toMatchObject({
            code: 'session_access_session_not_found',
            status: 404,
        });
    });

    it('rejects stale credential responses and extra private output fields', async () => {
        const env = await setup();
        const { executeSessionAccessHttpAction } = await import('./sessionAccessApi');
        const args = { scope: { serverId: env.target.id, accountId: 'target-account' },
            availability: 'available' as const, actionId: 'session.access.grant.remove' as const,
            input: { sessionId: 'same', subject: { kind: 'account', accountId: 'recipient' } } };
        env.request.mockImplementation(async () => new Response(JSON.stringify({ changed: true, subject: args.input.subject, encryptedDataKey: 'private' })));
        await expect(executeSessionAccessHttpAction(args)).rejects.toThrow();
        env.request.mockImplementation(async () => {
            await env.TokenStorage.setCredentialsForServerUrl('https://target.example', { serverId: env.target.id }, { token: env.token('next-account') });
            return new Response(JSON.stringify({ changed: true, subject: args.input.subject }));
        });
        await expect(executeSessionAccessHttpAction(args)).rejects.toMatchObject({ code: 'session_access_stale_scope' });
    });

});
