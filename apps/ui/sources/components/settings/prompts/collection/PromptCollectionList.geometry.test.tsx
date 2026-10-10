// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const navigation = vi.hoisted(() => ({ pathname: '', Body: null as React.ComponentType | null,
    push: vi.fn(), redirects: [] as string[] }));
installSettingsViewCommonModuleMocks({
    reactNative: () => vi.importActual('react-native-web'), storage: 'real', text: () => vi.importActual('@/text'),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const module = createExpoRouterMock({ pathname: () => navigation.pathname, router: { push: navigation.push } }).module;
        // Expo is the platform navigator. Render its selected real route body;
        // the collection, split geometry and catalog/store logic stay real.
        return { ...module, Stack: Object.assign(() => navigation.Body ? <navigation.Body /> : null,
            { Screen: module.Stack.Screen }),
            Redirect: ({ href }: { href: string }) => { navigation.redirects.push(href); return null; } };
    },
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await import('react-native');
    const mock = createReanimatedModuleMock();
    const Animated = { ...mock.default, View: native.View, ScrollView: native.ScrollView, Text: native.Text };
    return { ...mock, ...Animated, default: Animated };
});

const { PromptCollectionLayout } = await import('./PromptCollectionList');
const { storage } = await import('@/sync/domains/state/storageStore');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const scope = { serverId: 'collection-geometry', accountId: 'account' };

it.each(['bundle', 'template'] as const)('settles the real %s phone index without clipping or redirecting away', async kind => {
    installWebLayoutBridge();
    Object.defineProperties(window, { innerWidth: { configurable: true, value: 390 },
        innerHeight: { configurable: true, value: 844 } });
    Object.defineProperties(document.documentElement, { clientWidth: { configurable: true, value: 390 },
        clientHeight: { configurable: true, value: 844 } });
    const before = storage.getState();
    storage.setState({ settingsScope: scope, isDataReady: true, artifactsLoaded: true, artifacts: {} });
    applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
        rawSettings: {}, sourceSettingsVersion: 1 }, true);
    navigation.pathname = `/settings/prompts/${kind === 'bundle' ? 'skills' : 'templates'}`;
    navigation.Body = kind === 'bundle'
        ? (await import('@/app/(app)/settings/prompts/skills/index')).WorkspaceRouteBody
        : (await import('@/app/(app)/settings/prompts/templates/index')).WorkspaceRouteBody;
    navigation.push.mockClear(); navigation.redirects = [];
    const host = document.createElement('div'); host.style.height = '844px'; document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => { window.dispatchEvent(new Event('resize')); root.render(<PromptCollectionLayout kind={kind} />); });
        const measured = await measureWebLayout(host, { viewport: { width: 390, height: 844 }, settle: replay => act(replay) });
        const frame = measured.rect(`settings-prompts-${kind}-layout`);
        const add = measured.rect(`promptLibrary.collection.${kind}.add`);
        const emptyAdd = measured.rect(`promptLibrary.collection.${kind}.emptyAdd`);
        console.log('Prompt phone geometry', JSON.stringify({ kind, frame, add, emptyAdd, redirects: navigation.redirects }));
        expect(frame.width).toBe(390);
        expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth! + 1);
        expect(navigation.redirects).toEqual([]);
        for (const control of [add, emptyAdd]) {
            expect(control.width).toBeGreaterThan(0);
            expect(control.height).toBeGreaterThan(0);
            expect(control.clipped).toBe(false);
            expect(control.left).toBeGreaterThanOrEqual(0);
            expect(control.right).toBeLessThanOrEqual(390);
            expect(control.bottom).toBeLessThanOrEqual(844);
        }
        await act(async () => {
            const button = host.querySelector<HTMLElement>(`[data-testid="promptLibrary.collection.${kind}.add"]`);
            expect(button).not.toBeNull(); button!.click();
        });
        expect(navigation.push).toHaveBeenCalledWith(`${navigation.pathname}/new`);
    } finally {
        await act(async () => root.unmount()); host.remove();
        resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests();
        storage.setState(before); navigation.Body = null;
    }
});
