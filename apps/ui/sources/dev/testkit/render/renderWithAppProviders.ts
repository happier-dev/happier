import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import * as safeAreaContext from 'react-native-safe-area-context';

import { registerStandardCleanupTarget, unregisterStandardCleanupTarget } from '../cleanup/standardCleanup';
import { flushHookEffects, type FlushHookEffectsOptions } from '../hooks/flushHookEffects';

export type RenderWithAppProvidersOptions = Readonly<{
    wrapper?: React.ComponentType<React.PropsWithChildren>;
    flushOptions?: FlushHookEffectsOptions;
    createNodeMock?: renderer.TestRendererOptions['createNodeMock'];
}>;

export type RenderWithAppProvidersResult = Readonly<{
    tree: renderer.ReactTestRenderer;
    update: (element: React.ReactElement) => Promise<void>;
    unmount: () => Promise<void>;
}>;

function applyWrapper(
    element: React.ReactElement,
    wrapper?: React.ComponentType<React.PropsWithChildren>,
): React.ReactElement {
    const safeAreaInsets = { top: 0, left: 0, right: 0, bottom: 0 };
    const safeAreaModule = safeAreaContext as unknown as Record<string, unknown>;
    const SafeAreaInsetsContext =
        safeAreaModule
        && typeof safeAreaModule === 'object'
        && 'SafeAreaInsetsContext' in safeAreaModule
            ? (safeAreaModule as { SafeAreaInsetsContext: unknown }).SafeAreaInsetsContext
            : null;

    const wrapped = SafeAreaInsetsContext && typeof SafeAreaInsetsContext === 'object' && 'Provider' in SafeAreaInsetsContext
        ? React.createElement(
            (SafeAreaInsetsContext as unknown as { Provider: React.ComponentType<any> }).Provider,
            { value: safeAreaInsets },
            element,
        )
        : element;

    if (!wrapper) return wrapped as unknown as React.ReactElement;
    return React.createElement(wrapper, null, wrapped);
}

export async function renderWithAppProviders(
    element: React.ReactElement,
    options: RenderWithAppProvidersOptions = {},
): Promise<RenderWithAppProvidersResult> {
    let tree!: renderer.ReactTestRenderer;
    const rendererOptions = options.createNodeMock
        ? { createNodeMock: options.createNodeMock }
        : undefined;

    await act(async () => {
        tree = renderer.create(applyWrapper(element, options.wrapper), rendererOptions);
    });
    registerStandardCleanupTarget(tree);
    await flushHookEffects(options.flushOptions);

    return {
        tree,
        update: async (nextElement) => {
            await act(async () => {
                tree.update(applyWrapper(nextElement, options.wrapper));
            });
            await flushHookEffects(options.flushOptions);
        },
        unmount: async () => {
            unregisterStandardCleanupTarget(tree);
            await act(async () => {
                tree.unmount();
            });
        },
    };
}
