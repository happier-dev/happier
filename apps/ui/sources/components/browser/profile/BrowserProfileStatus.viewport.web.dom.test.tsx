// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import * as React from 'react';
import { act } from 'react';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { BrowserProfileV1 } from '@happier-dev/protocol/browser/profile/v1';

import { standardCleanup } from '@/dev/testkit';
import { createWebListDomHarness } from '@/dev/testkit/legend/webListDomHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

// Native drawing/input and HTTP are boundaries; the profile controls, Action executor and Legend stay real.
installSettingsViewCommonModuleMocks({ storage: 'real', reactNative: () => vi.importActual('react-native-web'),
    text: () => vi.importActual('@/text') });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { BrowserProfileStatus } = await import('./BrowserProfileStatus');
const { Modal } = await import('@/modal');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');

const harness = createWebListDomHarness({ rowSelector: '[data-testid^="profiles-profile-select-"]', rowHeight: 28 });
afterEach(async () => { await standardCleanup(); await homes.reset(); });
afterAll(async () => { await network.dispose(); });

it('gives persisted profiles a visible scroll viewport and usable select/delete controls', async () => {
    vi.stubGlobal('crypto', globalThis.crypto ?? webcrypto);
    const serverUrl = 'https://profile-viewport.test';
    const serverIdentityId = 'srv_profile_viewport';
    const serverId = await homes.addHome({ name: 'Profile Home', serverUrl, serverIdentityId, accountId: 'owner', currentAccount: true });
    await network.addHome(serverUrl, 'owner', { serverIdentityId });
    network.resetRequests();
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    const work: BrowserProfileV1 = { profileId: 'work', displayName: 'Work', storageMode: 'user',
        owner: { kind: 'user', id: 'owner' }, lifecycleState: 'active', cleanupOnSessionClose: false };
    let profiles = [work];
    homes.answer(serverId, '/v1/actions/browser.profile.list', { select: body => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
        return { body: { v: 1, actionId: 'browser.profile.list', requestId: request.requestId,
            execution: { ok: true, result: { status: 'ready', profiles } } } };
    } });
    homes.answer(serverId, '/v1/actions/browser.profile.select', { select: body => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
        expect(request.input).toMatchObject({ profileId: work.profileId, machineId: 'machine' });
        return { body: { v: 1, actionId: 'browser.profile.select', requestId: request.requestId,
            execution: { ok: true, result: { v: 1, commandId: 'select', status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] } } } };
    } });
    homes.answer(serverId, '/v1/actions/browser.profile.delete', { select: body => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
        expect(request.input).toMatchObject({ profileId: work.profileId, machineId: 'machine' });
        profiles = [];
        return { body: { v: 1, actionId: 'browser.profile.delete', requestId: request.requestId,
            execution: { ok: true, result: { status: 'deleted', profileId: work.profileId } } } };
    } });
    network.setHttpResponder(async (input, init) => new URL(String(input)).pathname.startsWith('/v1/machines/') ? null : homes.request(input, init));
    const features = FeaturesResponseSchema.parse({ features: {
        browser: { enabled: true, internal: { enabled: true }, viewTargets: { enabled: true } },
    } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const disposeLoader = await installRealActionExecutorModuleLoader();
    vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    const onSelected = vi.fn();
    try {
        await act(async () => harness.root.render(<div id="virtualized-list-host">
            <BrowserProfileStatus testID="profiles" model={{ profile: null,
                management: { source: { scope, machineId: 'machine', selection: {
                    command: { kind: 'openView', browserSessionId: 'session', viewId: 'view', platform: 'web',
                        target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test' } }, onSelected,
                } } } }} />
        </div>));
        await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/actions/browser.profile.list')).toHaveLength(1));
        await harness.flush();
        const scroller = [...harness.container.querySelectorAll<HTMLElement>('[style]')]
            .find(element => element.style.overflowY === 'auto' || element.style.overflow === 'auto');
        expect(scroller).toBeTruthy();
        expect(scroller!.clientHeight).toBeGreaterThan(0);
        await waitForHomeGovernance(async () => {
            await harness.flush();
            expect(harness.container.querySelector('[data-testid="profiles-profile-select-work"]'), harness.container.textContent ?? '').toBeTruthy();
        });
        const select = harness.container.querySelector<HTMLElement>('[data-testid="profiles-profile-select-work"]')!;
        expect(scroller!.contains(select)).toBe(true);
        await act(async () => select.click());
        await waitForHomeGovernance(() => expect(onSelected).toHaveBeenCalledWith(work, []));
        await waitForHomeGovernance(async () => {
            await harness.flush();
            expect(harness.container.querySelector('[data-testid="profiles-profile-delete-work"]')?.getAttribute('aria-disabled')).not.toBe('true');
        });
        await act(async () => harness.container.querySelector<HTMLElement>('[data-testid="profiles-profile-delete-work"]')!.click());
        await waitForHomeGovernance(() => expect(profiles).toEqual([]));
        await waitForHomeGovernance(async () => {
            await harness.flush();
            expect(harness.container.querySelector('[data-testid="profiles-profile-delete-work"]')?.getBoundingClientRect().height ?? 0).toBe(0);
        });
        expect(profiles).toEqual([]);
    } finally { disposeLoader(); }
});
