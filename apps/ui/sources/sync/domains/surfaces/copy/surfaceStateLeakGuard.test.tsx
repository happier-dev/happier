import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

/**
 * L0-3 (RU2 capstone) — the standing cross-surface jargon leak-guard.
 *
 * Renders the terminal-state component of each of the four surfaces (browser,
 * simulator/stream, local services*, plugins) with hostile machine inputs and
 * FAILS if any raw reason code / bare enum / uuid / `runtime_unavailable`
 * token reaches primary UI text, or if a raw code is announced as an
 * accessibility label (XS-4 inversion).
 *
 * *Local-services state rows are guarded by the sibling
 * `serviceSurfaceClosure.test.ts`; this suite covers the shared
 * `SurfaceStateCard` those rows and the other surfaces compose.
 */

const RAW_TOKEN = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PROBE_UUID = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';

function expectNoMachineTokens(text: string, label: string): void {
    expect(text, `${label}: raw snake_case token leaked into primary UI text`).not.toMatch(RAW_TOKEN);
    expect(text, `${label}: uuid leaked into primary UI text`).not.toMatch(UUID);
    expect(text, `${label}: runtime_unavailable leaked`).not.toContain('runtime_unavailable');
}

function expectNoRawA11yLabel(screen: Awaited<ReturnType<typeof renderScreen>>, codes: readonly string[], label: string): void {
    for (const code of codes) {
        const nodes = screen.findAll((node) => node.props?.accessibilityLabel === code);
        expect(nodes, `${label}: raw code "${code}" used as accessibilityLabel (XS-4)`).toHaveLength(0);
    }
}

describe('surface terminal states never leak machine vocabulary (L0-3 closure)', () => {
    it('browser frame unavailable state', async () => {
        const { BrowserFrameUnavailable } = await import('@/components/browser/frame/BrowserFrameUnavailable');
        const screen = await renderScreen(
            <BrowserFrameUnavailable testID="frame" reasonCode="sidecar_runtime_unavailable" />,
        );
        expectNoMachineTokens(screen.getTextContent(), 'BrowserFrameUnavailable');
        expectNoRawA11yLabel(screen, ['sidecar_runtime_unavailable'], 'BrowserFrameUnavailable');
    });

    it('stream player fallback state', async () => {
        const { StreamFallbackRenderer } = await import('@/components/stream/StreamFallbackRenderer');
        const screen = await renderScreen(
            <StreamFallbackRenderer testID="stream" kind="unavailable" reasonCode="webcodecs_decoder_unavailable" />,
        );
        expectNoMachineTokens(screen.getTextContent(), 'StreamFallbackRenderer');
        expectNoRawA11yLabel(screen, ['webcodecs_decoder_unavailable'], 'StreamFallbackRenderer');
        // The raw code stays reachable for QA on the testID channel.
        expect(screen.findByTestId('stream-unavailable-reason-webcodecs_decoder_unavailable')).toBeTruthy();
    });

    it('simulator unavailable state', async () => {
        const { SimulatorUnavailableState } = await import('@/components/devices/simulator/SimulatorUnavailableState');
        const screen = await renderScreen(
            <SimulatorUnavailableState testID="simulator-stream" reasonCode="stream_error" />,
        );
        expectNoMachineTokens(screen.getTextContent(), 'SimulatorUnavailableState');
        expectNoRawA11yLabel(screen, ['stream_error'], 'SimulatorUnavailableState');
    });

    it('plugin react-native unavailable state', async () => {
        const { PluginReactNativeUnavailable } = await import('@/components/plugins/reactNative/PluginReactNativeUnavailable');
        const screen = await renderScreen(
            <PluginReactNativeUnavailable diagnostics={['crash_threshold_reached', 'runtime_unavailable', PROBE_UUID]} />,
        );
        expectNoMachineTokens(screen.getTextContent(), 'PluginReactNativeUnavailable');
        expectNoRawA11yLabel(screen, ['crash_threshold_reached', 'runtime_unavailable'], 'PluginReactNativeUnavailable');
    });

    it('plugin hosted-web unavailable state', async () => {
        const { PluginHostedWebUnavailable } = await import('@/components/plugins/hostedWeb/PluginHostedWebUnavailable');
        const screen = await renderScreen(<PluginHostedWebUnavailable />);
        expectNoMachineTokens(screen.getTextContent(), 'PluginHostedWebUnavailable');
    });

    it('shared SurfaceStateCard never renders its diagnostic code', async () => {
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="card"
                kind="unavailable"
                title="Unavailable"
                reason="Human copy only."
                diagnosticCode={`runtime_unavailable:${PROBE_UUID}`}
            />,
        );
        expectNoMachineTokens(screen.getTextContent(), 'SurfaceStateCard');
    });
});
