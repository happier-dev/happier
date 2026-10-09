import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { useQualifiedConnectedAccountTargetPresentations } from './useQualifiedConnectedAccountTargetPresentations';
import { useConnectedMetadataCatalog } from './useConnectedMetadataCatalog';

installApprovalCommonModuleMocks();
afterEach(() => { retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks(); });
const service = { pluginId: 'custom.safe-profile', localId: 'compute' };
const ref = { service, accountId: 'opaque-profile-routing-id' };
const targets = [{ key: 'credential:0', target: { kind: 'account' as const, account: ref }, serviceTitle: 'Cloud' }];
const profile = (id: string, displayName: string) => ({ ...profileDefaults, id, connectedAccountsV4: [{ ref, displayName,
    status: 'connected' as const, authenticationModeId: 'manual', revisionSemantics: 'revisioned' as const,
    credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });

describe('captured Home qualified Account presentation', () => {
    it.each(['unauthorized', 'forbidden', 'offline'] as const)('withdraws sensitive catalog labels on %s admission loss, retaining them only offline', async (failure) => {
        const browserStorage = installLocalStorageMock();
        const browserLocks = installWebLockManagerMock();
        let hook: Readonly<{ unmount(): Promise<void> }> | undefined;
        let failMetadataReads = false;
        const rejectedMetadataPaths: string[] = [];
        const transportError = new TypeError('Network request failed');
        try {
            const target = await upsertAndActivateServer({ serverUrl: `https://catalog-admission-${failure}.test`, scope: 'tab' });
            await setServerProfileIdentityForUrl(target.serverUrl, `srv_catalog_admission_${failure}`);
            const owner = `catalog-${failure}-owner`;
            expect(await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id },
                { token: createAccountTokenForTests(owner, { currentAccount: true }) })).toBe(true);
            setRuntimeFetch(async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
                if (failMetadataReads && (path === '/v1/account/entity-rows/connected-metadata/presentation'
                    || path === '/v1/account/entity-rows/connected-metadata/acknowledgements')) {
                    rejectedMetadataPaths.push(path);
                    if (failure === 'offline') throw transportError;
                    return Response.json({ error: failure }, { status: failure === 'unauthorized' ? 401 : 403 });
                }
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/account/profile') return Response.json(profile(owner, 'Native display name'));
                if (path === '/v1/account/entity-rows/connected-metadata/presentation') return Response.json({
                    status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [
                        { v: 1, subject: { kind: 'account', account: ref }, label: 'Private catalog label' },
                    ] } },
                });
                if (path === '/v1/account/entity-rows/connected-metadata/acknowledgements') return Response.json({
                    status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [] } },
                });
                return Response.json({ error: 'not_found' }, { status: 404 });
            });
            const rendered = await renderHook(() => {
                const { binding } = useServerCredentialAccountScopeBinding(target.id);
                return useConnectedMetadataCatalog(binding?.scope ?? null);
            }, { flushOptions: { cycles: 30 } });
            hook = rendered;
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(Object.values(rendered.getCurrent().labelsByKey)).toContain('Private catalog label');
            });
            failMetadataReads = true;
            await act(async () => publishHomeAccountChange(target.id));
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(rejectedMetadataPaths).toContain('/v1/account/entity-rows/connected-metadata/presentation');
                expect(rendered.getCurrent().presentation).toMatchObject({ status: 'unavailable', reason: failure === 'offline' ? 'unreachable' : failure });
                expect(Object.values(rendered.getCurrent().labelsByKey)).toEqual(failure === 'offline' ? ['Private catalog label'] : []);
            });
        } finally { await hook?.unmount(); browserLocks.restore(); browserStorage.restore(); }
    });
    it('renders the canonical presentation row while obsolete Settings loading remains pending', async () => {
        const browserStorage = installLocalStorageMock();
        const browserLocks = installWebLockManagerMock();
        const settingsReply = createDeferred<Response>();
        let hook: Readonly<{ unmount(): Promise<void> }> | undefined;
        try {
            const target = await upsertAndActivateServer({ serverUrl: 'https://safe-profile-catalog.test', scope: 'tab' });
            await setServerProfileIdentityForUrl(target.serverUrl, 'srv_safe_profile_catalog');
            expect(await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id },
                { token: createAccountTokenForTests('catalog-owner', { currentAccount: true }) })).toBe(true);
            setRuntimeFetch(async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
                if (path === '/v2/account/settings') return settingsReply.promise;
                if (path === '/v1/account/profile') return Response.json(profile('catalog-owner', 'Native display name'));
                if (path === '/v1/account/entity-rows/connected-metadata/presentation') return Response.json({
                    status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [
                        { v: 1, subject: { kind: 'account', account: ref }, label: 'Canonical custom label' },
                    ] } },
                });
                if (path === '/v1/account/entity-rows/connected-metadata/acknowledgements') return Response.json({
                    status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [] } },
                });
                return Response.json({ error: 'not_found' }, { status: 404 });
            });
            const rendered = await renderHook(() => {
                const { binding } = useServerCredentialAccountScopeBinding(target.id);
                return useQualifiedConnectedAccountTargetPresentations({ binding, targets });
            }, { flushOptions: { cycles: 30 } });
            hook = rendered;
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(rendered.getCurrent().presentationsByKey['credential:0']?.primaryLabel).toBe('Canonical custom label');
            });
        } finally {
            settingsReply.resolve(Response.json({ content: { t: 'plain', v: {} }, version: 1 }));
            await hook?.unmount(); browserLocks.restore(); browserStorage.restore();
        }
    });
    it('withdraws labels and rejects a late original-profile response after the exact credential lifetime retires', async () => {
        const browserStorage = installLocalStorageMock();
        const browserLocks = installWebLockManagerMock();
        let hook: Readonly<{ unmount(): Promise<void> }> | undefined;
        try {
            const target = await upsertAndActivateServer({ serverUrl: 'https://safe-profile-retirement.test', scope: 'tab' });
            await setServerProfileIdentityForUrl(target.serverUrl, 'srv_safe_profile_retirement');
            const credentials = { token: createAccountTokenForTests('original-profile-owner', { currentAccount: true }) };
            expect(await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, credentials)).toBe(true);
            const delayed = createDeferred<Response>();
            let profileReads = 0;
            let delayProfileResponses = false;
            setRuntimeFetch(async (input, init) => {
                const url = new URL(String(input));
                expect(url.origin).toBe(target.serverUrl);
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
                if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (url.pathname === '/v1/account/entity-rows/connected-metadata/presentation') {
                    return Response.json({ status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [
                        { v: 1, subject: { kind: 'account', account: ref }, label: 'Original Work' },
                    ] } } });
                }
                if (url.pathname === '/v1/account/entity-rows/connected-metadata/acknowledgements') {
                    return Response.json({ status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [] } } });
                }
                if (url.pathname === '/v1/account/profile') {
                    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
                    profileReads += 1;
                    return delayProfileResponses ? delayed.promise : Response.json(profile('original-profile-owner', 'Original provider name'));
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            });
            const rendered = await renderHook(() => {
                const { binding } = useServerCredentialAccountScopeBinding(target.id);
                return useQualifiedConnectedAccountTargetPresentations({ binding, targets });
            }, { flushOptions: { cycles: 30 } });
            hook = rendered;
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(rendered.getCurrent().presentationsByKey['credential:0']?.primaryLabel).toBe('Original Work');
            });
            const initialProfileReads = profileReads;
            delayProfileResponses = true;
            await act(async () => publishHomeAccountChange(target.id));
            await flushHookEffects({ cycles: 20 });
            expect(profileReads).toBeGreaterThan(initialProfileReads);
            expect(rendered.getCurrent().presentationsByKey['credential:0']?.primaryLabel).toBe('Original Work');
            await act(async () => {
                expect(await TokenStorage.removeCredentialsForServerUrl(target.serverUrl, { serverId: target.id })).toBe(true);
            });
            await flushHookEffects({ cycles: 20 });
            expect(rendered.getCurrent().presentationsByKey['credential:0']?.primaryLabel).toBe('common.unavailable');
            await act(async () => delayed.resolve(Response.json(profile('original-profile-owner', 'Late Original Work'))));
            await flushHookEffects({ cycles: 20 });
            expect(rendered.getCurrent().presentationsByKey['credential:0']?.primaryLabel).toBe('common.unavailable');
            expect(JSON.stringify(rendered.getCurrent())).not.toContain('Late Original Work');
            expect(JSON.stringify(rendered.getCurrent().presentationsByKey)).not.toContain(ref.accountId);
        } finally { await hook?.unmount(); browserLocks.restore(); browserStorage.restore(); }
    });

    it('does not disclose a valid profile returned for a different Account than the captured bearer', async () => {
        const browserStorage = installLocalStorageMock();
        const browserLocks = installWebLockManagerMock();
        let hook: Readonly<{ unmount(): Promise<void> }> | undefined;
        try {
            const target = await upsertAndActivateServer({ serverUrl: 'https://safe-profile-subject.test', scope: 'tab' });
            await setServerProfileIdentityForUrl(target.serverUrl, 'srv_safe_profile_subject');
            expect(await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id },
                { token: createAccountTokenForTests('profile-owner', { currentAccount: true }) })).toBe(true);
            const reads: string[] = [];
            setRuntimeFetch(async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/account/entity-rows/connected-metadata/presentation'
                    || path === '/v1/account/entity-rows/connected-metadata/acknowledgements') {
                    return Response.json({ status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [] } } });
                }
                if (path === '/v1/account/profile') { reads.push(path); return Response.json(profile('different-owner', 'Other Account label')); }
                return Response.json({ error: 'not_found' }, { status: 404 });
            });
            const rendered = await renderHook(() => {
                const { binding } = useServerCredentialAccountScopeBinding(target.id);
                return useQualifiedConnectedAccountTargetPresentations({ binding, targets });
            }, { flushOptions: { cycles: 30 } });
            hook = rendered;
            expect(reads).toContain('/v1/account/profile');
            expect(rendered.getCurrent()).toMatchObject({ error: 'qualified_account_profile_unavailable', loading: false,
                presentationsByKey: { 'credential:0': { primaryLabel: 'common.unavailable' } } });
            expect(JSON.stringify(rendered.getCurrent())).not.toContain('Other Account label');
        } finally { await hook?.unmount(); browserLocks.restore(); browserStorage.restore(); }
    });
});
