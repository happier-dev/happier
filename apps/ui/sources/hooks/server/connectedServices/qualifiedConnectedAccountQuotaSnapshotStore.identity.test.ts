import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { createQualifiedQuotaTestHarness, quotaTestResponse, quotaTestSnapshot } from './qualifiedConnectedAccountQuotaTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { flushHookEffects } from '@/dev/testkit';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import * as store from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { runConnectedAccountAuthenticationCommand } from '@/sync/ops/connectedAccounts/connectedAccountDaemon';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();

const ref = { service: { pluginId: 'acme.organization-quota', localId: 'subscription' }, accountId: 'work' };
const snapshot = { ...quotaTestSnapshot, ref, providerOrganizationId: 'org-a' };
let organizationId: string | null;
let providerAccountId: string | null;
let credentialFailure: boolean;
let boundary: Awaited<ReturnType<typeof createQualifiedQuotaTestHarness>>;
async function flush(key?: string) {
    await flushHookEffects();
    if (key) await vi.waitFor(() => expect(store.getQualifiedQuotaSnapshotEntry(key)).toMatchObject({ loading: false, read: true }));
}
function profile(org: string | null, credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS', accountId: string | null = 'provider-work') {
    return AccountProfileSchema.parse({ id: 'quota-account', connectedAccountsV4: [{
        ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision, configurationReady: false, configurationRevision: null,
        providerIdentity: { accountId, organizationId: org }, scopes: [],
    }] });
}

function installUsageDescriptor(requiresOrganization: boolean, providerId?: string): void {
    installConnectedAccountDescriptorProjection({ scopeKey: getActiveServerSnapshot().serverId, status: 'ready', conflicts: [], errorReason: null,
        descriptors: [{ id: ref.service.localId, pluginId: ref.service.pluginId, serviceId: ref.service.localId, title: 'Quota account',
            provenance: 'external', sourceKind: 'installed', authentication: { defaultModeId: 'manual', modes: [] },
            ...(requiresOrganization || providerId ? { usageIdentity: {
                ...(requiresOrganization ? { requiredContext: 'organization' as const } : {}),
                ...(providerId ? { providerId } : {}),
            } } : {}), capabilities: ['usage'],
            availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }] });
}

describe('qualified quota current credential organization', () => {
    beforeEach(async () => {
        store.__resetQualifiedConnectedAccountQuotaSnapshotStore();
        organizationId = 'org-a'; providerAccountId = 'provider-work'; credentialFailure = false;
        boundary = await createQualifiedQuotaTestHarness({ request: async input => {
            if (new URL(String(input)).pathname !== '/v4/connect/qualified/credential') return null;
            if (credentialFailure) return Response.json({ error: 'offline' }, { status: 400 });
            return Response.json(QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
                ref, authenticationModeId: 'manual', revisionSemantics: 'revisioned',
                credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null,
                content: { t: 'plain', v: {} }, metadata: { scopes: [], providerIdentity: {
                    ...(providerAccountId === null ? {} : { accountId: providerAccountId }), ...(organizationId === null ? {} : { organizationId }),
                } },
            }));
        } });
        installUsageDescriptor(true);
        storage.getState().applyProfile(profile('org-a'));
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(snapshot)));
    });
    afterEach(async () => {
        store.__resetQualifiedConnectedAccountQuotaSnapshotStore();
        installConnectedAccountDescriptorProjection({ scopeKey: '', status: 'loading', descriptors: [], conflicts: [], errorReason: null });
        await boundary.dispose(); vi.restoreAllMocks();
    });

    it.each(['org-b', null])('never admits cloud usage for a successful current credential context %s', async org => {
        organizationId = org;
        const context = boundary.context(ref); const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        store.loadQualifiedQuotaSnapshotOnce(key, context); await flush(key);
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot).toBeNull();
    });

    it('retains verified data on credential transport failure and same-organization rotation, but clears changed context before a quota failure', async () => {
        const context = boundary.context(ref); const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        store.loadQualifiedQuotaSnapshotOnce(key, context); await flush(key);
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot?.providerOrganizationId).toBe('org-a');
        boundary.read.mockImplementation(async () => Response.json({ error: 'offline' }, { status: 400 }));
        await store.reloadQualifiedQuotaSnapshotAfterRecovery({ ref, serverBasis: context.serverBasis });
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot?.providerOrganizationId).toBe('org-a');
        credentialFailure = true;
        await store.reloadQualifiedQuotaSnapshotAfterRecovery({ ref, serverBasis: context.serverBasis });
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot?.providerOrganizationId).toBe('org-a');
        credentialFailure = false; organizationId = 'org-b';
        await store.reloadQualifiedQuotaSnapshotAfterRecovery({ ref, serverBasis: context.serverBasis });
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot).toBeNull();
    });

    it('retires cache-only data and a held old read as soon as the qualified Profile changes organization', async () => {
        const context = boundary.context(ref); const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        store.loadQualifiedQuotaSnapshotOnce(key, context); await flush(key);
        let finish!: (response: Response) => void;
        boundary.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pending = store.reloadQualifiedQuotaSnapshotAfterRecovery({ ref, serverBasis: context.serverBasis });
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        organizationId = 'org-b'; storage.getState().applyProfile(profile('org-b'));
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot).toBeNull();
        finish(Response.json(quotaTestResponse(snapshot))); await pending; await flush();
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot).toBeNull();
    });

    it('retires previously verified data when a new Profile credential revision still has unknown organization', async () => {
        storage.getState().applyProfile(profile(null));
        const context = boundary.context(ref); const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        store.loadQualifiedQuotaSnapshotOnce(key, context); await flush(key);
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot?.providerOrganizationId).toBe('org-a');
        storage.getState().applyProfile(profile(null, 'csr_1123456789ABCDEFGHJKMNPQRS'));
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot).toBeNull();
    });

    it('PC-4 visits only changed account references when an account array is replaced', async () => {
        installUsageDescriptor(false);
        const baseline = profile('org-a');
        let referenceReads = 0;
        const accounts = Array.from({ length: 200 }, (_, index) => {
            const accountRef = { ...ref, accountId: `account-${index}` };
            return { ...baseline.connectedAccountsV4[0]!, get ref() { referenceReads++; return accountRef; } };
        });
        storage.setState({ profile: { ...baseline, connectedAccountsV4: accounts } });
        const { providerOrganizationId: _organizationId, ...accountSnapshot } = snapshot;
        boundary.read.mockImplementation(async accountRef => Response.json(quotaTestResponse({ ...accountSnapshot, ref: accountRef })));
        const contexts = accounts.slice(0, 100).map(account => boundary.context(account.ref));
        const keys = contexts.map(context => store.buildQualifiedQuotaSnapshotScopeKey(context));
        contexts.forEach((context, index) => store.loadQualifiedQuotaSnapshotOnce(keys[index]!, context));
        await vi.waitFor(() => expect(keys.every(key => store.getQualifiedQuotaSnapshotEntry(key).read)).toBe(true));
        expect(keys.every(key => store.getQualifiedQuotaSnapshotEntry(key).snapshot !== null)).toBe(true);
        const held = keys.map(key => store.getQualifiedQuotaSnapshotEntry(key));

        referenceReads = 0;
        storage.setState({ profile: { ...baseline, connectedAccountsV4: [...accounts] } });
        expect(referenceReads).toBe(0);
        keys.forEach((key, index) => expect(store.getQualifiedQuotaSnapshotEntry(key)).toBe(held[index]));

        const changed = { ...accounts[0]!, providerIdentity: { accountId: 'provider-work', organizationId: 'org-b' } };
        referenceReads = 0;
        storage.setState({ profile: { ...baseline, connectedAccountsV4: [changed, ...accounts.slice(1)] } });
        expect(referenceReads).toBeLessThanOrEqual(1);
        expect(store.getQualifiedQuotaSnapshotEntry(keys[0]!).snapshot).toBeNull();
        keys.slice(1).forEach((key, index) => expect(store.getQualifiedQuotaSnapshotEntry(key)).toBe(held[index + 1]));
    });

    it.each(['same', 'changed', 'unknown'] as const)('handles a non-organization Profile replacement with %s user identity', async change => {
        installUsageDescriptor(false);
        organizationId = null;
        storage.getState().applyProfile(profile(null));
        const { providerOrganizationId: _organizationId, ...accountSnapshot } = snapshot;
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(accountSnapshot)));
        const context = boundary.context(ref); const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        store.loadQualifiedQuotaSnapshotOnce(key, context); await flush(key);
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot?.activeAccountId).toBe('provider-work');
        storage.getState().applyProfile(profile(null, 'csr_1123456789ABCDEFGHJKMNPQRS',
            change === 'unknown' ? null : change === 'changed' ? 'provider-other' : 'provider-work'));
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot?.activeAccountId ?? null).toBe(change === 'same' ? 'provider-work' : null);
        if (change !== 'same') expect(store.getQualifiedQuotaSnapshotEntry(key).usageRecordId).toBeNull();
    });

    it('rejects a non-organization quota whose observed provider differs from the declared provider', async () => {
        installUsageDescriptor(false, 'anthropic');
        organizationId = null;
        storage.getState().applyProfile(profile(null));
        const { providerOrganizationId: _organizationId, ...accountSnapshot } = snapshot;
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse({ ...accountSnapshot, providerId: 'openai' })));
        const context = boundary.context(ref); const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        store.loadQualifiedQuotaSnapshotOnce(key, context); await flush(key);
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot).toBeNull();
        expect(store.getQualifiedQuotaSnapshotEntry(key).usageRecordId).toBeNull();
    });

    it.each(['same', 'changed', 'unknown', 'unreadable'] as const)('revalidates a successful non-organization credential replacement with %s user identity', async change => {
        installUsageDescriptor(false);
        organizationId = null;
        storage.getState().applyProfile(profile(null));
        const { providerOrganizationId: _organizationId, ...accountSnapshot } = snapshot;
        boundary.read.mockImplementation(async () => Response.json(quotaTestResponse(accountSnapshot)));
        const context = boundary.context(ref); const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        store.loadQualifiedQuotaSnapshotOnce(key, context); await flush(key);
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot?.activeAccountId).toBe('provider-work');
        const receipt = { status: 'connected' as const, attemptId: 'attempt-replacement', account: ref };
        boundary.socket.mockImplementation(async <R>(_machineId: string, method: string): Promise<R> => {
            if (method !== CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD) throw new Error('Unexpected RPC');
            return receipt as R;
        });
        credentialFailure = change === 'unreadable';
        providerAccountId = change === 'unknown' ? null : change === 'changed' ? 'provider-other' : 'provider-work';
        boundary.read.mockImplementation(async () => Response.json({ error: 'offline' }, { status: 400 }));
        expect(await runConnectedAccountAuthenticationCommand({
            serverId: context.serverBasis.serverId, machineId: 'machine-selected', expectedActiveServer: context.serverBasis,
            command: { operation: 'submitManual', attemptId: 'attempt-replacement', fields: { token: 'fixture-token' } },
        })).toEqual(receipt);
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot?.activeAccountId ?? null).toBe(change === 'same' ? 'provider-work' : null);
        if (change !== 'same') expect(store.getQualifiedQuotaSnapshotEntry(key).usageRecordId).toBeNull();
    });

    it.each(['same', 'changed', 'unreadable'] as const)('revalidates an acknowledged %s credential replacement before returning its connected receipt', async change => {
        const context = boundary.context(ref); const key = store.buildQualifiedQuotaSnapshotScopeKey(context);
        store.loadQualifiedQuotaSnapshotOnce(key, context); await flush(key);
        const receipt = { status: 'connected' as const, attemptId: 'attempt-replacement', account: ref };
        boundary.socket.mockImplementation(async <R>(_machineId: string, method: string): Promise<R> => {
            if (method !== CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD) throw new Error('Unexpected RPC');
            return receipt as R;
        });
        credentialFailure = change === 'unreadable';
        organizationId = change === 'changed' ? 'org-b' : 'org-a';
        boundary.read.mockImplementation(async () => Response.json({ error: 'offline' }, { status: 400 }));
        const result = await runConnectedAccountAuthenticationCommand({
            serverId: context.serverBasis.serverId, machineId: 'machine-selected',
            expectedActiveServer: context.serverBasis,
            command: { operation: 'submitManual', attemptId: 'attempt-replacement', fields: { token: 'fixture-token' } },
        });
        expect(result).toEqual(receipt);
        expect(store.getQualifiedQuotaSnapshotEntry(key).snapshot?.providerOrganizationId ?? null).toBe(change === 'same' ? 'org-a' : null);
    });
});
