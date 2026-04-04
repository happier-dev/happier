import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installRepositoryTreeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('../../../../dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (value: any) => value?.web ?? value?.default ?? null,
            },
            View: React.forwardRef(function View(props: any, ref) {
                const { children, testID, ...rest } = props;
                return React.createElement(
                    'div',
                    {
                        ...rest,
                        ref,
                        'data-testid': testID,
                    },
                    children,
                );
            }),
        });
    },
});

describe('WebDropTargetView', () => {
    it('keeps the host ref callback stable across rerenders (avoids ref/setState loops)', async () => {
        const { WebDropTargetView } = await import('./WebDropTargetView');

        const hostMock = {
            nodeType: 1,
            addEventListener: () => {},
            removeEventListener: () => {},
        } as any;

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                React.createElement(WebDropTargetView, { testID: 'drop-target' }),
                {
                    createNodeMock: (element) => {
                        if (element.type === 'div') return hostMock;
                        return null;
                    },
                },
            );
        });

        const findHost = () => tree.root.findByProps({ 'data-testid': 'drop-target' }) as any;
        const initialRef = findHost().props.ref;
        expect(typeof initialRef).toBe('function');

        act(() => {
            tree.update(React.createElement(WebDropTargetView, { testID: 'drop-target' }));
        });

        expect(findHost().props.ref).toBe(initialRef);
    });

    it('does not attach duplicate listeners when the same host element is reattached', async () => {
        const { WebDropTargetView } = await import('./WebDropTargetView');
        const listenersByType = new Map<string, EventListener[]>();
        const hostMock = {
            nodeType: 1,
            addEventListener: vi.fn((type: string, listener: EventListener) => {
                const list = listenersByType.get(type) ?? [];
                list.push(listener);
                listenersByType.set(type, list);
            }),
            removeEventListener: vi.fn((type: string, listener: EventListener) => {
                const list = listenersByType.get(type) ?? [];
                listenersByType.set(type, list.filter((entry) => entry !== listener));
            }),
        } as any;
        const onDrop = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                React.createElement(WebDropTargetView, { testID: 'drop-target', onDrop }),
                {
                    createNodeMock: (element) => {
                        if (element.type === 'div') return hostMock;
                        return null;
                    },
                },
            );
        });

        const host = tree.root.findByProps({ 'data-testid': 'drop-target' }) as any;
        const refCallback = host.props.ref;
        expect(typeof refCallback).toBe('function');
        expect(listenersByType.get('drop') ?? []).toHaveLength(1);

        act(() => {
            refCallback(hostMock);
            refCallback(hostMock);
            refCallback(hostMock);
        });

        expect(listenersByType.get('drop') ?? []).toHaveLength(1);

        act(() => {
            for (const listener of listenersByType.get('drop') ?? []) {
                listener(new Event('drop'));
            }
        });

        expect(onDrop).toHaveBeenCalledTimes(1);
    });
});
