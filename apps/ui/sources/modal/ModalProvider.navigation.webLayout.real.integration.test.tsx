// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { installModalComponentCommonModuleMocks } from './components/modalComponentTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const expo = vi.hoisted(() => ({ push: (_href: string) => {}, back: () => {} }));
installModalComponentCommonModuleMocks({ reactNative: async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
} });
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => window.location.pathname, router: { push: value => expo.push(String(value)), back: () => expo.back() },
}).module);
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
const { useDestinationRouter } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { CurrentRouteLocationProvider, readCurrentRouteLocation } = await import('@/components/appShell/workspace/currentRouteLocation');
const { BROWSER_HISTORY_NAVIGATION_CHANGED, trackBrowserHistoryNavigation } = await import('@/utils/navigation/browserHistoryNavigation');

it('yields pointer and keyboard ownership to Machine Setup and restores the same draft on Back', async () => {
    const from = '/projects';
    const setup = '/machines/machine-a?serverId=home-a&tab=setup';
    const before = window.location.href;
    const previousState: unknown = window.history.state;
    const viewport = { width: 1440, height: 900 };
    const stopTracking = trackBrowserHistoryNavigation(window.history, () => {
        window.dispatchEvent(new Event(BROWSER_HISTORY_NAVIGATION_CHANGED));
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let changeLocation: (href: string) => void = () => {};
    let navigationAccepted = false;
    function Draft() {
        const router = useDestinationRouter();
        const [name, setName] = React.useState('');
        return <>
            <label>Project name <input data-testid="draft-name" value={name}
                onInput={event => setName(event.currentTarget.value)} /></label>
            <button data-testid="review-setup" onClick={() => router.pushRetainingCurrent(setup as never)}>Review setup</button>
        </>;
    }
    function Route() {
        const [href, setHref] = React.useState(from);
        changeLocation = setHref;
        const location = React.useMemo(() => readCurrentRouteLocation(href, {}), [href]);
        return <CurrentRouteLocationProvider value={location}>
            {href === from
                ? <button data-testid="deploy-entry" onClick={() => Modal.show({ component: Draft })}>Deploy</button>
                : <>
                    <button data-testid="previous" onClick={() => expo.back()}>Previous</button>
                    <button data-testid="add-recipe" onClick={() => document.querySelector('output')!.append('recipe')}>Add recipe</button>
                    <button data-testid="reopen-deploy" onClick={() => Modal.show({ component: Draft })}>Deploy</button>
                    <output />
                </>}
        </CurrentRouteLocationProvider>;
    }
    const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
    const draft = () => document.querySelector<HTMLInputElement>('[data-testid="draft-name"]');
    try {
        // The native/router adapter commits a location just as the workspace or Expo publishes one.
        window.history.replaceState(null, '', from);
        expo.push = href => {
            if (!navigationAccepted) return;
            window.history.pushState(null, '', href);
            changeLocation(href);
        };
        expo.back = () => {
            window.history.replaceState(null, '', from);
            changeLocation(from);
        };
        await act(async () => root.render(<ModalProvider><Route /></ModalProvider>));
        await act(async () => button('deploy-entry').click());
        const originalInput = draft()!;
        expect(originalInput).toBeInstanceOf(HTMLInputElement);
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(originalInput, 'nginx deployment');
            originalInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(originalInput.value).toBe('nginx deployment');
        await act(async () => button('review-setup').click());
        expect(window.location.pathname).toBe(from);
        expect(draft()?.closest('[role=dialog]')?.hasAttribute('inert')).toBe(false);

        navigationAccepted = true;
        await act(async () => button('review-setup').click());
        expect(window.location.pathname + window.location.search).toBe(setup);
        const destination = await measureWebLayout(document.body, { viewport });
        expect(destination.rect('previous').receivesPointer).toBe(true);
        expect(destination.rect('add-recipe').receivesPointer).toBe(true);
        await act(async () => {
            button('add-recipe').focus();
            button('add-recipe').click();
        });
        expect(document.activeElement).toBe(button('add-recipe'));
        expect(document.querySelector('output')?.textContent).toBe('recipe');
        await act(async () => button('previous').click());
        expect(draft()).toBe(originalInput);
        expect(draft()!.value).toBe('nginx deployment');
        const restored = await measureWebLayout(document.body, { viewport });
        expect(restored.rect('review-setup').receivesPointer).toBe(true);

        // The same entry can also resume the parked dialog directly from the destination.
        await act(async () => button('review-setup').click());
        await act(async () => button('reopen-deploy').click());
        expect(draft()).toBe(originalInput);
        expect(draft()!.value).toBe('nginx deployment');
        expect(draft()?.closest('[role=dialog]')?.hasAttribute('inert')).toBe(false);
    } finally {
        await act(async () => root.unmount());
        stopTracking();
        window.history.replaceState(previousState, '', before);
        container.remove();
    }
});
