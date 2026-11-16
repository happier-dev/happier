// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { BrowserProfileV1 } from '@happier-dev/protocol/browser/profile/v1';

import { standardCleanup } from '@/dev/testkit';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

const viewport = vi.hoisted(() => ({ width: 1280, height: 577 }));
// HTTP and native rendering are boundaries; the Privacy panel, Action execution, Legend and portal stay real.
installSettingsViewCommonModuleMocks({ storage: 'real', reactNative: async () => ({
    ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
    useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
}), text: () => vi.importActual('@/text') });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { BrowserPrivacyPopover } = await import('./BrowserPrivacyPopover');
const { PopoverScope } = await import('@/components/ui/popover/PopoverScope');
const { View, StyleSheet } = await import('react-native');
const { RemoteViewerStage } = await import('@/components/stream/RemoteViewerStage');
const { LiveStreamInputLayer } = await import('@/components/stream/LiveStreamInputLayer');
const { RetainedPresentationSlotBinder, RetainedPresentationSlotsProvider } = await import('@/components/ui/presentation/retainedPresentationSlots');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
afterAll(async () => { await network.dispose(); });
afterEach(async () => { await standardCleanup(); await homes.reset(); });

// Captured desktop corridor: Privacy is centred near (1190, 107), above the retained stream.
const fixturePane = { x: 800, y: 66, width: 432, height: 511 };
const pictureViewport = { width: fixturePane.width, height: fixturePane.height - 100 };
const supportsInput = () => true;
const ignoreGesture = () => {};

function RetainedPrivacyBrowser(props: React.ComponentProps<typeof BrowserPrivacyPopover>) {
    const boundary = React.useRef<React.ComponentRef<typeof View>>(null);
    return <RetainedPresentationSlotsProvider>
        <View ref={boundary} style={{ position: 'absolute', left: fixturePane.x, top: fixturePane.y,
            width: fixturePane.width, height: fixturePane.height, overflow: 'hidden' }}>
            <PopoverScope boundaryRef={boundary}>
                {/* The fixture supplies geometry at the platform boundary; the real binder still decides placement and context. */}
                <RetainedPresentationSlotBinder slotId="privacy-browser" windowGeometry={fixturePane} windowClipGeometry={fixturePane}>
                    <View style={{ flex: 1, minHeight: 0 }}>
                        <View style={{ position: 'absolute', left: 373, top: 24 }}>
                            <BrowserPrivacyPopover {...props} />
                        </View>
                        <View style={{ position: 'absolute', left: 0, right: 0, top: 100, bottom: 0 }}>
                            <RemoteViewerStage enabled viewport={pictureViewport} testID="streamed" renderInput={controls => (
                                <View style={StyleSheet.absoluteFillObject}>
                                    <LiveStreamInputLayer inputAccepted supports={supportsInput} mode={controls.mode} localZoom
                                        zoomReset={controls.zoomReset} onViewTransformChange={controls.onViewTransformChange}
                                        renderCursor={controls.renderCursor} renderDragTrail={controls.renderDragTrail}
                                        viewport={pictureViewport} onGesture={ignoreGesture} testID="streamed-input" />
                                </View>
                            )}>{null}</RemoteViewerStage>
                        </View>
                    </View>
                </RetainedPresentationSlotBinder>
            </PopoverScope>
        </View>
    </RetainedPresentationSlotsProvider>;
}

it('keeps New profile reachable and scrolls to a lower saved profile in the short desktop Privacy popover', async () => {
    installWebLayoutBridge();
    const serverUrl = 'https://profile-pointer.test';
    const serverIdentityId = 'srv_profile_pointer';
    const serverId = await homes.addHome({ name: 'Profile Home', serverUrl, serverIdentityId, accountId: 'owner', currentAccount: true });
    await network.addHome(serverUrl, 'owner', { serverIdentityId });
    network.resetRequests();
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    const profiles: BrowserProfileV1[] = Array.from({ length: 16 }, (_, index) => ({
        profileId: `profile-${index}`, displayName: `Profile ${index + 1}`, storageMode: 'user',
        owner: { kind: 'user', id: 'owner' }, lifecycleState: 'active', cleanupOnSessionClose: false,
    }));
    homes.answer(serverId, '/v1/actions/browser.profile.list', { select: body => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
        return { body: { v: 1, actionId: 'browser.profile.list', requestId: request.requestId,
            execution: { ok: true, result: { status: 'ready', profiles } } } };
    } });
    network.setHttpResponder(async (input, init) => new URL(String(input)).pathname.startsWith('/v1/machines/') ? null : homes.request(input, init));
    const features = FeaturesResponseSchema.parse({ features: {
        browser: { enabled: true, internal: { enabled: true }, viewTargets: { enabled: true } },
    } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const disposeLoader = await installRealActionExecutorModuleLoader();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<div style={{ position: 'fixed', inset: 0, overflow: 'hidden', zIndex: 1 }}>
            <RetainedPrivacyBrowser testID="privacy" model={{ profile: null,
                management: { source: { scope, machineId: 'machine', selection: {
                    command: { kind: 'openView', browserSessionId: 'session', viewId: 'view', platform: 'web', focus: true,
                        target: { kind: 'externalUrl', targetId: 'page', url: 'https://example.test' } },
                    onSelected() {},
                } } } }} />
        </div>));
        await act(async () => document.querySelector<HTMLElement>('[data-testid="privacy"]')!.click());
        await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/actions/browser.profile.list')).toHaveLength(1));
        const layout = await measureWebLayout(document.body, { viewport, settle: replay => act(replay) });
        const firstMoreId = 'privacy-status-profile-more-profile-0';
        // The tenth row's centre was already below the captured 577px viewport.
        const lowerMoreId = 'privacy-status-profile-more-profile-9';
        const createId = 'privacy-status-profile-create';
        const panel = layout.rect('privacy-panel');
        for (const testId of [firstMoreId, createId]) {
            const action = layout.rect(testId);
            expect(action.height, testId).toBeGreaterThan(0);
            expect(action.top, testId).toBeGreaterThanOrEqual(panel.top);
            expect(action.bottom, testId).toBeLessThanOrEqual(Math.min(viewport.height, panel.bottom));
            expect(action.receivesPointer, testId).toBe(true);
        }
        // Native browser focus scrolls the real rendered list; no synthetic row geometry or internal list mock.
        const scrolled = await measureWebLayout(document.body, { viewport, focusedTestId: lowerMoreId });
        const lowerAction = scrolled.rect(lowerMoreId);
        expect(lowerAction.top).toBeGreaterThanOrEqual(panel.top);
        expect(lowerAction.bottom).toBeLessThanOrEqual(scrolled.rect(createId).top);
        expect(lowerAction.receivesPointer).toBe(true);
        expect(scrolled.rect(firstMoreId).top).toBeLessThan(layout.rect(firstMoreId).top);
        expect(scrolled.rect(createId).top).toBeCloseTo(layout.rect(createId).top, 0);
        expect(scrolled.rect(createId).receivesPointer).toBe(true);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        disposeLoader();
    }
});
