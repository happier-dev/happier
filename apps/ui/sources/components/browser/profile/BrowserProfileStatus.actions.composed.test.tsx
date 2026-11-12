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

afterEach(async () => { await standardCleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await homes.reset(); });
afterAll(async () => { await network.dispose(); });

it.each(['none', 'select', 'delete', 'unavailable', 'refused', 'closed'] as const)('delivers saved-profile mutations and reasons during %s', async (retireDuring) => {
    vi.stubGlobal('crypto', globalThis.crypto ?? webcrypto);
    const serverUrl = 'https://saved-profile-controls.test';
    const serverIdentityId = 'srv_saved_profile_controls';
    const serverId = await homes.addHome({ name: 'Profile Home', serverUrl, serverIdentityId, accountId: 'owner', currentAccount: true });
    await network.addHome(serverUrl, 'owner', { serverIdentityId });
    network.resetRequests();
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    let profiles: BrowserProfileV1[] = retireDuring === 'closed'
        ? ['work-a', 'work-b', 'unnamed-a', 'unnamed-b'].map(profileId => ({ profileId,
            ...(profileId.startsWith('work') ? { displayName: 'Work' } : {}),
            storageMode: 'user', owner: { kind: 'user', id: 'owner' }, lifecycleState: 'active', cleanupOnSessionClose: false }))
        : [];
    let deleteSignal: AbortSignal | null | undefined;
    let releaseSelection!: () => void;
    const selectionReceipt = new Promise<void>(resolve => { releaseSelection = resolve; });
    for (const actionId of ['browser.profile.list', 'browser.profile.create', 'browser.profile.select', 'browser.profile.delete']) {
        homes.answer(serverId, `/v1/actions/${actionId}`, { select: (body, requestContext) => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(request.target).toEqual({ kind: 'machine', machineId: 'machine' });
            const input = request.input as { profileId: string; displayName: string; commandId: string };
            if (actionId === 'browser.profile.create' && (retireDuring === 'unavailable' || retireDuring === 'refused')) {
                return { body: { v: 1, actionId, requestId: request.requestId, execution: retireDuring === 'refused'
                    ? { ok: false, errorCode: 'permission_denied', error: 'permission_denied' }
                    : { ok: true, result: { status: 'unavailable', code: 'profile_exists' } } } };
            }
            if (actionId === 'browser.profile.create') profiles = [{ profileId: input.profileId, displayName: input.displayName,
                storageMode: 'user', owner: { kind: 'user', id: input.profileId }, lifecycleState: 'active', cleanupOnSessionClose: false }];
            if (actionId === 'browser.profile.delete') { profiles = []; deleteSignal = requestContext.signal; }
            const result = actionId === 'browser.profile.select' ? { v: 1, commandId: input.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] }
                : actionId === 'browser.profile.list' ? { status: 'ready', profiles }
                : actionId === 'browser.profile.create' ? { status: 'created', profile: profiles[0] }
                    : { status: 'deleted', profileId: input.profileId };
            return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } },
                ...(actionId === `browser.profile.${retireDuring}` ? { respondAfter: selectionReceipt } : {}) };
        } });
    }
    network.setHttpResponder(async (input, init) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname.startsWith('/v1/machines/')) return null;
        return homes.request(input, init);
    });
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
    const alert = vi.spyOn(Modal, 'alert');
    const onSelected = vi.fn();
    await act(async () => harness.root.render(<div id="virtualized-list-host"><BrowserProfileStatus testID="profiles" model={{ profile: null,
        management: { source: { scope, machineId: 'machine', selection: retireDuring === 'closed' ? undefined : {
            command: { kind: 'openView', browserSessionId: 'session', viewId: 'view', platform: 'web',
                target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test' } }, onSelected,
    } } } }} /></div>));
    try {
        await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/actions/browser.profile.list')).toHaveLength(1));
        if (retireDuring === 'closed') {
            const { t } = await import('@/text');
            await waitForHomeGovernance(async () => {
                await harness.flush();
                const rows = profiles.map(profile => harness.container.querySelector<HTMLElement>(
                    `[data-testid="profiles-profile-select-${profile.profileId}"]`));
                expect(rows.every(Boolean)).toBe(true);
                expect(new Set(rows.map(row => row!.getAttribute('aria-label'))).size).toBe(profiles.length);
                rows.forEach((row, index) => {
                    expect(row!.getAttribute('aria-disabled')).toBe('true');
                    expect(row!.textContent).toContain(profiles[index]!.profileId);
                    expect(row!.getAttribute('aria-label')).toContain(profiles[index]!.profileId);
                    expect(row!.textContent).toContain(t('browserShell.profile.management.openBrowserToSwitch'));
                });
            });
            return;
        }
        await act(async () => harness.container.querySelector<HTMLElement>('[data-testid="profiles-profile-create"]')!.click());
        if (retireDuring === 'unavailable' || retireDuring === 'refused') {
            const { t } = await import('@/text');
            await waitForHomeGovernance(() => expect(alert).toHaveBeenCalledWith(t('common.error'),
                retireDuring === 'refused' ? t('errors.permissionDenied') : t('browserShell.profile.management.profileExists')));
            expect(profiles).toEqual([]);
            return;
        }
        await waitForHomeGovernance(() => expect(profiles[0]?.displayName).toBe('Work'));
        const profileId = profiles[0]!.profileId;
        await waitForHomeGovernance(async () => {
            await harness.flush();
            expect(harness.container.querySelector(`[data-testid="profiles-profile-more-${profileId}"]`)).toBeTruthy();
            expect(harness.container.querySelector(`[data-testid="profiles-profile-select-${profileId}"]`)?.getAttribute('aria-disabled')).not.toBe('true');
        });
        await act(async () => harness.container.querySelector<HTMLElement>(`[data-testid="profiles-profile-select-${profileId}"]`)!.click());
        await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/actions/browser.profile.select')).toHaveLength(1));
        if (retireDuring === 'select') {
            // A profile switch closes the old native view before its terminal HTTP receipt.
            await act(async () => harness.root.render(null));
            releaseSelection();
        }
        await waitForHomeGovernance(() => expect(onSelected).toHaveBeenCalledWith(profiles[0], []));
        expect(homes.requestsFor('/v1/actions/browser.profile.select')[0]?.input).toMatchObject({
            input: { profileId, machineId: 'machine', kind: 'openView', browserSessionId: 'session', viewId: 'view' },
        });
        if (retireDuring !== 'select') {
            await waitForHomeGovernance(async () => {
                await harness.flush();
                expect(harness.container.querySelector(`[data-testid="profiles-profile-more-${profileId}"]`)).toBeTruthy();
            });
            // Delete is the row's rare, destructive operation: it waits behind the row's ⋯ menu.
            await act(async () => harness.container.querySelector<HTMLElement>(`[data-testid="profiles-profile-more-${profileId}"]`)!.click());
            await waitForHomeGovernance(() => expect(document.querySelector(`[data-testid="profiles-profile-delete-${profileId}"]`)?.getAttribute('aria-disabled')).not.toBe('true'));
            await act(async () => document.querySelector<HTMLElement>(`[data-testid="profiles-profile-delete-${profileId}"]`)!.click());
            await waitForHomeGovernance(() => expect(profiles).toEqual([]));
            if (retireDuring === 'delete') {
                // Purging the active profile also closes its view before the finite receipt.
                await act(async () => harness.root.render(null));
                expect(deleteSignal).toBeTruthy();
                expect(deleteSignal!.aborted).toBe(false);
                releaseSelection();
            }
            await waitForHomeGovernance(async () => {
                await harness.flush();
                expect(harness.container.querySelector(`[data-testid="profiles-profile-select-${profileId}"]`)?.getBoundingClientRect().height ?? 0).toBe(0);
            });
        }
    } finally { releaseSelection(); disposeLoader(); }
});
