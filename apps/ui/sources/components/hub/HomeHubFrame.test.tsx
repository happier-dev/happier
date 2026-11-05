import * as React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPluginUiTestkit, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';

import { readHostAccessibility, renderScreen } from '@/dev/testkit';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { PluginReactNativeSurface } from '@/components/plugins/reactNative/PluginReactNativeSurface';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { HomeHubFrame } from './HomeHubFrame';

// The viewport is a platform boundary; Home framing, focus owners and the native renderer stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const surface = createPluginSurfaceContextFixture();
let fixture: PluginUiTestkit;
beforeAll(async () => {
    // The SDK fixture owns the public context and Host API contract. Rendering below uses the real
    // native surface; this test never dispatches a native Host API request or queries semantic nodes.
    fixture = await createPluginUiTestkit({
        identity: { instanceId: 'home-input', mountNonce: 'home-input' },
        authorPlugin: { id: 'com.acme.fixture', version: '1.0.0' },
        surface: null,
        surfaceContext: surface,
        adapter: { mount: async () => ({ snapshot: async () => ({ revision: 0, nodes: [] }),
            update: async () => {}, invoke: async () => {}, dispose: async () => {} }) },
    });
});
const module = { renderSurface: () => <input data-testid="home-widget-input" aria-label="Home note" style={{ width: 200, height: 44 }} /> };

// This is the generalized host's existing eligibility handoff to the real native surface/boundary.
function HomePluginSurface() {
    const focusEligible = usePluginSurfaceFocusEligibility();
    return <PluginReactNativeSurface surfaceId="home-input" decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
        module={module} renderContext={fixture.context} interactionEnabled focusEligible={focusEligible} />;
}

afterAll(async () => { await fixture?.dispose(); });

describe('HomeHubFrame phone presentation', () => {
    it.each([390, 500])('makes the visible native widget input interactive at %s without a surrounding workspace owner', async width => {
        const screen = await renderScreen(<HomeHubFrame focused style={{ width }}><HomePluginSurface /></HomeHubFrame>);
        try {
            const input = screen.findHostByTestId('home-widget-input');
            expect(input).not.toBeNull();
            if (!input) throw new Error('Expected the real native surface input');
            expect(readHitArea(input).width).toBeGreaterThan(0);
            expect(readHostAccessibility(input)).toEqual({ inert: false, hidden: false, pointerBlocked: false });
            expect(input.props.disabled).not.toBe(true);
            expect(input.props.tabIndex ?? 0).toBeGreaterThanOrEqual(0);
            await screen.update(<HomeHubFrame focused={false} style={{ width }}><HomePluginSurface /></HomeHubFrame>);
            expect(readHostAccessibility(screen.findHostByTestId('home-widget-input')!)).toEqual({ inert: true, hidden: true, pointerBlocked: true });
        } finally { await screen.unmount(); }
    });

    it('keeps a genuinely hidden retained column inert even when its Home remains focused', async () => {
        const tree = (active: boolean) => <RetainedPanelSurface isActive={active} testID="retained-home">
            <HomeHubFrame focused style={{ width: 390 }}><HomePluginSurface /></HomeHubFrame>
        </RetainedPanelSurface>;
        const screen = await renderScreen(tree(true));
        try {
            expect(screen.findHostByTestId('home-widget-input')).not.toBeNull();
            await screen.update(tree(false));
            expect(screen.findHostByTestId('retained-home')?.props).toMatchObject({ inert: true, 'aria-hidden': true });
            expect(readHostAccessibility(screen.findHostByTestId('home-widget-input')!)).toEqual({ inert: true, hidden: true, pointerBlocked: true });
            expect(screen.findHostByTestId('plugin-surface-snapshot:home-input')?.props).toMatchObject({ inert: true, 'aria-hidden': true });
        } finally { await screen.unmount(); }
    });
});
