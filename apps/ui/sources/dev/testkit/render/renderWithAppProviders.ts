import * as React from 'react';
import renderer, { act } from 'react-test-renderer';

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
    if (!wrapper) return element;
    return React.createElement(wrapper, null, element);
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
