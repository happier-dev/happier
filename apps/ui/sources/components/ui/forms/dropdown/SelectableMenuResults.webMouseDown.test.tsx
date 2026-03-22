/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                View: React.forwardRef((props: any, ref: any) => {
                    const { children, testID, ...rest } = props;
                    return React.createElement('div', {
                        ...rest,
                        ref,
                        'data-testid': testID,
                    }, children);
                }),
            }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/lists/SelectableRow', () => {
    const React = require('react');
    return {
        SelectableRow: (props: any) => React.createElement('button', {
            type: 'button',
            'data-testid': props.testID,
            onMouseDownCapture: props.onMouseDownCapture,
            onClick: props.onPress,
        }, props.title),
    };
});

vi.mock('@/components/ui/lists/Item', () => {
    const React = require('react');
    return {
        Item: (props: any) => React.createElement('button', {
            type: 'button',
            'data-testid': props.testID,
            onMouseDownCapture: props.onMouseDownCapture,
            onClick: props.onPress,
        }, props.title),
    };
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: {
        Provider: ({ children }: any) => children,
    },
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    ItemGroupRowPositionBoundary: ({ children }: any) => children,
}));

vi.mock('@/components/ui/text/Text', () => {
    const React = require('react');
    return {
        Text: (props: any) => React.createElement('span', props, props.children),
    };
});

describe('SelectableMenuResults (web mouse down activation)', () => {
    it('activates a menu item on mouse down before the follow-up click and does not double-fire', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const onPressItem = vi.fn();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <SelectableMenuResults
                        categories={[
                            {
                                id: 'general',
                                title: 'General',
                                items: [{ id: 'upload', title: 'Upload files' }],
                            },
                        ]}
                        selectedIndex={0}
                        onSelectionChange={() => {}}
                        onPressItem={onPressItem}
                        rowVariant="slim"
                    />,
                );
            });

            const button = container.querySelector('button');
            expect(button).not.toBeNull();

            await act(async () => {
                button!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
            });

            expect(onPressItem).toHaveBeenCalledTimes(1);
            expect(onPressItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'upload' }));

            await act(async () => {
                button!.click();
            });

            expect(onPressItem).toHaveBeenCalledTimes(1);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('lets item-row rendering own the option test id directly while still activating on mouse down', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const onPressItem = vi.fn();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <SelectableMenuResults
                        categories={[
                            {
                                id: 'general',
                                title: 'General',
                                items: [{ id: 'upload', title: 'Upload files' }],
                            },
                        ]}
                        selectedIndex={0}
                        onSelectionChange={() => {}}
                        onPressItem={onPressItem}
                        rowVariant="slim"
                        rowKind="item"
                    />,
                );
            });

            const option = container.querySelector('[data-testid="dropdown-option-upload"]');
            expect(option).not.toBeNull();
            expect(option?.tagName).toBe('BUTTON');

            await act(async () => {
                option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
            });

            expect(onPressItem).toHaveBeenCalledTimes(1);
            expect(onPressItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'upload' }));

            await act(async () => {
                (option as HTMLButtonElement).click();
            });

            expect(onPressItem).toHaveBeenCalledTimes(1);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });
});
