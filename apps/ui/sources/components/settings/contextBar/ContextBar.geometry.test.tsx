// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

vi.unmock('@/components/ui/icons/Icon');
vi.unmock('@/components/ui/icons/iconRegistry.generated');
vi.unmock('@/components/ui/icons/iconRegistryHuge.generated');

installSettingsViewCommonModuleMocks({
    reactNative: () => vi.importActual('react-native-web'),
    storage: 'real',
    text: () => vi.importActual('@/text'),
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await import('react-native');
    const mock = createReanimatedModuleMock();
    const Animated = { ...mock.default, View: native.View, ScrollView: native.ScrollView, Text: native.Text };
    return { ...mock, ...Animated, default: Animated };
});

const { ContextBar } = await import('./ContextBar');
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
const { Dimensions } = await import('react-native');
const { getIconFamily, setIconFamily } = await import('@/components/ui/icons/iconFamily');

it.each(['hugeicons', 'phosphor'] as const)('keeps Assets and Registries Browse and glyph (%s) inside every phone and desktop ancestor', async family => {
    installWebLayoutBridge();
    const previousFamily = getIconFamily();
    setIconFamily(family);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        for (const width of [390, 1100, 1440]) {
            Object.defineProperties(window, { innerWidth: { configurable: true, value: width },
                innerHeight: { configurable: true, value: 844 } });
            Object.defineProperties(document.documentElement, { clientWidth: { configurable: true, value: width },
                clientHeight: { configurable: true, value: 844 } });
            await act(async () => {
                window.dispatchEvent(new Event('resize'));
                root.render(<ItemList testID="context-page"><ItemGroup title="Project">
                    <ContextBar mode="workspace_only" workspace={{
                        value: '/home/user/a-long-project-directory/with-a-long-name',
                        placeholder: 'Project directory', testID: 'project-path', onChange: () => {},
                        browse: { machineId: 'machine-1', serverId: 'home-1', enabled: true },
                    }} />
                </ItemGroup></ItemList>);
            });
            expect(Dimensions.get('window')).toMatchObject({ width, height: 844 });
            // Label the real glyph DOM for measurement, without adding a production-only test seam.
            const button = host.querySelector('[data-testid="path-browser-trigger"]');
            expect(button).not.toBeNull();
            const glyph = button!.querySelector('svg') ?? button!.firstElementChild;
            expect(glyph).not.toBeNull();
            glyph!.setAttribute('data-testid', 'browse-glyph');
            const ancestors: Array<{ id: string; containsButton: boolean }> = [];
            for (let parent = glyph!.parentElement; parent && parent !== host; parent = parent.parentElement) {
                const id = parent.getAttribute('data-testid') ?? `browse-parent-${ancestors.length}`;
                parent.setAttribute('data-testid', id);
                ancestors.push({ id, containsButton: parent.contains(button) });
            }
            const measured = await measureWebLayout(host, { viewport: { width, height: 844 },
                focusedTestId: 'project-path', settle: replay => act(replay) });
            const page = measured.rect('context-page');
            const input = measured.rect('project-path');
            const browse = measured.rect('path-browser-trigger');
            const icon = measured.rect('browse-glyph');
            console.log('ContextBar geometry', JSON.stringify({ family, width, page, input, browse, icon }));
            expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth! + 1);
            expect(page.scrollLeft).toBe(0);
            expect(input.width).toBeGreaterThan(0);
            expect(browse.width).toBeGreaterThan(0);
            expect(browse.height).toBeGreaterThan(0);
            expect(browse.clipped).toBe(false);
            expect(browse.left).toBeGreaterThanOrEqual(0);
            expect(browse.right).toBeLessThanOrEqual(width);
            expect(input.right).toBeLessThanOrEqual(browse.left);
            expect(icon.width).toBeGreaterThan(0);
            expect(icon.left).toBeGreaterThanOrEqual(browse.left);
            expect(icon.right).toBeLessThanOrEqual(browse.right);
            expect(icon.top).toBeGreaterThanOrEqual(browse.top);
            expect(icon.bottom).toBeLessThanOrEqual(browse.bottom);
            // The renderer's `clipped` flag describes intrinsic scroll overflow,
            // not the intersection with ancestors. Check actual containment too.
            for (const { id, containsButton } of ancestors) {
                const ancestor = measured.rect(id);
                for (const target of containsButton ? [icon, browse] : [icon]) {
                    expect(target.left, id).toBeGreaterThanOrEqual(ancestor.left - 1);
                    expect(target.right, id).toBeLessThanOrEqual(ancestor.right + 1);
                    expect(target.top, id).toBeGreaterThanOrEqual(ancestor.top - 1);
                    expect(target.bottom, id).toBeLessThanOrEqual(ancestor.bottom + 1);
                }
            }
        }
    } finally {
        await act(async () => root.unmount());
        setIconFamily(previousFamily);
        host.remove();
    }
});
