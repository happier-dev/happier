import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import * as React from 'react';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { BrowserProfileV1 } from '@happier-dev/protocol/browser/profile/v1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { BrowserProfileStatus } = await import('./BrowserProfileStatus');
const { Modal } = await import('@/modal');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');

afterEach(async () => { await standardCleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await homes.reset(); });
afterAll(async () => { await network.dispose(); });

it('creates, selects and deletes saved profiles from the mounted controls through admitted Machine Actions', async () => {
    vi.stubGlobal('crypto', globalThis.crypto ?? webcrypto);
    const serverUrl = 'https://saved-profile-controls.test';
    const serverIdentityId = 'srv_saved_profile_controls';
    const serverId = await homes.addHome({ name: 'Profile Home', serverUrl, serverIdentityId, accountId: 'owner', currentAccount: true });
    await network.addHome(serverUrl, 'owner', { serverIdentityId });
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    let profiles: BrowserProfileV1[] = [];
    for (const actionId of ['browser.profile.list', 'browser.profile.create', 'browser.profile.select', 'browser.profile.delete']) {
        homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(request.target).toEqual({ kind: 'machine', machineId: 'machine' });
            const input = request.input as { profileId: string; displayName: string };
            if (actionId === 'browser.profile.create') profiles = [{ profileId: input.profileId, displayName: input.displayName,
                storageMode: 'user', owner: { kind: 'user', id: input.profileId }, lifecycleState: 'active', cleanupOnSessionClose: false }];
            if (actionId === 'browser.profile.delete') profiles = [];
            const result = actionId === 'browser.profile.select' ? { v: 1, commandId: 'select', status: 'dispatched', events: [] }
                : actionId === 'browser.profile.list' ? { status: 'ready', profiles }
                : actionId === 'browser.profile.create' ? { status: 'created', profile: profiles[0] }
                    : { status: 'deleted', profileId: input.profileId };
            return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
        } });
    }
    network.setHttpResponder(async (input, init) => new URL(String(input)).pathname.startsWith('/v1/machines/') ? null : homes.request(input, init));
    const features = FeaturesResponseSchema.parse({ features: {
        browser: { enabled: true, internal: { enabled: true }, viewTargets: { enabled: true } },
    } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const disposeLoader = await installRealActionExecutorModuleLoader();
    // Modal presentation is the human-input boundary; the mounted Action execution stays real.
    vi.spyOn(Modal, 'prompt').mockResolvedValue('Work');
    vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    const onSelected = vi.fn();
    const screen = await renderScreen(<BrowserProfileStatus testID="profiles" model={{ profile: null,
        management: { source: { scope, machineId: 'machine', selection: {
            command: { kind: 'openView', browserSessionId: 'session', viewId: 'view', platform: 'web',
                target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test' } }, onSelected,
        } } } }} />);
    try {
        await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/actions/browser.profile.list')).toHaveLength(1));
        await screen.pressByTestIdAsync('profiles-profile-create');
        await waitForHomeGovernance(() => expect(profiles[0]?.displayName).toBe('Work'));
        const profileId = profiles[0]!.profileId;
        await waitForHomeGovernance(() => expect(screen.findByTestId(`profiles-profile-delete-${profileId}`)).toBeTruthy());
        await screen.pressByTestIdAsync(`profiles-profile-select-${profileId}`);
        await waitForHomeGovernance(() => expect(onSelected).toHaveBeenCalledWith(profiles[0], []));
        expect(homes.requestsFor('/v1/actions/browser.profile.select')[0]?.body).toMatchObject({
            input: { profileId, machineId: 'machine', kind: 'openView', browserSessionId: 'session', viewId: 'view' },
        });
        await screen.pressByTestIdAsync(`profiles-profile-delete-${profileId}`);
        await waitForHomeGovernance(() => expect(profiles).toEqual([]));
        await waitForHomeGovernance(() => expect(screen.findByTestId(`profiles-profile-delete-${profileId}`)).toBeFalsy());
    } finally { await screen.unmount(); disposeLoader(); }
});
