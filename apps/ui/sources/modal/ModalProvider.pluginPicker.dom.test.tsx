/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { installModalComponentCommonModuleMocks } from './components/modalComponentTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installModalComponentCommonModuleMocks({ reactNative: async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
}, text: async () => await vi.importActual('@/text') });
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});
vi.mock('react-native-keyboard-controller', async () => {
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { KeyboardAvoidingView: View };
});

const { ModalProvider } = await import('./ModalProvider');
const { Modal } = await import('./ModalManager');
const { Item, ItemGroup } = await import('@happier-dev/plugin-ui/components');
const { defineUiSurface } = await import('@happier-dev/plugin-ui');
const { PluginReactNativeSurface } = await import('@/components/plugins/reactNative/PluginReactNativeSurface');
const { createCanonicalPluginReactNativeHostApiAdapter } = await import('@/components/plugins/reactNative/hostApi');
const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
const { usePluginSurfaceFocusEligibility, usePluginSurfaceCurrentUiContextEligibility } = await import(
    '@/components/ui/presentation/PluginSurfaceFocusEligibility'
);

it('lets a custom picker in the foreground modal select by pointer and keyboard without borrowing page focus', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const selected: string[] = [];
    const surface = createPluginSurfaceContextFixture({ target: { kind: 'app' } });
    const host = createCanonicalPluginReactNativeHostApiAdapter({
        surface,
        requestSurface: { pluginId: 'flowers', contributionId: 'picker', surfaceId: 'ephemeral:flowers:picker',
            placement: 'appSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
        installedMethods: ['settleEphemeralInput'],
        handleRequest: async request => {
            const payload = request.payload;
            if (request.method === 'settleEphemeralInput' && payload && typeof payload === 'object'
                && !Array.isArray(payload) && typeof payload.input === 'string') selected.push(payload.input);
            return null;
        },
    });
    const context = { plugin: { id: 'flowers', version: '1.0.0' }, surface, hostApi: host.api,
        signal: new AbortController().signal } satisfies RenderContext;
    function FlowerPicker(context: RenderContext) {
        return <ItemGroup title="Flowers">
            <Item title="Marigold" testID="picker-marigold" onPress={() => { void context.hostApi.settleEphemeralInput({ kind: 'completed', input: 'marigold' }); }} />
            <Item title="Rose" testID="picker-rose" onPress={() => { void context.hostApi.settleEphemeralInput({ kind: 'completed', input: 'rose' }); }} />
        </ItemGroup>;
    }
    const module = { renderSurface: defineUiSurface(FlowerPicker) };
    function PickerModal() {
        const eligible = usePluginSurfaceFocusEligibility();
        const currentContext = usePluginSurfaceCurrentUiContextEligibility();
        return <>
            <span data-testid="picker-current-context">{String(currentContext)}</span>
            <PluginReactNativeSurface surfaceId="ephemeral:flowers:picker" snapshotTitle="Flowers"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={module} renderContext={context} interactionEnabled focusEligible={eligible} />
        </>;
    }
    try {
        await act(async () => root.render(<ModalProvider><button>Page</button></ModalProvider>));
        let pickerModalId = '';
        await act(async () => { pickerModalId = Modal.show({ component: PickerModal }); });
        const snapshot = document.querySelector<HTMLElement>('[data-testid="plugin-surface-snapshot:ephemeral:flowers:picker"]')!;
        expect(snapshot.closest('[role="dialog"]')).not.toBeNull();
        expect(container.contains(snapshot)).toBe(false); // The production portal is used.
        expect(snapshot.hasAttribute('inert')).toBe(false);
        expect(snapshot.getAttribute('aria-hidden')).toBe('false');
        expect(document.querySelector('[data-testid="picker-current-context"]')?.textContent).toBe('false');
        const marigold = document.querySelector<HTMLElement>('[data-testid="picker-marigold"]')!;
        await act(async () => marigold.click());
        expect(selected).toEqual(['marigold']);
        const rose = document.querySelector<HTMLElement>('[data-testid="picker-rose"]')!;
        expect(rose.tagName).toBe('BUTTON');
        await act(async () => {
            rose.focus();
            const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
            rose.dispatchEvent(enter);
            // jsdom omits the browser's native button default for Enter.
            if (!enter.defaultPrevented) rose.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
            rose.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        });
        expect(document.activeElement).toBe(rose);
        expect(selected).toEqual(['marigold', 'rose']);

        let coveringModalId = '';
        await act(async () => { coveringModalId = Modal.show({ component: () => <button>Covering modal</button> }); });
        expect(snapshot.hasAttribute('inert')).toBe(true);
        expect(snapshot.getAttribute('aria-hidden')).toBe('true');
        await act(async () => Modal.hide(coveringModalId));
        expect(snapshot.hasAttribute('inert')).toBe(false);
        await act(async () => Modal.hide(pickerModalId));
        expect(snapshot.hasAttribute('inert')).toBe(true);
    } finally {
        await act(async () => root.unmount());
        host.dispose();
        container.remove();
    }
});
