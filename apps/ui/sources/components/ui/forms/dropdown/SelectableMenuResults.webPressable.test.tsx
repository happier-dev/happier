/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const actual: any = await vi.importActual('react-native-web');
    return {
        ...actual,
        Platform: {
            ...(actual.Platform ?? {}),
            OS: 'web',
            select: (values: any) => values?.web ?? values?.default ?? values?.native ?? values?.ios ?? values?.android,
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), eyebrow: () => ({}) },
}));

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

vi.mock('@/components/ui/text/Text', async () => {
    const React = require('react');
    const { Text, TextInput } = await import('react-native');
    return {
        Text: (props: any) => React.createElement(Text, props, props.children),
        TextInput: (props: any) => React.createElement(TextInput, props, props.children),
    };
});

describe('SelectableMenuResults (React Native Web Pressable)', () => {
    it('activates selectable rows through web mouse down capture before the Pressable click path', async () => {
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
                                items: [{ id: 'session.fork', title: 'Fork session' }],
                            },
                        ]}
                        selectedIndex={0}
                        onSelectionChange={() => {}}
                        onPressItem={onPressItem}
                        rowVariant="slim"
                    />,
                );
            });

            const option = container.querySelector('[data-testid="dropdown-option-session_fork"]');
            expect(option).not.toBeNull();
            expect(option?.getAttribute('role')).toBe('button');

            await act(async () => {
                option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
            });

            expect(onPressItem).toHaveBeenCalledTimes(1);
            expect(onPressItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'session.fork' }));

            act(() => {
                option!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
            });

            expect(onPressItem).toHaveBeenCalledTimes(1);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('does not activate the row when mouse down starts from a nested interactive child', async () => {
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
                                items: [{
                                    id: 'with-action',
                                    title: 'Row with action',
                                    right: React.createElement('span', { role: 'button', tabIndex: 0, 'data-testid': 'nested-action' }, 'Nested action'),
                                }],
                            },
                        ]}
                        selectedIndex={0}
                        onSelectionChange={() => {}}
                        onPressItem={onPressItem}
                        rowVariant="slim"
                    />,
                );
            });

            const nestedAction = container.querySelector('[data-testid="nested-action"]');
            expect(nestedAction).not.toBeNull();

            await act(async () => {
                nestedAction!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
            });

            expect(onPressItem).not.toHaveBeenCalled();
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('does not pass React Native layout props through to the web row frame DOM node', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const layoutHandler = vi.fn();
        const registerItemLayout = vi.fn(() => layoutHandler);
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
        const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

        Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get: () => 24 });
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 40 });

        try {
            await act(async () => {
                root.render(
                    <SelectableMenuResults
                        categories={[
                            {
                                id: 'general',
                                title: 'General',
                                items: [{ id: 'layout', title: 'Layout row' }],
                            },
                        ]}
                        selectedIndex={0}
                        onSelectionChange={() => {}}
                        onPressItem={() => {}}
                        rowVariant="slim"
                        registerItemLayout={registerItemLayout}
                    />,
                );
            });

            expect(container.querySelector('[data-testid="dropdown-option-layout:scroll-frame"]')).not.toBeNull();
            expect(registerItemLayout).toHaveBeenCalledWith('0');
            expect(layoutHandler).toHaveBeenCalledWith({ nativeEvent: { layout: { y: 24, height: 40 } } });
            expect(consoleErrorSpy.mock.calls.some((args) => args.some((arg) => String(arg).includes('Unknown event handler property `onLayout`')))).toBe(false);
        } finally {
            await act(async () => {
                root.unmount();
            });
            consoleErrorSpy.mockRestore();
            if (originalOffsetTop) {
                Object.defineProperty(HTMLElement.prototype, 'offsetTop', originalOffsetTop);
            } else {
                delete (HTMLElement.prototype as { offsetTop?: unknown }).offsetTop;
            }
            if (originalOffsetHeight) {
                Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
            } else {
                delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
            }
            container.remove();
        }
    });
});
