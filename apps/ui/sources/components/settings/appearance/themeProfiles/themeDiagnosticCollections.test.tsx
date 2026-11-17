import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';

// The browser editor's platform boundary has no DOM node in the React renderer.
beforeEach(() => vi.stubGlobal('window', { innerWidth: 1440 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('reanimated-color-picker', async () => (await import('@/dev/testkit/mocks/reanimatedColorPicker')).createReanimatedColorPickerMock());
afterEach(standardCleanup);
const { StoreThemeListing } = await import('@/components/store/StoreThemeListing');

async function measure(screen: Awaited<ReturnType<typeof renderSettingsView>>, rootId: string) {
    await act(async () => {
        for (const node of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string'
            && (node.props.testID === rootId || node.props.testID.endsWith(':stage')) && typeof node.props.onLayout === 'function')) {
            node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 600 } } });
        }
    });
    await measureMountedCollections(screen, { width: 390, height: 600 });
}

function diagnosticTexts(screen: Awaited<ReturnType<typeof renderSettingsView>>, marker: string) {
    return screen.tree.findAll(node => typeof node.type === 'string' && (Array.isArray(node.props.children)
        ? node.props.children.some((child: unknown) => typeof child === 'string' && child.includes(marker))
        : typeof node.props.children === 'string' && node.props.children.includes(marker)));
}

it('windows 200 partial-install face failures through the Store page scroll owner', async () => {
    const retry = vi.fn();
    const screen = await renderSettingsView(<StoreThemeListing name="Palette" kicker="Theme" meta="Publisher" description={null}
        faces={null} facesState="error" tryingFaceId={null} preferredFaceId={null} here="This device" installed={false}
        facts={[]} busy={null} installFailures={Array.from({ length: 200 }, (_, index) => ({ faceName: `failed-face-${index}`, code: 'unavailable' }))}
        onTryFace={() => {}} onRevert={() => {}} onInstall={() => {}} onRetryFaces={retry} testID="store-diagnostics" />);
    await measure(screen, 'store-diagnostics');
    const mounted = diagnosticTexts(screen, 'failed-face-');
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(200);
    await screen.pressByTestIdAsync('store-diagnostics:retryFaces');
    expect(retry).toHaveBeenCalledOnce();
});
