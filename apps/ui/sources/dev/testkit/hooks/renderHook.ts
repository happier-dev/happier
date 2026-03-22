import * as React from 'react';
import renderer, { act } from 'react-test-renderer';

import { registerStandardCleanupTarget, unregisterStandardCleanupTarget } from '../cleanup/standardCleanup';
import { flushHookEffects, type FlushHookEffectsOptions } from './flushHookEffects';

export type RenderHookOptions<Props> = Readonly<{
    initialProps: Props;
    wrapper?: React.ComponentType<React.PropsWithChildren>;
    flushOptions?: FlushHookEffectsOptions;
}>;

export type RenderHookResult<Value, Props> = Readonly<{
    tree: renderer.ReactTestRenderer;
    getCurrent: () => Value;
    rerender: (nextProps?: Props) => Promise<Value>;
    unmount: () => Promise<void>;
}>;

function wrapHookElement(
    element: React.ReactElement,
    wrapper?: React.ComponentType<React.PropsWithChildren>,
): React.ReactElement {
    if (!wrapper) return element;
    return React.createElement(wrapper, null, element);
}

export async function renderHook<Value, Props = void>(
    useValue: (props: Props) => Value,
    options?: Partial<RenderHookOptions<Props>>,
): Promise<RenderHookResult<Value, Props>> {
    let latestValue!: Value;
    let latestProps = (options?.initialProps ?? (undefined as Props)) as Props;
    let tree!: renderer.ReactTestRenderer;

    function HookHarness(props: Readonly<{ hookProps: Props }>) {
        latestValue = useValue(props.hookProps);
        return null;
    }

    const renderHarness = (hookProps: Props) => wrapHookElement(
        React.createElement(HookHarness, { hookProps }),
        options?.wrapper,
    );

    await act(async () => {
        tree = renderer.create(renderHarness(latestProps));
    });
    registerStandardCleanupTarget(tree);
    await flushHookEffects(options?.flushOptions);

    return {
        tree,
        getCurrent: () => latestValue,
        rerender: async (nextProps = latestProps) => {
            latestProps = nextProps;
            await act(async () => {
                tree.update(renderHarness(latestProps));
            });
            await flushHookEffects(options?.flushOptions);
            return latestValue;
        },
        unmount: async () => {
            unregisterStandardCleanupTarget(tree);
            await act(async () => {
                tree.unmount();
            });
        },
    };
}
