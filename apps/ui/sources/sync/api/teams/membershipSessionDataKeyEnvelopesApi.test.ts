import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { executeMembershipHistoryActionForScope } from './membershipSessionDataKeyEnvelopesApi';
import { createDeferred, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isHomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TeamMembershipHistoryPreparationResultV1Schema } from '@happier-dev/protocol/teams/membershipHistoryPreparationV1';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { createUiClientActionReverseHandler } from '@/sync/ops/actions/clientActionReverseDispatch';

import { membershipHistoryPreparationScopeKey } from './membershipSessionDataKeyEnvelopesApi';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

/**
 * The manager Account's real content key pair. Persisted data-key credentials carry the content
 * private key as `machineKey`, which is what the canonical Account encryption owner opens the
 * caller's own historical Session envelopes with — so the composed test never fabricates a key.
 */
const MANAGER_CONTENT_KEYS = tweetnacl.box.keyPair();

/** A Session's stored shared metadata ciphertext as the Home serves it, sealed with `key`. */
async function sessionBoundMetadata(key: Uint8Array, plaintext: unknown) {
    const { AES256Encryption } = await import('@/sync/encryption/encryptor');
    const { encodeBase64 } = await import('@/encryption/base64');
    const [sealed] = await new AES256Encryption(key).encrypt([plaintext]);
    return { metadata: encodeBase64(sealed!, 'base64'), metadataLayoutVersion: 1 };
}

const TEAM_ID = 'acme/1';
const ENCODED_TEAM = 'acme%2F1';

async function setup(options?: Readonly<{ accountEncryption?: 'plain' | 'e2ee' }>) {
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `membership-envelope-${crypto.randomUUID()}`);
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    const active = await upsertAndActivateServer({ serverUrl: 'https://active.example', name: 'Active' });
    const target = await upsertServerProfile({ serverUrl: 'https://target.example', name: 'Target' });
    const features = createRootLayoutFeaturesResponse();
    tryWriteServerEnabledBitInPlace(features, 'sharing.session', true);
    primeServerFeaturesSnapshot({ serverId: target.id, snapshot: { status: 'ready', features } });
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().activateProfileScope({ serverId: active.id, accountId: 'active-account' });
    const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { encodeBase64 } = await import('@/encryption/base64');
    // Persistent credentials and HTTP are the replaced system boundaries; everything below them —
    // scope resolution, the Account encryption owner, the preparation pass — is the real path.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async url => ({
        token: token(url === 'https://target.example' ? 'target-account' : 'active-account'),
        ...(options?.accountEncryption === 'e2ee' ? {
            encryption: {
                publicKey: encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
                machineKey: encodeBase64(MANAGER_CONTENT_KEYS.secretKey, 'base64'),
            },
        } : {}),
    }));
    const request = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response('{}'));
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/auth/ping') return new Response('{}');
        // The persisted key binding the Account encryption owner admits material against comes from
        // the canonical currentness fixture, derived from the same real manager key pair.
        if (pathname === '/v1/account/encryption/currentness' && options?.accountEncryption === 'e2ee') {
            const { createDataKeyAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
            return Response.json(createDataKeyAccountEncryptionCurrentnessFixture({
                machineKey: MANAGER_CONTENT_KEYS.secretKey, publicKey: MANAGER_CONTENT_KEYS.publicKey }));
        }
        return request(String(url), init);
    });
    return { active, target, request, token, TokenStorage };
}

/** One recipient Account with a real, correctly signed content-key binding. */
async function createRecipient() {
    const { encodeBase64 } = await import('@/encryption/base64');
    const { encodeHex } = await import('@/encryption/hex');
    const { signAccountContentKeyBindingV1 } = await import('@happier-dev/protocol');
    const content = tweetnacl.box.keyPair();
    const signing = tweetnacl.sign.keyPair();
    return {
        content,
        contentKey: {
            status: 'available' as const,
            accountSigningPublicKey: encodeHex(signing.publicKey),
            contentPublicKey: encodeBase64(content.publicKey, 'base64'),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey: content.publicKey,
            }), 'base64'),
        },
    };
}

const E2EE_ACCOUNT_ENCRYPTION = JSON.stringify({
    mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-current',
    contentKeyFingerprint: 'content-current', updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'available' },
});

const TEAM_TARGET = { kind: 'team' as const, teamMembershipId: 'mem/9' };
const GROUP_TARGET = { kind: 'group' as const, teamGroupId: 'grp/7', accountId: 'recipient-1' };

function actionExecutor(serverId: string) {
    // Only the exercised family port is needed; all transport and encryption beneath it are real.
    return createActionExecutor({
        teamMembershipHistoryAction: async ({ actionId, input }: Parameters<NonNullable<ActionExecutorDeps['teamMembershipHistoryAction']>>[0]) =>
            await executeMembershipHistoryActionForScope({ actionId, input,
                scope: { serverId, accountId: 'target-account' }, availability: 'available', isCurrent: () => true }),
    } as unknown as ActionExecutorDeps);
}

describe('membership history public Actions', () => {
    it('serves the admitted reverse-client read through the default app encryption host', async () => {
        const env = await setup();
        env.request.mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
            if (path === '/v2/account/settings') return new Response(JSON.stringify({ content: null, version: 0 }));
            return new Response(JSON.stringify({ status: 'recipient_unavailable', recipientAccountId: 'recipient-1',
                contentKey: { status: 'unavailable', reason: 'encryption_setup_required' } }));
        });
        const receive = createUiClientActionReverseHandler({ serverId: env.target.id, accountId: 'target-account', isCurrent: () => true });
        const response = await receive({ v: 1, actionId: 'teams.members.history.preparation.get',
            input: { teamId: TEAM_ID, target: GROUP_TARGET, recipientAccountId: 'recipient-1' },
            context: { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } },
        }, { signal: new AbortController().signal });
        expect(response).toEqual({ v: 1, execution: { ok: true, result: {
            status: 'recipient_unavailable', reason: 'encryption_setup_required',
        } } });
        expect(env.request.mock.calls.some(([url]) => new URL(url).pathname.includes('/groups/grp%2F7/members/recipient-1/'))).toBe(true);
    });
    it.each([false, true])('requires human authority for an Agent request (approval waived=%s)', async waived => {
        const env = await setup();
        let stored: ApprovalRequest | null = null;
        const settings = ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: waived ? { 'teams.members.history.prepare': ['agent'] } : {} });
        const executor = createActionExecutor({
            isActionApprovalRequired: (actionId: ActionId, context: ActionExecutorContext) =>
                isApprovalRequiredByActionsSettings(actionId, settings, context, getActionSpec(actionId).safety),
            approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
                stored = request;
                return { artifactId: 'membership-history-approval' };
            },
            teamMembershipHistoryAction: async ({ actionId, input }: Parameters<NonNullable<ActionExecutorDeps['teamMembershipHistoryAction']>>[0]) =>
                await executeMembershipHistoryActionForScope({ actionId, input, scope: {
                    serverId: env.target.id, accountId: 'target-account',
                }, availability: 'available', isCurrent: () => true }),
        } as unknown as ActionExecutorDeps);
        const input = { teamId: TEAM_ID, target: GROUP_TARGET, recipientAccountId: 'recipient-1' };
        const pending = executor.execute('teams.members.history.prepare', input, {
            surface: 'agent', authority: 'account_automation', serverId: env.target.id,
            runtimeAccountId: 'target-account', actionRequestId: 'history-request', actionCaller: { kind: 'host' },
        });
        if (waived) {
            await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
            expect(stored).toBeNull();
            expect(env.request).not.toHaveBeenCalled();
            return;
        }
        await expect(pending).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created',
            artifactId: 'membership-history-approval', actionId: 'teams.members.history.prepare' } });
        expect(stored).toMatchObject({ actionArgs: input, approval: { flow: 'deferred', result: 'required' },
            createdBy: { surface: 'agent' }, executionOriginV1: { authority: 'account_automation' } });
        expect(env.request).not.toHaveBeenCalled();
    });
    it('requires the existing answering client and rejects contradictory Group addressing before dispatch', async () => {
        const env = await setup();
        const input = { teamId: TEAM_ID, target: GROUP_TARGET, recipientAccountId: 'recipient-1' };
        const spec = getActionSpec('teams.members.history.prepare');
        expect(spec).toMatchObject({ executionPlacement: 'client', requiredAuthority: 'present_user',
            approval: { result: 'required' }, surfaces: { agent: true, mcp: true, cli: false, rpc: false } });
        expect(isHomeDomainActionIdV1(spec.id)).toBe(false);
        // The daemon has only its genuine reverse-client system boundary, no encryption host.
        const headless = createActionExecutor({ clientActionExecute: async () => ({ ok: false,
            errorCode: 'unavailable', error: 'noClient' }) } as unknown as ActionExecutorDeps);
        await expect(headless.execute('teams.members.history.preparation.get', input,
            { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } },
        )).resolves.toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
        await expect(actionExecutor(env.target.id).execute('teams.members.history.preparation.get', {
            ...input, recipientAccountId: 'another-account',
        }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } },
        )).resolves.toMatchObject({ ok: false });
        expect(env.request).not.toHaveBeenCalled();
    });
    it.each([TEAM_TARGET, GROUP_TARGET])('observes only readiness and aggregate counts for $kind membership', async target => {
        const env = await setup();
        const recipient = await createRecipient();
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        env.request.mockImplementation(async () => new Response(JSON.stringify({
            status: 'ready', recipientAccountId: 'recipient-1', contentKey: recipient.contentKey,
            items: [{ sessionId: 'private-session', callerDataKeyEnvelope: encryptDataKeyForRecipientV0(
                new Uint8Array(32).fill(3), encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
            ) }], nextCursor: null,
            exceptions: { callerEnvelopeRepairRequiredCount: 1, callerVisibleNonTransferableSessionCount: 2 },
        })));
        const result = await actionExecutor(env.target.id).execute('teams.members.history.preparation.get', {
            teamId: TEAM_ID, target, recipientAccountId: 'recipient-1',
        }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } });
        expect(result).toEqual({ ok: true, result: {
            status: 'ready', actionable: true,
            exceptions: { callerEnvelopeRepairRequiredCount: 1, callerVisibleNonTransferableSessionCount: 2 },
        } });
        expect(JSON.stringify(result)).not.toContain('private-session');
        expect(JSON.stringify(result)).not.toContain('contentKey');
    });

    it('refuses a preparation without encryption material and does not mistake automation for a present user', async () => {
        const env = await setup();
        env.request.mockImplementation(async () => new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 })));
        const input = { teamId: TEAM_ID, target: TEAM_TARGET, recipientAccountId: 'recipient-1' };
        await expect(actionExecutor(env.target.id).execute('teams.members.history.prepare', input,
            { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                presentUserConfirmation: { actionId: 'teams.members.history.prepare' } },
        )).resolves.toMatchObject({ ok: false, errorCode: 'session_data_key_unavailable' });
        expect(env.request.mock.calls.every(([url]) => !new URL(url).pathname.endsWith('/data-key/envelopes'))).toBe(true);
        env.request.mockClear();
        const noApprovalHost = actionExecutor(env.target.id);
        const automated = await noApprovalHost.execute('teams.members.history.prepare', input,
            { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } });
        expect(automated.ok).toBe(false);
        expect(env.request).not.toHaveBeenCalled();
    });
});

describe('membership history envelope exact-Account transport', () => {
    it('shares only the raw page between a public reader and an Action while one borrower cancels', async () => {
        const env = await setup();
        const { createMembershipSessionDataKeyEnvelopeClient } = await import('./membershipSessionDataKeyEnvelopesApi');
        const held = createDeferred<void>();
        const signals: Array<AbortSignal | null | undefined> = [];
        env.request.mockImplementation(async (_url, init) => {
            signals.push(init?.signal);
            await Promise.race([held.promise, new Promise<never>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            })]);
            return Response.json({ status: 'recipient_unavailable', recipientAccountId: 'recipient-1',
                contentKey: { status: 'unavailable', reason: 'encryption_setup_required' } });
        });
        const scope = { serverId: env.target.id, accountId: 'target-account' };
        const cancel = new AbortController();
        const publicAdmitted = createDeferred<void>();
        const actionAdmitted = createDeferred<void>();
        let publicChecks = 0;
        let actionChecks = 0;
        // The first caller check precedes authority capture; the next is the
        // bound page's pre-read admission. Observe both before withdrawing one.
        const departed = createMembershipSessionDataKeyEnvelopeClient({ scope,
            address: { serverId: env.target.id, teamId: TEAM_ID }, target: TEAM_TARGET,
            recipientAccountId: 'recipient-1', availability: 'available', signal: cancel.signal,
            isCurrent: () => { if (++publicChecks === 2) publicAdmitted.resolve(); return true; },
        }).fetchPage(null).then(() => 'disclosed', () => 'cancelled');
        const survivor = executeMembershipHistoryActionForScope({ scope, availability: 'available',
            actionId: 'teams.members.history.preparation.get',
            isCurrent: () => { if (++actionChecks === 2) actionAdmitted.resolve(); return true; },
            input: { teamId: TEAM_ID, target: TEAM_TARGET, recipientAccountId: 'recipient-1' } });
        try {
            await Promise.all([publicAdmitted.promise, actionAdmitted.promise]);
            await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
            cancel.abort();
            await expect(departed).resolves.toBe('cancelled');
            expect(signals.at(-1)?.aborted).toBe(false);
            held.resolve();
            await expect(survivor).resolves.toEqual({ status: 'recipient_unavailable', reason: 'encryption_setup_required' });
            expect(env.request).toHaveBeenCalledTimes(1);
        } finally {
            held.resolve();
            await Promise.allSettled([departed, survivor]);
        }
    });

    it('partitions pending pages by Home, target, expected recipient and exact cursor bytes', async () => {
        const env = await setup();
        const { createMembershipSessionDataKeyEnvelopeClient } = await import('./membershipSessionDataKeyEnvelopesApi');
        const { encodeMembershipSessionDataKeyEnvelopeCursorV1 } = await import('@happier-dev/protocol/sessions/encryption/membershipSessionDataKeyEnvelopes');
        const held = createDeferred<void>();
        env.request.mockImplementation(async () => {
            await held.promise;
            return Response.json({ status: 'recipient_unavailable', recipientAccountId: 'recipient-1',
                contentKey: { status: 'unavailable', reason: 'encryption_setup_required' } });
        });
        const options = { scope: { serverId: env.target.id, accountId: 'target-account' },
            address: { serverId: env.target.id, teamId: TEAM_ID }, target: TEAM_TARGET,
            recipientAccountId: 'recipient-1', availability: 'available' as const };
        const client = createMembershipSessionDataKeyEnvelopeClient(options);
        const cursors = ['session/+ one', 'session/+ two'].map(encodeMembershipSessionDataKeyEnvelopeCursorV1);
        const reads = [client.fetchPage(null), client.fetchPage(null),
            createMembershipSessionDataKeyEnvelopeClient({ ...options, target: { ...TEAM_TARGET, teamMembershipId: 'mem/10' } }).fetchPage(null),
            createMembershipSessionDataKeyEnvelopeClient({ ...options, target: GROUP_TARGET }).fetchPage(null),
            createMembershipSessionDataKeyEnvelopeClient({ ...options, target: { ...GROUP_TARGET, teamGroupId: 'grp/8' } }).fetchPage(null),
            executeMembershipHistoryActionForScope({ scope: options.scope, availability: 'available',
                actionId: 'teams.members.history.preparation.get',
                input: { teamId: TEAM_ID, target: TEAM_TARGET, recipientAccountId: 'replacement-recipient' } }),
            ...cursors.map(cursor => client.fetchPage(cursor)),
            createMembershipSessionDataKeyEnvelopeClient({ ...options,
                scope: { serverId: env.active.id, accountId: 'active-account' },
                address: { serverId: env.active.id, teamId: TEAM_ID } }).fetchPage(null)];
        try {
            // Nine callers contain one equivalent pair; only that pair may join.
            await vi.waitFor(() => expect(env.request).toHaveBeenCalledTimes(8));
            const urls = env.request.mock.calls.map(([url]) => new URL(url));
            expect(urls.filter(url => url.origin === 'https://target.example'
                && url.pathname.endsWith('/members/mem%2F9/sessions/data-key/envelopes')
                && !url.searchParams.has('cursor'))).toHaveLength(2);
            expect(urls.filter(url => url.origin === 'https://active.example')).toHaveLength(1);
            expect(urls.filter(url => url.searchParams.has('cursor')).map(url => url.searchParams.get('cursor')).sort()).toEqual([...cursors].sort());
            held.resolve();
            const results = await Promise.all(reads);
            expect(env.request).toHaveBeenCalledTimes(8);
            expect(results[5]).toMatchObject({ ok: false, errorCode: 'recipient_changed' });
            expect(results[0]).toMatchObject({ recipientAccountId: 'recipient-1' });
        } finally {
            held.resolve();
            await Promise.allSettled(reads);
        }
    });

    it.each(['success', 'unknown'] as const)('fences pre-write and during-write pages after %s PATCH settlement without sharing writes', async outcome => {
        const env = await setup();
        const { createMembershipSessionDataKeyEnvelopeClient } = await import('./membershipSessionDataKeyEnvelopesApi');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const recipient = await createRecipient();
        const pageGates = [createDeferred<void>(), createDeferred<void>(), createDeferred<void>()];
        const writeGate = createDeferred<void>();
        let gets = 0;
        let patches = 0;
        env.request.mockImplementation(async (_url, init) => {
            if (init?.method === 'PATCH') {
                patches += 1;
                await writeGate.promise;
                if (outcome === 'unknown') throw new Error('Connection lost after the write was issued');
                return Response.json({ appliedCount: 1 });
            }
            const observation = ++gets;
            const gate = pageGates[observation - 1];
            if (!gate) throw new Error('Unexpected additional page acquisition');
            await gate.promise;
            return Response.json({ status: 'ready', recipientAccountId: 'recipient-1', contentKey: recipient.contentKey,
                items: [], exceptions: { callerVisibleNonTransferableSessionCount: observation, callerEnvelopeRepairRequiredCount: 0 }, nextCursor: null });
        });
        const client = createMembershipSessionDataKeyEnvelopeClient({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            address: { serverId: env.target.id, teamId: TEAM_ID }, target: TEAM_TARGET,
            recipientAccountId: 'recipient-1', availability: 'available',
        });
        const request = { recipientAccountId: 'recipient-1', entries: [{ sessionId: 'session-1',
            encryptedDataKey: encryptDataKeyForRecipientV0(new Uint8Array(32).fill(19), recipient.contentKey.contentPublicKey) }] };
        const reads = [client.fetchPage(null)];
        const writes: Array<Promise<string>> = [];
        try {
            await vi.waitFor(() => expect(gets).toBe(1));
            writes.push(...[client.patchPage(request), client.patchPage(request)].map(write => write.then(() => 'applied', () => 'unknown')));
            await vi.waitFor(() => expect(patches).toBe(2));
            reads.push(client.fetchPage(null));
            await vi.waitFor(() => expect(gets).toBe(2));
            writeGate.resolve();
            await expect(Promise.all(writes)).resolves.toEqual(outcome === 'success' ? ['applied', 'applied'] : ['unknown', 'unknown']);
            reads.push(client.fetchPage(null));
            await vi.waitFor(() => expect(gets).toBe(3));
            for (const gate of pageGates) gate.resolve();
            const pages = await Promise.all(reads);
            expect(pages.map(page => page.status === 'ready' ? page.exceptions?.callerVisibleNonTransferableSessionCount : null)).toEqual([1, 2, 3]);
            expect(patches).toBe(2);
        } finally {
            writeGate.resolve();
            for (const gate of pageGates) gate.resolve();
            await Promise.allSettled([...reads, ...writes]);
        }
    });

    it('uses one canonical identity that distinguishes every Team and Group target', () => {
        const args = {
            scope: { serverId: 'server-1', accountId: 'manager-1' },
            address: { serverId: 'server-1', teamId: TEAM_ID },
            recipientAccountId: 'recipient-1',
        };

        expect(membershipHistoryPreparationScopeKey({ ...args, target: TEAM_TARGET }))
            .not.toBe(membershipHistoryPreparationScopeKey({ ...args, target: GROUP_TARGET }));
        expect(membershipHistoryPreparationScopeKey({ ...args, target: GROUP_TARGET }))
            .not.toBe(membershipHistoryPreparationScopeKey({
                ...args,
                target: { ...GROUP_TARGET, teamGroupId: 'grp/8' },
            }));
    });

    it('addresses the Team and Group resources with target credentials and rejects an Account mismatch before discovery', async () => {
        const env = await setup();
        const { createMembershipSessionDataKeyEnvelopeClient } = await import('./membershipSessionDataKeyEnvelopesApi');
        const args = {
            scope: { serverId: env.target.id, accountId: 'target-account' },
            address: { serverId: env.target.id, teamId: TEAM_ID },
            recipientAccountId: 'recipient-1',
            availability: 'available' as const,
            isCurrent: () => true,
        };
        env.request.mockImplementation(async () => new Response(JSON.stringify({
            status: 'recipient_unavailable',
            recipientAccountId: 'recipient-1',
            contentKey: { status: 'unavailable', reason: 'encryption_setup_required' },
        })));

        await createMembershipSessionDataKeyEnvelopeClient({ ...args, target: TEAM_TARGET }).fetchPage(null);
        expect(env.request.mock.calls[0]?.[0]).toBe(
            `https://target.example/v2/teams/${ENCODED_TEAM}/members/mem%2F9/sessions/data-key/envelopes?state=action_required`,
        );
        expect(new Headers(env.request.mock.calls[0]?.[1]?.headers).get('Authorization'))
            .toBe(`Bearer ${env.token('target-account')}`);

        env.request.mockClear();
        const { encodeMembershipSessionDataKeyEnvelopeCursorV1 } = await import('@happier-dev/protocol');
        const cursor = encodeMembershipSessionDataKeyEnvelopeCursorV1('session-3');
        await createMembershipSessionDataKeyEnvelopeClient({ ...args, target: GROUP_TARGET })
            .fetchPage(cursor);
        expect(env.request.mock.calls[0]?.[0]).toBe(
            `https://target.example/v2/teams/${ENCODED_TEAM}/groups/grp%2F7/members/recipient-1`
            + `/sessions/data-key/envelopes?state=action_required&cursor=${cursor}`,
        );

        // A Home/Account pair the caller does not actually hold never reaches the network at all.
        env.request.mockClear();
        await expect(createMembershipSessionDataKeyEnvelopeClient({
            ...args, target: TEAM_TARGET, scope: { ...args.scope, accountId: 'wrong' },
        }).fetchPage(null)).rejects.toThrow();
        expect(env.request).not.toHaveBeenCalled();
    });

    it('fails unsupported collection access without probing and preserves typed server errors', async () => {
        const env = await setup();
        const { createMembershipSessionDataKeyEnvelopeClient } = await import('./membershipSessionDataKeyEnvelopesApi');
        const args = {
            scope: { serverId: env.target.id, accountId: 'target-account' },
            address: { serverId: env.target.id, teamId: TEAM_ID },
            target: TEAM_TARGET,
            recipientAccountId: 'recipient-1',
            isCurrent: () => true,
        };
        await expect(createMembershipSessionDataKeyEnvelopeClient({ ...args, availability: 'unavailable' })
            .fetchPage(null)).rejects.toMatchObject({ code: 'session_access_sharing_unavailable' });
        expect(env.request).not.toHaveBeenCalled();

        env.request.mockImplementation(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
        await expect(createMembershipSessionDataKeyEnvelopeClient({ ...args, availability: 'available' })
            .fetchPage(null)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
        expect(env.request.mock.calls).toHaveLength(1);

        env.request.mockImplementation(async () => new Response(
            JSON.stringify({ error: 'membership_not_found' }),
            { status: 404 },
        ));
        await expect(createMembershipSessionDataKeyEnvelopeClient({ ...args, availability: 'available' })
            .fetchPage(null)).rejects.toMatchObject({ code: 'membership_not_found', status: 404 });
    });
});

describe('membership history preparation host', () => {
    it('deduplicates one detached membership pass and does not bind its lifetime to a sheet callback', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { prepareMembershipHistoryEnvelopesDetached } = await import('./membershipSessionDataKeyEnvelopesApi');
        let releasePage!: () => void;
        const pageReleased = new Promise<void>((resolve) => { releasePage = resolve; });
        let collectionReads = 0;
        env.request.mockImplementation(async (url) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(E2EE_ACCOUNT_ENCRYPTION);
            collectionReads += 1;
            await pageReleased;
            return new Response(JSON.stringify({
                status: 'recipient_unavailable',
                recipientAccountId: 'recipient-1',
                contentKey: { status: 'unavailable', reason: 'encryption_setup_required' },
            }));
        });
        const options = {
            scope: { serverId: env.target.id, accountId: 'target-account' },
            address: { serverId: env.target.id, teamId: TEAM_ID },
            target: TEAM_TARGET,
            recipientAccountId: 'recipient-1',
            availability: 'available' as const,
        };

        const first = prepareMembershipHistoryEnvelopesDetached(options);
        const second = prepareMembershipHistoryEnvelopesDetached(options);
        expect(second).toBe(first);
        releasePage();
        await expect(first).resolves.toMatchObject({
            status: 'recipient_unavailable',
            recipientUnavailableReason: 'encryption_setup_required',
        });
        expect(collectionReads).toBe(1);
    });

    it('prepares real historical envelopes so the recipient opens each exact Session DEK', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { encodeBase64, decodeBase64 } = await import('@/encryption/base64');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { openEncryptedDataKeyEnvelopeV1 } = await import('@happier-dev/protocol');
        const recipient = await createRecipient();

        // Two historical Sessions, each with its own DEK already sealed to the manager.
        const sessionDataKeys = new Map([
            ['session-1', new Uint8Array(32).fill(11)],
            ['session-2', new Uint8Array(32).fill(22)],
        ]);
        const items = await Promise.all([...sessionDataKeys].map(async ([sessionId, dataKey]) => ({
            sessionId,
            callerDataKeyEnvelope: encryptDataKeyForRecipientV0(
                dataKey,
                encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
            ),
            // Each Session's own strict layout-1 shared metadata, sealed with its key.
            ...await sessionBoundMetadata(dataKey, { v: 1 }),
        })));

        const events: string[] = [];
        const patched: Array<{ recipientAccountId: string; entries: Array<{ sessionId: string; encryptedDataKey: string }> }> = [];
        let pages = 0;
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(E2EE_ACCOUNT_ENCRYPTION);
            if (path.endsWith('/data-key/envelopes') && init?.method === 'PATCH') {
                events.push('patch');
                patched.push(JSON.parse(String(init.body)));
                return new Response(JSON.stringify({ appliedCount: 2 }));
            }
            if (path.endsWith('/data-key/envelopes')) {
                pages += 1;
                events.push(`get:${pages}`);
                return new Response(JSON.stringify({
                    status: 'ready',
                    recipientAccountId: 'recipient-1',
                    contentKey: recipient.contentKey,
                    items: pages === 1 ? items : [],
                    exceptions: {
                        callerVisibleNonTransferableSessionCount: pages === 1 ? 3 : 3,
                        callerEnvelopeRepairRequiredCount: 1,
                    },
                    nextCursor: null,
                }));
            }
            throw new Error(`Unexpected request ${path}`);
        });

        const result = await actionExecutor(env.target.id).execute('teams.members.history.prepare', {
            teamId: TEAM_ID, target: TEAM_TARGET, recipientAccountId: 'recipient-1',
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            presentUserConfirmation: { actionId: 'teams.members.history.prepare' } });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.errorCode);
        const outcome = TeamMembershipHistoryPreparationResultV1Schema.parse(result.result);

        expect(outcome.status).toBe('complete');
        expect(outcome.preparedCount).toBe(2);
        expect(outcome.repairRequiredCount).toBe(0);
        expect(JSON.stringify(result)).not.toContain('repairRequiredSessions');
        // The exceptions the row explains are the server's own last-page counts, not a local tally.
        expect(outcome.exceptions).toEqual({
            callerVisibleNonTransferableSessionCount: 3,
            callerEnvelopeRepairRequiredCount: 1,
        });
        // Discovery, one bounded commit, then the single recheck through the existing producer.
        expect(events).toEqual(['get:1', 'patch', 'get:2']);

        // Every recipient envelope opens to the exact same 32 bytes the manager opened — no
        // re-keying, and never the manager's own Account material.
        expect(patched).toHaveLength(1);
        expect(patched[0]!.recipientAccountId).toBe('recipient-1');
        for (const entry of patched[0]!.entries) {
            const opened = openEncryptedDataKeyEnvelopeV1({
                envelope: decodeBase64(entry.encryptedDataKey, 'base64'),
                recipientSecretKeyOrSeed: recipient.content.secretKey,
            });
            expect(opened).toEqual(sessionDataKeys.get(entry.sessionId));
            expect(openEncryptedDataKeyEnvelopeV1({
                envelope: decodeBase64(entry.encryptedDataKey, 'base64'),
                recipientSecretKeyOrSeed: MANAGER_CONTENT_KEYS.secretKey,
            })).toBeNull();
        }
    });

    it('reseals only keys that prove they are their Session\'s, and reports the rest as typed skips', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { encodeBase64, decodeBase64 } = await import('@/encryption/base64');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { openEncryptedDataKeyEnvelopeV1 } = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
        const recipient = await createRecipient();
        const sealToManager = (key: Uint8Array) => encryptDataKeyForRecipientV0(key, encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'));

        const genuineKey = new Uint8Array(32).fill(11);
        // Saved Secret, Workflow and Machine keys this manager can open, which a malicious Home
        // lists as Session envelopes under the history it serves.
        const savedSecretKey = new Uint8Array(32).fill(0x5a);
        const workflowKey = new Uint8Array(32).fill(0x5b);
        const machineKey = new Uint8Array(32).fill(0x5c);
        const items = [
            { sessionId: 'session-genuine', callerDataKeyEnvelope: sealToManager(genuineKey),
                ...await sessionBoundMetadata(genuineKey, { v: 1 }) },
            // The resource's own non-Session plaintext, claimed as layout-1 shared metadata.
            { sessionId: 'session-saved-secret', callerDataKeyEnvelope: sealToManager(savedSecretKey),
                ...await sessionBoundMetadata(savedSecretKey, { name: 'deploy token', value: 'redacted' }) },
            // Genuine-looking Session metadata the served key cannot open.
            { sessionId: 'session-workflow', callerDataKeyEnvelope: sealToManager(workflowKey),
                ...await sessionBoundMetadata(new Uint8Array(32).fill(1), { v: 1 }) },
            // Layout 0 accepts any record, so it proves nothing.
            { sessionId: 'session-machine', callerDataKeyEnvelope: sealToManager(machineKey),
                ...await sessionBoundMetadata(machineKey, { host: 'alice', platform: 'linux' }), metadataLayoutVersion: 0 },
            // An older Home that does not send the Session metadata at all.
            { sessionId: 'session-older-home', callerDataKeyEnvelope: sealToManager(new Uint8Array(32).fill(33)) },
        ];

        const patched: Array<{ entries: Array<{ sessionId: string; encryptedDataKey: string }> }> = [];
        let pages = 0;
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(E2EE_ACCOUNT_ENCRYPTION);
            if (path.endsWith('/data-key/envelopes') && init?.method === 'PATCH') {
                const body = JSON.parse(String(init.body)) as (typeof patched)[number];
                patched.push(body);
                return new Response(JSON.stringify({ appliedCount: body.entries.length }));
            }
            if (path.endsWith('/data-key/envelopes')) {
                pages += 1;
                return new Response(JSON.stringify({
                    status: 'ready', recipientAccountId: 'recipient-1', contentKey: recipient.contentKey,
                    items: pages === 1 ? items : items.slice(1),
                    exceptions: { callerVisibleNonTransferableSessionCount: 0, callerEnvelopeRepairRequiredCount: 0 },
                    nextCursor: null,
                }));
            }
            throw new Error(`Unexpected request ${path}`);
        });

        const result = await actionExecutor(env.target.id).execute('teams.members.history.prepare', {
            teamId: TEAM_ID, target: TEAM_TARGET, recipientAccountId: 'recipient-1',
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            presentUserConfirmation: { actionId: 'teams.members.history.prepare' } });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.errorCode);
        const outcome = TeamMembershipHistoryPreparationResultV1Schema.parse(result.result);

        // Only the genuine Session key reached the recipient; nothing else was sealed at all.
        expect(patched.flatMap(page => page.entries.map(entry => entry.sessionId))).toEqual(['session-genuine']);
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(patched[0]!.entries[0]!.encryptedDataKey, 'base64'),
            recipientSecretKeyOrSeed: recipient.content.secretKey,
        })).toEqual(genuineKey);
        expect(outcome).toMatchObject({ status: 'incomplete', preparedCount: 1, sessionKeyUnprovenCount: 4, repairRequiredCount: 0 });
    });

    it('stops without committing when the membership resolves to a replacement Account', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { prepareMembershipHistoryEnvelopesForScope } = await import('./membershipSessionDataKeyEnvelopesApi');
        const recipient = await createRecipient();
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(E2EE_ACCOUNT_ENCRYPTION);
            if (init?.method === 'PATCH') throw new Error('must not commit to a replacement Account');
            // A provider reset kept the Team membership id and replaced its Account.
            return new Response(JSON.stringify({
                status: 'ready',
                recipientAccountId: 'replacement-account',
                contentKey: recipient.contentKey,
                items: [],
                exceptions: { callerVisibleNonTransferableSessionCount: 0, callerEnvelopeRepairRequiredCount: 0 },
                nextCursor: null,
            }));
        });
        await expect(prepareMembershipHistoryEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            address: { serverId: env.target.id, teamId: TEAM_ID },
            target: TEAM_TARGET,
            recipientAccountId: 'recipient-1',
            availability: 'available',
            isCurrent: () => true,
        })).resolves.toMatchObject({ status: 'recipient_changed', preparedCount: 0 });
    });

    it('turns a PATCH-time recipient replacement into the refreshable recipient_changed outcome', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { encodeBase64 } = await import('@/encryption/base64');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { prepareMembershipHistoryEnvelopesForScope } = await import('./membershipSessionDataKeyEnvelopesApi');
        const recipient = await createRecipient();
        let pages = 0;
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(E2EE_ACCOUNT_ENCRYPTION);
            if (init?.method === 'PATCH') {
                return new Response(JSON.stringify({ error: 'recipient_changed' }), { status: 409 });
            }
            pages += 1;
            return new Response(JSON.stringify({
                status: 'ready',
                recipientAccountId: 'recipient-1',
                contentKey: recipient.contentKey,
                items: pages === 1 ? [{
                    sessionId: 'session-1',
                    callerDataKeyEnvelope: encryptDataKeyForRecipientV0(
                        new Uint8Array(32).fill(31),
                        encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
                    ),
                    ...await sessionBoundMetadata(new Uint8Array(32).fill(31), { v: 1 }),
                }] : [],
                exceptions: {
                    callerVisibleNonTransferableSessionCount: 0,
                    callerEnvelopeRepairRequiredCount: 0,
                },
                nextCursor: null,
            }));
        });

        await expect(prepareMembershipHistoryEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            address: { serverId: env.target.id, teamId: TEAM_ID },
            target: TEAM_TARGET,
            recipientAccountId: 'recipient-1',
            availability: 'available',
            isCurrent: () => true,
        })).resolves.toMatchObject({ status: 'recipient_changed', preparedCount: 0 });
    });

    it('preserves membership disappearance during PATCH as a refreshnaewele stereable outcome', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { encodeBase64 } = await import('@/encryption/base64');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { prepareMembershipHistoryEnvelopesForScope } = await import('./membershipSessionDataKeyEnvelopesApi');
        const recipient = await createRecipient();
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(E2EE_ACCOUNT_ENCRYPTION);
            if (init?.method === 'PATCH') {
                return new Response(JSON.stringify({ error: 'membership_not_found' }), { status: 404 });
            }
            return new Response(JSON.stringify({
                status: 'ready',
                recipientAccountId: 'recipient-1',
                contentKey: recipient.contentKey,
                items: [{
                    sessionId: 'session-1',
                    callerDataKeyEnvelope: encryptDataKeyForRecipientV0(
                        new Uint8Array(32).fill(41),
                        encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
                    ),
                    ...await sessionBoundMetadata(new Uint8Array(32).fill(41), { v: 1 }),
                }],
                exceptions: {
                    callerVisibleNonTransferableSessionCount: 0,
                    callerEnvelopeRepairRequiredCount: 0,
                },
                nextCursor: null,
            }));
        });

        await expect(prepareMembershipHistoryEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            address: { serverId: env.target.id, teamId: TEAM_ID },
            target: GROUP_TARGET,
            recipientAccountId: 'recipient-1',
            availability: 'available',
            isCurrent: () => true,
        })).resolves.toMatchObject({ status: 'membership_changed', preparedCount: 0 });
    });

    it('suppresses the commit and progress once the host scope stops being current', async () => {
        const env = await setup({ accountEncryption: 'e2ee' });
        const { encodeBase64 } = await import('@/encryption/base64');
        const { encryptDataKeyForRecipientV0 } = await import('@/sync/encryption/directShareEncryption');
        const { prepareMembershipHistoryEnvelopesForScope } = await import('./membershipSessionDataKeyEnvelopesApi');
        const recipient = await createRecipient();
        let current = true;
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path.includes('/account/encryption')) return new Response(E2EE_ACCOUNT_ENCRYPTION);
            if (init?.method === 'PATCH') throw new Error('must not commit after the scope changed');
            // The person navigated Home/Account away while this page was in flight.
            current = false;
            return new Response(JSON.stringify({
                status: 'ready',
                recipientAccountId: 'recipient-1',
                contentKey: recipient.contentKey,
                items: [{
                    sessionId: 'session-1',
                    callerDataKeyEnvelope: encryptDataKeyForRecipientV0(
                        new Uint8Array(32).fill(11),
                        encodeBase64(MANAGER_CONTENT_KEYS.publicKey, 'base64'),
                    ),
                    ...await sessionBoundMetadata(new Uint8Array(32).fill(11), { v: 1 }),
                }],
                exceptions: { callerVisibleNonTransferableSessionCount: 0, callerEnvelopeRepairRequiredCount: 0 },
                nextCursor: null,
            }));
        });
        const onProgress = vi.fn();
        await expect(prepareMembershipHistoryEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            address: { serverId: env.target.id, teamId: TEAM_ID },
            target: GROUP_TARGET,
            recipientAccountId: 'recipient-1',
            availability: 'available',
            isCurrent: () => current,
            onProgress,
        })).resolves.toMatchObject({ status: 'scope_changed', preparedCount: 0 });
        expect(onProgress).not.toHaveBeenCalled();
    });

    it('reports a plain manager Account as unable to open its own history rather than as empty work', async () => {
        const env = await setup();
        const { prepareMembershipHistoryEnvelopesForScope } = await import('./membershipSessionDataKeyEnvelopesApi');
        await expect(prepareMembershipHistoryEnvelopesForScope({
            scope: { serverId: env.target.id, accountId: 'target-account' },
            address: { serverId: env.target.id, teamId: TEAM_ID },
            target: TEAM_TARGET,
            recipientAccountId: 'recipient-1',
            availability: 'available',
            isCurrent: () => true,
        })).rejects.toMatchObject({ code: 'session_data_key_unavailable' });
        expect(env.request.mock.calls.every(([url]) => !url.includes('/data-key/envelopes'))).toBe(true);
    });
});
