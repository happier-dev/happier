import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';

const {
    createPrivateLabelActionOpener,
    createPrivateLabelClientForAccountContext,
    isPrivateLabelLifecycleFailureV1,
} = await import('./privateLabelClient');
const { useOpenedPrivateLabels } = await import('./useOpenedPrivateLabels');

function recipient(accountId: string, contentPublicKey: Uint8Array) {
    return {
        account: { kind: 'account' as const, accountId, firstName: accountId, lastName: null, username: accountId, avatarUrl: null },
        readiness: {
            status: 'available' as const,
            contentPublicKey: encodeBase64(contentPublicKey, 'base64'),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentPublicKey),
        },
        envelopeStatus: 'missing' as const,
    };
}

afterEach(async () => {
    standardCleanup();
});

describe('private label client', () => {
    it('forwards Team-resource policy through the collection opener without consulting viewer mode', async () => {
        const opened = await renderHook(() => useOpenedPrivateLabels({
            scope: { serverId: 'viewer-home', accountId: 'e2ee-viewer' },
            requests: [{
                key: 'resource-1',
                binding: { entity: 'team_credential_resource', field: 'displayName', id: 'resource-1' },
                label: { content: { t: 'plain', v: 'Engineering' }, recipientEnvelope: null },
                readPolicy: { kind: 'team-resource' },
            }],
        }));

        await vi.waitFor(() => expect(opened.getCurrent()).toEqual({ 'resource-1': 'Engineering' }));
    });

    it('rejects a Plain Account-owned projection for an E2EE Account without treating a Team resource as viewer-owned', async () => {
        const binding = { entity: 'account_api_token', field: 'label', id: 'token-1' } as const;
        const plain = { content: { t: 'plain' as const, v: 'Account label' }, recipientEnvelope: null };
        const client = createPrivateLabelClientForAccountContext({
            accountId: 'viewer', isCurrent: () => true,
            resolveContentEncryptionMode: async () => 'e2ee',
            request: async () => null,
        });

        // A captured E2EE Account must not disclose an account-owned plaintext
        // projection, even though it has no key operation to perform.
        await expect(client.open({
            binding,
            label: plain,
            readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' },
        })).resolves.toBeNull();

        await expect(client.open({ binding, label: { ...plain, legacyPlaintext: true },
            readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' },
        })).resolves.toBe('Account label');

        // A Team resource has no viewer-mode equivalence rule: its strict stored
        // arm is decided by the Team label owner and remains readable to E2EE viewers.
        await expect(client.open({
            binding: { ...binding, entity: 'team_credential_resource', id: 'resource-1' },
            label: plain,
            readPolicy: { kind: 'team-resource' },
        })).resolves.toBe('Account label');
    });

    it('never emits a plain label when the captured E2EE mode disagrees with its census', async () => {
        const order: string[] = [];
        const client = createPrivateLabelClientForAccountContext({
            accountId: 'owner',
            isCurrent: () => true,
            resolveContentEncryptionMode: async () => {
                order.push('captured-mode');
                return 'e2ee' as const;
            },
            request: async () => {
                order.push('census');
                return { ok: true, body: { contentEncryptionMode: 'plain', recipients: [] } };
            },
        });

        const label = await client.seal({
            owner: { kind: 'account', accountId: 'owner' },
            binding: { entity: 'team_credential_resource', field: 'displayName', id: 'resource-1' },
            value: 'must-not-be-sent-as-plain',
        });

        // Census selects recipients only. The captured Account mode must still
        // be checked before any plaintext/ciphertext label is constructed.
        expect(order).toEqual(['census', 'captured-mode']);
        expect(label).toBeNull();
    });

    it('preserves captured-context retirement and cancellation while opening a label', async () => {
        const binding = { entity: 'team_credential_resource', field: 'displayName', id: 'resource-1' } as const;
        const encrypted = {
            content: { t: 'encrypted' as const, c: 'not-opened-before-key-read' },
            recipientEnvelope: { encryptedDataKey: 'opaque', recipientContentPublicKeyFingerprint: 'fingerprint' },
        };
        const retired = Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        expect(isPrivateLabelLifecycleFailureV1(retired)).toBe(true);
        const retiredClient = createPrivateLabelClientForAccountContext({
            accountId: 'directory-owner', isCurrent: () => true,
            resolveContentEncryptionMode: async () => 'e2ee',
            request: async () => null,
            decryptEncryptionKey: async () => { throw retired; },
        });

        await expect(retiredClient.open({ binding, label: encrypted, readPolicy: { kind: 'team-resource' } })).rejects.toBe(retired);

        const missingHome = Object.assign(new Error('action_home_not_found'), { code: 'action_home_not_found' });
        const missingHomeClient = createPrivateLabelClientForAccountContext({
            accountId: 'directory-owner', isCurrent: () => true,
            resolveContentEncryptionMode: async () => 'e2ee',
            request: async () => null,
            decryptEncryptionKey: async () => { throw missingHome; },
        });

        // A missing Home is the same withdrawn Account custody boundary as a
        // changed Account scope; it must never degrade into an unavailable row.
        await expect(missingHomeClient.open({ binding, label: encrypted, readPolicy: { kind: 'team-resource' } })).rejects.toBe(missingHome);

        const cancellation = new AbortController();
        cancellation.abort();
        const cancelled = new DOMException('aborted', 'AbortError');
        expect(isPrivateLabelLifecycleFailureV1(cancelled, cancellation.signal)).toBe(true);
        const cancelledClient = createPrivateLabelClientForAccountContext({
            accountId: 'directory-owner', isCurrent: () => true,
            resolveContentEncryptionMode: async () => 'e2ee',
            request: async () => null,
            decryptEncryptionKey: async () => { throw cancelled; },
        });

        // The boundary observes an already-cancelled signal before it asks the
        // key holder to decrypt, so preserve the signal's canonical reason.
        await expect(cancelledClient.open({ binding, label: encrypted, readPolicy: { kind: 'team-resource' }, signal: cancellation.signal }))
            .rejects.toBe(cancellation.signal.reason);
    });

    it('does not turn an already-retired or cancelled plain-label read into an unavailable label', async () => {
        const binding = { entity: 'team_credential_resource', field: 'displayName', id: 'resource-1' } as const;
        const plain = { content: { t: 'plain' as const, v: 'Visible only while current' }, recipientEnvelope: null };
        const retiredClient = createPrivateLabelClientForAccountContext({
            accountId: 'directory-owner', isCurrent: () => false,
            resolveContentEncryptionMode: async () => 'plain', request: async () => null,
        });

        await expect(retiredClient.open({ binding, label: plain, readPolicy: { kind: 'team-resource' } })).rejects.toMatchObject({
            code: 'action_account_scope_changed',
        });

        const cancellation = new AbortController();
        cancellation.abort();
        const currentClient = createPrivateLabelClientForAccountContext({
            accountId: 'directory-owner', isCurrent: () => true,
            resolveContentEncryptionMode: async () => 'plain', request: async () => null,
        });

        await expect(currentClient.open({ binding, label: plain, readPolicy: { kind: 'team-resource' }, signal: cancellation.signal }))
            .rejects.toBe(cancellation.signal.reason);

        let currentnessChecks = 0;
        const sealingClient = createPrivateLabelClientForAccountContext({
            accountId: 'owner',
            // The context changes after the census and persisted-mode checks but
            // before the final label construction guard.
            isCurrent: () => ++currentnessChecks < 5,
            resolveContentEncryptionMode: async () => 'plain',
            request: async () => ({ ok: true, body: { contentEncryptionMode: 'plain', recipients: [] } }),
        });

        await expect(sealingClient.seal({
            owner: { kind: 'account', accountId: 'owner' }, binding, value: 'must-not-be-returned',
        })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
    });

    it('uses a captured account context for a Directory-held credential and content key', async () => {
        const contentKey = new Uint8Array(32).fill(59);
        const encryption = await createEncryptionFromAuthCredentials({
            token: createAccountTokenForTests('directory-owner'),
            secret: encodeBase64(contentKey, 'base64url'),
        });
        const context = {
            accountId: 'directory-owner',
            isCurrent: () => true,
            resolveContentEncryptionMode: async () => 'e2ee',
            request: async (path: string, init: RequestInit) => {
                expect(path).toBe('/v1/account/private-labels/recipient-census');
                expect(init.method).toBe('POST');
                return {
                    ok: true,
                    body: {
                        contentEncryptionMode: 'e2ee',
                        recipients: [recipient('directory-owner', encryption.contentDataKey)],
                    },
                };
            },
            decryptEncryptionKey: async (encryptedDataKey: string) => await encryption.decryptEncryptionKey(encryptedDataKey),
        };
        const client = createPrivateLabelClientForAccountContext(context);
        const binding = { entity: 'account_home', field: 'label', id: 'home-1' } as const;

        const stored = await client.seal({ owner: { kind: 'account', accountId: 'directory-owner' }, binding, value: 'Personal Home' });
        const opened = await client.open({
            binding,
            readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' },
            label: {
                content: stored!.content,
                recipientEnvelope: stored!.content.t === 'encrypted' ? stored!.recipients[0]!.envelope : null,
            },
        });

        expect(stored?.content.t).toBe('encrypted');
        expect(opened).toBe('Personal Home');
    });

    it('seals a plain Team label only after the server selected its current audience', async () => {
        const requests: Array<{ path: string; init: RequestInit }> = [];
        const client = createPrivateLabelClientForAccountContext({
            accountId: 'owner', isCurrent: () => true,
            resolveContentEncryptionMode: async () => 'plain',
            request: async (path, init) => {
                requests.push({ path, init });
                return { ok: true, body: { contentEncryptionMode: 'plain', recipients: [] } };
            },
        });
        const binding = { entity: 'team_credential_resource', field: 'displayName', id: 'resource-1' } as const;

        const label = await client.seal({ owner: { kind: 'team', teamId: 'team-1' }, binding, value: 'Production deploy' });

        expect(requests).toHaveLength(1);
        expect(requests[0]?.path).toBe('/v1/account/private-labels/recipient-census');
        expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ owner: { kind: 'team', teamId: 'team-1' } });
        expect(label).toEqual({ content: { t: 'plain', v: 'Production deploy' }, recipients: [] });
        await expect(client.open({ binding, label, readPolicy: { kind: 'team-resource' } })).resolves.toBe('Production deploy');
    });

    it('seals for the server census and opens only the caller recipient envelope in E2EE mode', async () => {
        const credentials = {
            token: createAccountTokenForTests('owner', { currentAccount: true }),
            secret: encodeBase64(new Uint8Array(32).fill(61), 'base64url'),
        };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const client = createPrivateLabelClientForAccountContext({
            accountId: 'owner', isCurrent: () => true,
            resolveContentEncryptionMode: async () => 'e2ee',
            request: async () => ({
                ok: true,
                body: { contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey)] },
            }),
            decryptEncryptionKey: async encryptedDataKey => await encryption.decryptEncryptionKey(encryptedDataKey),
        });
        const binding = { entity: 'team_credential_resource', field: 'displayName', id: 'resource-1' } as const;

        const label = await client.seal({ owner: { kind: 'team', teamId: 'team-1' }, binding, value: 'Production deploy' });

        expect(label).toMatchObject({
            content: { t: 'encrypted' },
            recipients: [{ accountId: 'owner', envelope: expect.objectContaining({ encryptedDataKey: expect.any(String) }) }],
        });
        const readerProjection = label && label.content.t === 'encrypted'
            ? { content: label.content, recipientEnvelope: label.recipients[0]?.envelope ?? null }
            : null;
        await expect(client.open({ binding, label: readerProjection, readPolicy: { kind: 'team-resource' } })).resolves.toBe('Production deploy');
    });
});


describe('captured Action private-label opener', () => {
    it('opens an encrypted credential through its captured Account key and preserves retirement', async () => {
        const encryption = await createEncryptionFromAuthCredentials({
            token: createAccountTokenForTests('owner'), secret: encodeBase64(new Uint8Array(32).fill(66), 'base64url'),
        });
        const binding = { entity: 'team_credential_resource', field: 'displayName', id: 'resource-1' } as const;
        const author = createPrivateLabelClientForAccountContext({ accountId: 'owner', isCurrent: () => true,
            resolveContentEncryptionMode: async () => 'e2ee', request: async () => ({ ok: true,
                body: { contentEncryptionMode: 'e2ee', recipients: [recipient('owner', encryption.contentDataKey)] } }),
        });
        const sealed = await author.seal({ owner: { kind: 'team', teamId: 'team-1' }, binding, value: 'Work credential' });
        if (!sealed) throw new Error('test author must seal');
        const label = { content: sealed.content, recipientEnvelope: sealed.recipients[0]?.envelope ?? null };
        let current = true;
        const open = createPrivateLabelActionOpener({ accountId: 'owner', serverId: 'captured-home',
            assertCurrent: () => { if (!current) throw Object.assign(new Error('retired'), { code: 'action_account_scope_changed' }); },
            request: async () => { throw new Error('opening must not request another Home'); },
            resolveAccountEncryption: async () => ({ accountMode: 'e2ee', encryption }),
        });
        await expect(open({ binding, label, readPolicy: { kind: 'team-resource' } }, { surface: 'ui', serverId: 'captured-home' }))
            .resolves.toBe('Work credential');
        await expect(open({ binding: { ...binding, id: 'wrong' }, label, readPolicy: { kind: 'team-resource' } }, {}))
            .resolves.toBeNull();
        current = false;
        await expect(open({ binding, label, readPolicy: { kind: 'team-resource' } }, {}))
            .rejects.toMatchObject({ code: 'action_account_scope_changed' });
    });
});
