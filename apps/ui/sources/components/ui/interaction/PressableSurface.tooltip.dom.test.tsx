/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const { View, Text, ScrollView } = await import('react-native');
    const mock = createReanimatedModuleMock();
    return { ...mock, default: { ...mock.default, View, Text, ScrollView }, View, Text, ScrollView };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PressableSurface } = await import('./PressableSurface');
await import('../overlays/AnchoredTooltip');

function installTooltipLayout() {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    // jsdom has no layout engine; the browser boundary supplies measured tooltip content.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 200, 28));
}

describe('PressableSurface web tooltip', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each(['switch', 'checkbox'] as const)('exposes checked state and Space activation for a %s', async (role) => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        function WrapControl() {
            const [checked, setChecked] = React.useState(false);
            return <PressableSurface accessibilityRole={role} accessibilityLabel="Wrap" accessibilityState={{ checked }} onPress={() => setChecked(value => !value)} />;
        }
        try {
            await act(async () => root.render(<WrapControl />));
            const control = container.querySelector<HTMLElement>(`[role="${role}"]`);
            expect(control?.getAttribute('aria-checked')).toBe('false');
            await act(async () => control?.click());
            expect(control?.getAttribute('aria-checked')).toBe('true');
            await act(async () => {
                control?.focus();
                control?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
                control?.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
            });
            expect(control?.getAttribute('aria-checked')).toBe('false');
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it.each(['button', 'text'] as const)('reveals a portaled %s tooltip on hover and keyboard focus without moving focus', async (role) => {
        installTooltipLayout();
        const container = document.createElement('div');
        container.style.overflow = 'hidden';
        container.style.height = '28px';
        document.body.appendChild(container);
        const root = createRoot(container);
        let richContentMounted = false;
        function TooltipDetails() {
            React.useEffect(() => { richContentMounted = true; return () => { richContentMounted = false; }; }, []);
            return <span>Next file</span>;
        }
        try {
            await act(async () => {
                root.render(<PressableSurface accessibilityRole={role} testID="trigger" accessibilityLabel="Next file" webTooltip="Next file" tooltipContent={role === 'button' ? <TooltipDetails /> : undefined} />);
            });
            const trigger = container.querySelector<HTMLElement>('[data-testid="trigger"]');
            if (!trigger) throw new Error('Missing trigger');
            vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 28, 28));
            expect(document.querySelector('[role="tooltip"]')).toBeNull();
            expect(richContentMounted).toBe(false);
            await act(async () => { trigger.dispatchEvent(new MouseEvent(window.PointerEvent != null ? 'pointerenter' : 'mouseenter', { bubbles: true })); });
            await vi.waitFor(() => {
                const tooltip = document.querySelector('[role="tooltip"]');
                expect(tooltip?.textContent).toBe('Next file');
                expect(container.contains(tooltip)).toBe(false);
                for (let node = tooltip; node instanceof HTMLElement; node = node.parentElement) {
                    const style = window.getComputedStyle(node);
                    expect(style.opacity, `${node.outerHTML.slice(0, 220)} PARENT ${node.parentElement?.outerHTML.slice(0, 450)}`).not.toBe('0');
                    expect(style.display).not.toBe('none');
                    expect(style.visibility).not.toBe('hidden');
                }
            }, { timeout: 10000 });
            expect(richContentMounted).toBe(role === 'button');
            expect(document.activeElement).not.toBe(trigger);
            await act(async () => { trigger.dispatchEvent(new MouseEvent(window.PointerEvent != null ? 'pointerleave' : 'mouseleave', { bubbles: true })); });
            await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                trigger.focus();
            });
            await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Next file'));
            expect(document.activeElement).toBe(trigger);
            await act(async () => { trigger.blur(); });
            await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('hides the tooltip and removes a non-focusable trigger from the tab order while expanded', async () => {
        installTooltipLayout();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const tooltip = () => document.querySelector('[role="tooltip"]');
        function PopoverTrigger() {
            const [open, setOpen] = React.useState(false);
            return (
                <PressableSurface
                    testID="trigger"
                    accessibilityLabel="Inbox"
                    accessibilityState={{ expanded: open }}
                    focusable={!open}
                    webTooltip="Inbox"
                    onPress={() => setOpen(value => !value)}
                />
            );
        }

        try {
            await act(async () => root.render(<PopoverTrigger />));
            const trigger = container.querySelector<HTMLElement>('[data-testid="trigger"]')!;
            const hover = (direction: 'enter' | 'leave') => trigger.dispatchEvent(new MouseEvent(
                window.PointerEvent != null ? `pointer${direction}` : `mouse${direction}`,
            ));

            await act(async () => { hover('enter'); });
            await vi.waitFor(() => expect(tooltip()?.textContent).toBe('Inbox'));
            await act(async () => { trigger.click(); });
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            expect(trigger.tabIndex).toBe(-1);
            expect(tooltip()).toBeNull();

            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                trigger.focus();
            });
            expect(document.activeElement).toBe(trigger);
            expect(tooltip()).toBeNull();

            // Close with the pointer still over the trigger.
            await act(async () => {
                trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                trigger.click();
            });
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
            expect(trigger.tabIndex).toBe(0);
            expect(tooltip()).toBeNull();

            await act(async () => {
                trigger.blur();
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                trigger.focus();
            });
            await vi.waitFor(() => expect(tooltip()?.textContent).toBe('Inbox'));
            await act(async () => { trigger.blur(); });
            expect(tooltip()).toBeNull();

            await act(async () => { hover('leave'); hover('enter'); });
            await vi.waitFor(() => expect(tooltip()?.textContent).toBe('Inbox'));
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('tracks a disabled button tooltip through re-enabling and pointer exit', async () => {
        installTooltipLayout();
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const onPress = vi.fn();
        const renderButton = (disabled: boolean) => {
            root.render(<PressableSurface testID="back" accessibilityLabel="Back" webTooltip="Back" disabled={disabled} onPress={onPress} />);
        };
        try {
            await act(async () => renderButton(true));
            const trigger = container.querySelector<HTMLElement>('[data-testid="back"]')!;
            expect(trigger.getAttribute('aria-disabled')).toBe('true');
            await act(async () => {
                trigger.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
                trigger.dispatchEvent(new MouseEvent(window.PointerEvent != null ? 'pointerenter' : 'mouseenter'));
            });
            await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Back'));
            await act(async () => { trigger.click(); });
            expect(onPress).not.toHaveBeenCalled();

            await act(async () => renderButton(false));
            expect(trigger.hasAttribute('aria-disabled')).toBe(false);
            await act(async () => { trigger.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })); });
            expect(document.querySelector('[role="tooltip"]')).toBeNull();
            await act(async () => { trigger.click(); });
            expect(onPress).toHaveBeenCalledOnce();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
});
