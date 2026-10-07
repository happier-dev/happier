import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';

const featureState = vi.hoisted(() => ({
    browser: true,
    viewTargets: true,
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

installTerminalRouteCommonModuleMocks();
await initializeTerminalRouteRuntimeForTests();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
async function configureBrowserFeatures(browser: boolean, viewTargets: boolean) {
    featureState.browser = browser;
    featureState.viewTargets = viewTargets;
    const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    if (!connection) throw new Error('Expected the real Browser test Home');
    const snapshot = await getServerFeaturesSnapshot({ serverId: connection.home.id, force: true });
    expect(snapshot.status).toBe('ready');
}
beforeEach(async () => {
    featureState.browser = true;
    featureState.viewTargets = true;
    connection = await restoreServerAccountForTest({ serverUrl: 'https://browser-open-home.example.test', request: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
            browser: { enabled: featureState.browser, viewTargets: { enabled: featureState.viewTargets } },
        } }));
        return new Response('{}', { status: 404 });
    } });
});
afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
});

describe('BrowserSurfaceOpenButton', () => {
    it('opens when browser surface features are enabled', async () => {
        const { BrowserSurfaceOpenButton } = await import('./BrowserSurfaceOpenButton');
        const onPress = vi.fn();
        await configureBrowserFeatures(true, true);

        const screen = await renderScreen(
            <BrowserSurfaceOpenButton size={44} testID="browser-open" onPress={onPress} />,
        );

        expect(screen.findByTestId('browser-open')?.props.accessibilityState).toMatchObject({ disabled: false, busy: false });
        expect(screen.findByTestId('browser-open')?.props.accessibilityLabel).toBe('browserSurface.openA11y');

        await screen.pressByTestIdAsync('browser-open');

        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('is discoverable but disabled when browser view targets are not enabled', async () => {
        const { BrowserSurfaceOpenButton } = await import('./BrowserSurfaceOpenButton');
        const onPress = vi.fn();
        await configureBrowserFeatures(true, false);

        const screen = await renderScreen(
            <BrowserSurfaceOpenButton size={44} testID="browser-open" onPress={onPress} />,
        );

        const button = screen.findByTestId('browser-open');
        expect(button?.props.accessibilityState).toMatchObject({ disabled: true, busy: false });
        expect(button?.props.accessibilityLabel).toBe('browserSurface.openDisabledA11y');

        await screen.pressByTestIdAsync('browser-open');

        expect(onPress).not.toHaveBeenCalled();
    });

    it('routes the disabled hint through the owner-copy mapper and never renders a raw internal code', async () => {
        const { BrowserSurfaceOpenButton } = await import('./BrowserSurfaceOpenButton');

        // browser feature off → the hint must carry product copy, not the raw `browser_disabled` code.
        await configureBrowserFeatures(false, true);
        const onBrowserOffPress = vi.fn();
        const browserOffScreen = await renderScreen(
            <BrowserSurfaceOpenButton size={44} testID="browser-open" onPress={onBrowserOffPress} />,
        );
        const browserOffHint = browserOffScreen.findByTestId('browser-open')?.props.accessibilityHint as string;
        expect(browserOffHint).not.toContain('browser_disabled');
        expect(browserOffHint).not.toContain('disabled:');
        expect(browserOffHint).toBe('browserShell.unavailable.surface.disabled');
        await browserOffScreen.pressByTestIdAsync('browser-open');
        expect(onBrowserOffPress).not.toHaveBeenCalled();

        // view-targets off → product copy for the view-targets surface state, not the raw token.
        await configureBrowserFeatures(true, false);
        const viewTargetsOffScreen = await renderScreen(
            <BrowserSurfaceOpenButton size={44} testID="browser-open" onPress={vi.fn()} />,
        );
        const viewTargetsOffHint = viewTargetsOffScreen.findByTestId('browser-open')?.props.accessibilityHint as string;
        expect(viewTargetsOffHint).not.toContain('view_targets_disabled');
        expect(viewTargetsOffHint).toBe('browserShell.unavailable.surface.viewTargetsDisabled');
    });
});
