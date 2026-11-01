import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildConnectedServiceCredentialRecord,
    buildProviderAccountUsageRecordId,
    ConnectedServiceQuotaSnapshotV1Schema,
    sealAccountScopedBlobCiphertext,
    sealConnectedServiceCredentialCiphertext,
} from '@happier-dev/protocol';
import { storeConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import { getServerFetchUrl } from '@/dev/testkit/mocks/serverFetch';
import {
    __resetConnectedServiceQuotaSnapshotStore,
    buildQuotaSnapshotScopeKey,
    getQuotaSnapshotEntry,
    refreshQuotaSnapshot,
} from '@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore';

const credentials = { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
const material = { type: 'legacy', secret: new Uint8Array(32) } as const;
const metadata = { fetchedAt: 1000, staleAfterMs: 60000, status: 'ok' };

function credential(organizationId: string) {
    return buildConnectedServiceCredentialRecord({
        now: 1000, serviceId: 'claude-subscription', profileId: 'work', kind: 'oauth',
        oauth: { accessToken: 'access', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null,
            providerAccountId: 'same-user', providerEmail: null, raw: { claudeAiOauth: { organizationUuid: organizationId } } },
    });
}

function quota(organizationId?: string) {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1, serviceId: 'claude-subscription', profileId: 'work', fetchedAt: 1000, staleAfterMs: 60000,
        activeAccountId: 'same-user', ...(organizationId ? { providerOrganizationId: organizationId } : {}),
        planLabel: null, accountLabel: null, meters: [],
    });
}

describe('connectedServiceQuotaSnapshotStore cloud credential identity', () => {
    beforeEach(() => __resetConnectedServiceQuotaSnapshotStore());
    afterEach(() => { __resetConnectedServiceQuotaSnapshotStore(); vi.unstubAllGlobals(); });

    it.each(['plain', 'e2ee'] as const)('qualifies %s cloud usage against the current credential, including released relays without public organization metadata', async (mode) => {
        let currentOrganization = 'org-a';
        let quotaUnavailable = false;
        let credentialUnavailable = false;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getServerFetchUrl(input).pathname;
            if (url.endsWith('/quotas/refresh')) return Response.json({ success: true });
            if (url.endsWith('/credential')) {
                if (credentialUnavailable) return Response.json({ error: 'unavailable' }, { status: 403 });
                const record = credential(currentOrganization);
                return Response.json(mode === 'plain'
                    ? { content: { t: 'plain', v: record } }
                    : { sealed: { format: 'account_scoped_v1', ciphertext: sealConnectedServiceCredentialCiphertext({ material, payload: record, randomBytes: (n) => new Uint8Array(n).fill(3) }) }, metadata: { kind: 'oauth', providerAccountId: 'same-user' } });
            }
            if (url.endsWith('/quotas') && String(init?.method ?? 'GET') === 'GET') {
                if (quotaUnavailable) return Response.json({ error: 'unavailable' }, { status: 403 });
                return Response.json(mode === 'plain'
                    ? { content: { t: 'plain', v: quota('org-a') }, metadata }
                    : { sealed: { format: 'account_scoped_v1', ciphertext: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_snapshot', material, payload: (() => {
                        const recordKey = { providerId: 'claude', accountSubjectId: 'same-user', subjectKind: 'account', quotaScope: 'organization', quotaScopeId: 'org-a' } as const;
                        return { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'claude',
                            accountSubject: { kind: 'providerSubject', id: 'same-user' }, observedAtMs: 1000, fetchedAtMs: 1000,
                            staleAfterMs: 60000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', planLabel: null, accountLabel: null, meters: [] };
                    })(), randomBytes: (n) => new Uint8Array(n).fill(4) }) }, metadata });
            }
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return new Response('', { status: 200 });
            return Response.json({ error: 'not_found' }, { status: 404 });
        }));
        const context = { credentials, credentialScope: 'identity', serviceId: 'claude-subscription', profileId: 'work', resolveAccountMode: async () => mode } as const;
        const key = buildQuotaSnapshotScopeKey(context.credentialScope, context.serviceId, context.profileId);
        await refreshQuotaSnapshot(key, context);
        expect(getQuotaSnapshotEntry(key).error).toBeNull();
        expect(getQuotaSnapshotEntry(key).snapshot?.providerOrganizationId).toBe('org-a');
        // Token rotation inside the same organization retains its verified snapshot on fetch failure.
        quotaUnavailable = true;
        await refreshQuotaSnapshot(key, context);
        expect(getQuotaSnapshotEntry(key).snapshot?.providerOrganizationId).toBe('org-a');
        // A temporary failure to read current credentials does not erase already verified data.
        credentialUnavailable = true;
        await refreshQuotaSnapshot(key, context);
        expect(getQuotaSnapshotEntry(key).snapshot?.providerOrganizationId).toBe('org-a');
        credentialUnavailable = false;
        // A new credential context cannot retain or rehydrate the old organization's cloud usage.
        currentOrganization = 'org-b';
        await refreshQuotaSnapshot(key, context);
        expect(getQuotaSnapshotEntry(key).snapshot).toBeNull();
    });

    it('invalidates a known context change as soon as the canonical credential write succeeds while retaining same-context rotation', async () => {
        let currentOrganization = 'org-a';
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getServerFetchUrl(input).pathname;
            if (url.endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.endsWith('/credential')) return String(init?.method ?? 'GET') === 'POST'
                ? Response.json({ success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })
                : Response.json({ content: { t: 'plain', v: credential(currentOrganization) } });
            if (url.endsWith('/quotas/refresh')) return Response.json({ success: true });
            if (url.endsWith('/quotas')) return Response.json({ content: { t: 'plain', v: quota('org-a') }, metadata });
            return new Response('', { status: 200 });
        }));
        const { resolveAuthCredentialsScopeKey } = await import('@/auth/storage/resolveAuthCredentialsScopeKey');
        const context = { credentials, credentialScope: resolveAuthCredentialsScopeKey(credentials), serviceId: 'claude-subscription', profileId: 'work', resolveAccountMode: async () => 'plain' as const } as const;
        const key = buildQuotaSnapshotScopeKey(context.credentialScope, context.serviceId, context.profileId);
        await refreshQuotaSnapshot(key, context);
        await storeConnectedServiceCredentialForAccount(credentials, { serviceId: context.serviceId, profileId: context.profileId, record: credential('org-a') });
        expect(getQuotaSnapshotEntry(key).snapshot?.providerOrganizationId).toBe('org-a');
        currentOrganization = 'org-b';
        await storeConnectedServiceCredentialForAccount(credentials, { serviceId: context.serviceId, profileId: context.profileId, record: credential('org-b') });
        expect(getQuotaSnapshotEntry(key).snapshot).toBeNull();
    });

    it('does not let an older in-flight quota read repopulate a context invalidated by a successful credential write', async () => {
        let currentOrganization = 'org-a';
        let releaseQuota: ((response: Response) => void) | undefined;
        let quotaStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => { quotaStarted = resolve; });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getServerFetchUrl(input).pathname;
            if (url.endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.endsWith('/credential')) return String(init?.method ?? 'GET') === 'POST'
                ? Response.json({ success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' })
                : Response.json({ content: { t: 'plain', v: credential(currentOrganization) } });
            if (url.endsWith('/quotas/refresh')) return Response.json({ success: true });
            if (url.endsWith('/quotas')) return await new Promise<Response>((resolve) => { releaseQuota = resolve; quotaStarted?.(); });
            return new Response('', { status: 200 });
        }));
        const { resolveAuthCredentialsScopeKey } = await import('@/auth/storage/resolveAuthCredentialsScopeKey');
        const context = { credentials, credentialScope: resolveAuthCredentialsScopeKey(credentials), serviceId: 'claude-subscription', profileId: 'work', resolveAccountMode: async () => 'plain' as const } as const;
        const key = buildQuotaSnapshotScopeKey(context.credentialScope, context.serviceId, context.profileId);
        const load = refreshQuotaSnapshot(key, context);
        await started;
        currentOrganization = 'org-b';
        await storeConnectedServiceCredentialForAccount(credentials, { serviceId: context.serviceId, profileId: context.profileId, record: credential('org-b') });
        releaseQuota?.(Response.json({ content: { t: 'plain', v: quota('org-a') }, metadata }));
        await load;
        expect(getQuotaSnapshotEntry(key).snapshot).toBeNull();
    });

    it('does not infer an organization from a released relay quota projection that only carries the user identity', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = getServerFetchUrl(input).pathname;
            if (url.endsWith('/quotas/refresh')) return Response.json({ success: true });
            if (url.endsWith('/credential')) return Response.json({ content: { t: 'plain', v: credential('org-b') } });
            if (url.endsWith('/quotas')) return Response.json({ content: { t: 'plain', v: quota() }, metadata });
            return new Response('', { status: 200 });
        }));
        const context = { credentials, credentialScope: 'legacy', serviceId: 'claude-subscription', profileId: 'work', resolveAccountMode: async () => 'plain' as const } as const;
        const key = buildQuotaSnapshotScopeKey(context.credentialScope, context.serviceId, context.profileId);
        await refreshQuotaSnapshot(key, context);
        expect(getQuotaSnapshotEntry(key).error).toBeNull();
        expect(getQuotaSnapshotEntry(key).snapshot).toBeNull();
    });
});
