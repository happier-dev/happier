import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { upsertServerProfile, setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { qualifyPluginAccountSecretBindingKey } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installApprovalCommonModuleMocks();
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let localStorageBoundary: ReturnType<typeof installLocalStorageMock> | undefined;
let webLocksBoundary: ReturnType<typeof installWebLockManagerMock> | undefined;
afterEach(async () => {
    await connection?.dispose();
    connection = null;
    invalidateAccountEncryptionModeCache();
    vi.restoreAllMocks();
    webLocksBoundary?.restore();
    localStorageBoundary?.restore();
    webLocksBoundary = undefined;
    localStorageBoundary = undefined;
});

describe('Account plugin erase managed responsibility frontdoor', () => {
    it.each([
        { outcome: 'review', focusedHome: 'target' },
        { outcome: 'unknown', focusedHome: 'target' },
        { outcome: 'review', focusedHome: 'other' },
        { outcome: 'manual-retry', focusedHome: 'target' },
        { outcome: 'retired-review', focusedHome: 'target' },
    ] as const)('preserves plugin settings and exact Home before authoritative data settlement ($outcome, $focusedHome focused)', async ({ outcome, focusedHome }) => {
        if (outcome === 'retired-review') {
            localStorageBoundary = installLocalStorageMock();
            webLocksBoundary = installWebLockManagerMock();
        }
        const targetUrl = 'https://erase-target.test';
        const otherUrl = 'https://erase-other.test';
        const activeUrl = focusedHome === 'target' ? targetUrl : otherUrl;
        const accountFor = (origin: string) => origin === targetUrl ? 'account-a' : 'account-b';
        const identityFor = (origin: string) => origin === targetUrl ? 'srv_erase_target' : 'srv_erase_other';
        const resource = {
            managedId: 'managed-a', homeId: identityFor(targetUrl), custodianAccountId: accountFor(targetUrl), intentRevision: 3,
            controller: { machineId: 'controller-a', installationId: 'installation-a' },
            provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, allocation: 'bound' as const,
            resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' },
                schemaVersion: 1, value: { name: 'retained-guest-a' } },
        };
        const erases: string[] = [];
        const settingsWrites: string[] = [];
        const effects: string[] = [];
        const dispositions = [{ managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
            expectedAllocation: resource.allocation, expectedResource: resource.resource, responsibility: 'manual' as const }];
        const settings = { pluginSecretBindingsV1: {
            [qualifyPluginAccountSecretBindingKey({ pluginId: 'happier.machine.lima', localId: 'credential' })]: {
                pluginId: 'happier.machine.lima', custody: 'account', localId: 'credential',
                savedSecretId: 'secret-a', createdForBinding: false,
            },
        } };
        const persistedSettings = new Map<string, unknown>([[targetUrl, settings], [otherUrl, settings]]);
        const settingsVersions = new Map([[targetUrl, 1], [otherUrl, 1]]);
        let startBodyRead!: () => void;
        const bodyReadStarted = new Promise<void>(resolve => { startBodyRead = resolve; });
        let releaseBody!: () => void;
        const bodyReleased = new Promise<void>(resolve => { releaseBody = resolve; });
        const request = async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            expect([targetUrl, otherUrl]).toContain(url.origin);
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') {
                return Response.json(createRootLayoutFeaturesResponse({
                    capabilities: { serverIdentity: { serverIdentityId: identityFor(url.origin) } },
                }));
            }
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') {
                return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: settingsVersions.get(url.origin) }));
            }
            if (url.pathname === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    settingsWrites.push(url.origin);
                    effects.push('settings');
                    const body = JSON.parse(String(init.body)) as { content: { t: string; v: unknown }; expectedVersion: number };
                    if (body.expectedVersion !== settingsVersions.get(url.origin)) {
                        return Response.json({ success: false, error: 'version-mismatch', version: settingsVersions.get(url.origin),
                            content: { t: 'plain', v: persistedSettings.get(url.origin) } });
                    }
                    persistedSettings.set(url.origin, body.content.v);
                    const version = body.expectedVersion + 1;
                    settingsVersions.set(url.origin, version);
                    return Response.json({ success: true, version });
                }
                return Response.json({ content: { t: 'plain', v: persistedSettings.get(url.origin) }, version: settingsVersions.get(url.origin) });
            }
            if (url.pathname === '/v1/artifacts') return Response.json([]);
            if (url.pathname === '/v1/plugins/data/account-erase') {
                expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + createAccountTokenForTests(accountFor(url.origin), { currentAccount: true }));
                erases.push(url.origin);
                effects.push('data');
                const reviewed = { ...resource, homeId: identityFor(url.origin), custodianAccountId: accountFor(url.origin) };
                if (outcome === 'retired-review') {
                    // Genuine streamed HTTP bytes: no eager pull before the
                    // real JSON reader asks. Honor transport cancellation just
                    // as fetch does, so a green cancellation path falsifies
                    // the suspected late private-fact disclosure.
                    const stream = new ReadableStream<Uint8Array>({
                        start(controller) {
                            const abort = () => controller.error(new DOMException('The request was aborted', 'AbortError'));
                            if (init?.signal?.aborted) abort();
                            else init?.signal?.addEventListener('abort', abort, { once: true });
                        },
                        async pull(controller) {
                            startBodyRead();
                            await bodyReleased;
                            if (init?.signal?.aborted) return;
                            controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: 'managed_resources_review_required', resources: [reviewed] })));
                            controller.close();
                        },
                    }, { highWaterMark: 0 });
                    return new Response(stream, { status: 409, headers: { 'Content-Type': 'application/json' } });
                }
                if (outcome === 'manual-retry') {
                    const body = JSON.parse(String(init?.body)) as { managedResourceDispositions?: unknown };
                    return JSON.stringify(body.managedResourceDispositions) === JSON.stringify(dispositions)
                        ? Response.json({ status: 'erased', changed: true })
                        : Response.json({ error: 'managed_resources_review_required', resources: [reviewed] }, { status: 409 });
                }
                return outcome === 'review'
                    ? Response.json({ error: 'managed_resources_review_required', resources: [reviewed] }, { status: 409 })
                    : Response.json({ error: 'unavailable' }, { status: 503 });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        connection = await restoreServerAccountForTest({
            serverUrl: activeUrl, serverIdentityId: identityFor(activeUrl), accountId: accountFor(activeUrl),
            credentials: { token: createAccountTokenForTests(accountFor(activeUrl), { currentAccount: true }) }, request,
        });
        await upsertServerProfile({ serverUrl: targetUrl });
        const target = await setServerProfileIdentityForUrl(targetUrl, identityFor(targetUrl));
        if (!target) throw new Error('The target Home fixture must establish its advertised identity');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async url => ({
            token: createAccountTokenForTests(accountFor(url), { currentAccount: true }),
        }));
        // Both Homes answer only at the genuine HTTP boundary. Sync, Account
        // lifetime, Settings census and Action admission remain real.
        setRuntimeFetch(request);
        await expect(getSyncSingleton().mutateAccountSettingsOnce({
            expectedSettingsScope: { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId: accountFor(activeUrl) },
            expectedSettingsVersion: 1, mutate: raw => ({ settings: { ...raw }, value: undefined }),
        })).resolves.toMatchObject({ status: 'applied' });
        const execution = createDefaultActionExecutor().execute('account.plugins.data.erase', {
            pluginId: 'happier.machine.lima',
            ...(outcome === 'manual-retry' ? { managedResourceDispositions: dispositions } : {}),
        }, {
            serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user',
            presentUserConfirmation: { actionId: 'account.plugins.data.erase' },
        });
        if (outcome === 'retired-review') {
            const boundary = await Promise.race([
                bodyReadStarted.then(() => ({ kind: 'reading' as const })),
                execution.then(result => ({ kind: 'settled' as const, result })),
            ]);
            expect(boundary, JSON.stringify(boundary)).toEqual({ kind: 'reading' });
            expect(await TokenStorage.setCredentialsForServerUrl(targetUrl, { serverId: target.id }, {
                token: createAccountTokenForTests('replacement-account', { currentAccount: true }),
            })).toBe(true);
            releaseBody();
        }
        const result = await execution;
        expect(erases, JSON.stringify(result)).toEqual([targetUrl]);
        if (outcome === 'retired-review') {
            expect(result).toEqual({ ok: true, result: { status: 'partial',
                settings: { status: 'pending', reason: 'unavailable' }, data: { status: 'pending', reason: 'outcome-unknown' } } });
            expect(settingsWrites).toEqual([]);
            expect(persistedSettings.get(targetUrl)).toEqual(settings);
            return;
        }
        if (outcome === 'manual-retry') {
            expect(result).toEqual({ ok: true, result: { status: 'completed',
                settings: { status: 'completed', changed: true }, data: { status: 'completed', changed: true } } });
            expect(settingsWrites).toEqual([targetUrl]);
            expect(effects).toEqual(['data', 'settings']);
            expect(persistedSettings.get(targetUrl)).not.toHaveProperty('pluginSecretBindingsV1');
            expect(persistedSettings.get(otherUrl)).toEqual(settings);
            return;
        }
        expect(result).toMatchObject(outcome === 'review'
            ? { ok: true, result: { status: 'reviewRequired', resources: [resource] } }
            : { ok: true, result: { status: 'partial', settings: { status: 'pending', reason: 'unavailable' }, data: { status: 'pending', reason: 'outcome-unknown' } } });
        expect(settingsWrites).toEqual([]);
        expect(persistedSettings.get(targetUrl)).toEqual(settings);
        expect(persistedSettings.get(otherUrl)).toEqual(settings);
    });
});
