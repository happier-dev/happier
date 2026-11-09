/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_ACTION_STOP_ID } from '@/components/sessions/actions/sessionActionIds';

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
    it('keeps the Stop button mounted and activates it once after menu updates', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const selected: string[] = [];
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const renderMenu = (title: string) => <SelectableMenuResults
            categories={[{ id: 'lifecycle', title: '', items: [
                { id: SESSION_ACTION_STOP_ID, title: 'Stop session' },
                { id: 'other', title },
            ] }]}
            selectedIndex={0}
            onSelectionChange={() => {}}
            onPressItem={item => selected.push(item.id)}
            rowVariant="slim"
        />;
        try {
            await act(async () => { root.render(renderMenu('Before arrival')); });
            const stop = container.querySelector<HTMLElement>('[data-testid="dropdown-option-ui_session_stop"]');
            expect(stop).not.toBeNull();
            expect(stop?.getAttribute('role')).toBe('button');
            expect(stop?.getAttribute('aria-disabled')).not.toBe('true');
            await act(async () => { root.render(renderMenu('After arrival')); });
            expect(container.querySelector('[data-testid="dropdown-option-ui_session_stop"]')).toBe(stop);
            await act(async () => {
                stop!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, cancelable: true }));
                stop!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, cancelable: true }));
            });
            expect(selected).toEqual([SESSION_ACTION_STOP_ID]);
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });

    it('leaves decorated destination rows mounted through mouse-down and drag, while ordinary clicks still select', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const selected: string[] = [];
        const dragged: string[] = [];
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => { root.render(<SelectableMenuResults
                categories={[{ id: 'destinations', title: '', items: [{ id: 'triage', title: 'PRs & Issues' }] }]}
                selectedIndex={0}
                onSelectionChange={() => {}}
                onPressItem={item => selected.push(item.id)}
                rowVariant="slim"
                wrapItem={(item, children) => <div draggable onDragStart={() => dragged.push(item.id)}>{children}</div>}
            />); });
            const option = container.querySelector<HTMLElement>('[data-testid="dropdown-option-triage"]')!;
            await act(async () => { option.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })); });
            expect(selected).toEqual([]);
            await act(async () => { option.dispatchEvent(new Event('dragstart', { bubbles: true })); });
            expect(dragged).toEqual(['triage']);
            await act(async () => { option.click(); });
            expect(selected).toEqual(['triage']);
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });
    it('exposes the chosen option independently of keyboard highlight', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(<SelectableMenuResults
                    categories={[{ id: 'layout', title: 'Layout', items: [
                        { id: 'projects', title: 'Projects', checked: true },
                        { id: 'recent', title: 'Recent activity', checked: false },
                    ] }]}
                    selectedIndex={1}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                />);
            });
            const projects = container.querySelector('[data-testid="dropdown-option-projects"]');
            const recent = container.querySelector('[data-testid="dropdown-option-recent"]');
            expect(projects?.getAttribute('role')).toBe('radio');
            expect(projects?.getAttribute('aria-checked')).toBe('true');
            expect(recent?.getAttribute('aria-checked')).toBe('false');
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });

    it('exposes a lone checked row as an on/off checkbox, not a one-option radio', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(<SelectableMenuResults
                    categories={[{ id: 'check-in', title: 'Check-in', items: [
                        { id: 'dont-pause', title: "Don't pause", checked: false },
                        { id: 'rename', title: 'Rename' },
                    ] }]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                />);
            });
            const toggle = container.querySelector('[data-testid="dropdown-option-dont-pause"]');
            expect(toggle?.getAttribute('role')).toBe('checkbox');
            expect(toggle?.getAttribute('aria-checked')).toBe('false');
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });

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
            expect(registerItemLayout).toHaveBeenCalledWith('layout');
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
