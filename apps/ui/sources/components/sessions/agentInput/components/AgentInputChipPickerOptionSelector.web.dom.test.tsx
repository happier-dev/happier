/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { lightTheme } from '@/theme';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: unknown): React.CSSProperties | undefined {
    if (style == null) return undefined;
    if (typeof style === 'function') return flattenStyle(style({ pressed: false, hovered: false }));
    if (Array.isArray(style)) {
        return style.reduce<React.CSSProperties>((acc, entry) => ({ ...acc, ...(flattenStyle(entry) ?? {}) }), {});
    }
    return typeof style === 'object' ? style as React.CSSProperties : undefined;
}

function domProps(props: Record<string, unknown>): Record<string, unknown> {
    const {
        accessibilityLabel,
        accessibilityRole,
        accessibilityState,
        hitSlop: _hitSlop,
        testID,
        ...rest
    } = props;
    const state = accessibilityState as { disabled?: boolean; selected?: boolean } | undefined;
    return {
        ...rest,
        ...(typeof testID === 'string' ? { 'data-testid': testID } : {}),
        ...(typeof accessibilityRole === 'string' ? { role: accessibilityRole } : {}),
        ...(typeof accessibilityLabel === 'string' ? { 'aria-label': accessibilityLabel } : {}),
        ...(state?.disabled !== undefined ? { 'aria-disabled': String(state.disabled) } : {}),
        ...(state?.selected !== undefined ? { 'aria-selected': String(state.selected) } : {}),
    };
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const View = React.forwardRef<HTMLDivElement, Record<string, unknown>>(function View(props, ref) {
        const { children, style, ...rest } = props;
        return React.createElement('div', { ...domProps(rest), ref, style: flattenStyle(style) }, children as React.ReactNode);
    });
    const Pressable = React.forwardRef<HTMLButtonElement, Record<string, unknown>>(function Pressable(props, ref) {
        const { children, disabled, onPress, style, ...rest } = props;
        const activate = (event: React.SyntheticEvent) => {
            if (disabled !== true && typeof onPress === 'function') onPress(event);
        };
        return React.createElement('button', {
            ...domProps(rest),
            ref,
            type: 'button',
            disabled: disabled === true,
            style: flattenStyle(style),
            onClick: activate,
            onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate(event);
                }
            },
        }, children as React.ReactNode);
    });
    return createReactNativeWebMock({
        View,
        Pressable,
        Platform: { OS: 'web', select: <T,>(values: { web?: T; default?: T }) => values.web ?? values.default },
        StyleSheet: { create: (styles: unknown) => styles },
    });
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (factory: unknown) => typeof factory === 'function' ? factory(lightTheme) : factory },
    useUnistyles: () => ({ theme: lightTheme }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => React.createElement('span') }));
vi.mock('@/components/ui/text/Text', () => ({ Text: (props: Record<string, unknown>) => React.createElement('span', props, props.children as React.ReactNode) }));
vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({ normalizeNodeForView: (node: React.ReactNode) => node }));
vi.mock('./agentInputChipPickerOptionIcon', () => ({ normalizeAgentInputChipPickerOptionIcon: (node: React.ReactNode) => node }));
vi.mock('./AgentInputChipPickerTopSelector', () => ({ AgentInputChipPickerTopSelector: () => null }));

describe('AgentInputChipPickerOptionSelector web DOM', () => {
    it('renders row and favorite as sibling controls and isolates keyboard activation', async () => {
        const { AgentInputChipPickerOptionSelector } = await import('./AgentInputChipPickerOptionSelector');
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const onRowPress = vi.fn();
        const onFavoritePress = vi.fn();

        try {
            await act(async () => {
                root.render(
                    <AgentInputChipPickerOptionSelector
                        sections={[{
                            id: 'engines',
                            options: [
                                {
                                    id: 'engine:codex',
                                    label: 'Codex',
                                    railAction: {
                                        testID: 'engine-favorite-action',
                                        accessibilityLabel: 'Add Codex to favorites',
                                        selected: false,
                                        icon: React.createElement('span'),
                                        onPress: onFavoritePress,
                                    },
                                },
                                {
                                    id: 'engine:muted',
                                    label: 'Muted engine',
                                    muted: true,
                                    railAction: {
                                        testID: 'muted-favorite-action',
                                        accessibilityLabel: 'Add muted engine to favorites',
                                        icon: React.createElement('span'),
                                        onPress: onFavoritePress,
                                    },
                                },
                                {
                                    id: 'engine:disabled',
                                    label: 'Disabled engine',
                                    disabled: true,
                                    railAction: {
                                        testID: 'disabled-favorite-action',
                                        accessibilityLabel: 'Add disabled engine to favorites',
                                        icon: React.createElement('span'),
                                        onPress: onFavoritePress,
                                    },
                                },
                            ],
                        }]}
                        focusedOptionId={null}
                        selectedOptionId={null}
                        onFocusOption={onRowPress}
                        variant="rail"
                    />,
                );
            });

            const row = container.querySelector<HTMLElement>('[data-testid="agent-input-chip-picker.option:engine:codex"]');
            const action = container.querySelector<HTMLButtonElement>('[data-testid="engine-favorite-action"]');
            expect(row).not.toBeNull();
            expect(action).not.toBeNull();
            expect(row!.contains(action)).toBe(false);
            expect(row!.parentElement).toBe(action!.parentElement);
            expect(row!.getAttribute('role')).toBe('button');
            expect(action!.getAttribute('aria-label')).toBe('Add Codex to favorites');
            expect(action!.getAttribute('aria-selected')).toBe('false');
            expect(action!.getAttribute('aria-pressed')).toBe('false');

            await act(async () => row!.focus());
            expect(action!.disabled).toBe(false);
            expect(Array.from(row!.parentElement!.querySelectorAll<HTMLElement>('[tabindex="0"], button:not([disabled])'))).toEqual([row, action]);

            await act(async () => {
                action!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                action!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
            });
            expect(onFavoritePress).toHaveBeenCalledTimes(2);
            expect(onRowPress).not.toHaveBeenCalled();

            const mutedRow = container.querySelector<HTMLElement>('[data-testid="agent-input-chip-picker.option:engine:muted"]');
            const mutedAction = container.querySelector<HTMLButtonElement>('[data-testid="muted-favorite-action"]');
            const disabledRow = container.querySelector<HTMLElement>('[data-testid="agent-input-chip-picker.option:engine:disabled"]');
            const disabledAction = container.querySelector<HTMLButtonElement>('[data-testid="disabled-favorite-action"]');
            await act(async () => mutedRow!.focus());
            expect(mutedAction!.disabled).toBe(true);
            expect(disabledRow!.getAttribute('tabindex')).toBe('-1');
            expect(disabledAction!.disabled).toBe(true);
            mutedAction!.click();
            disabledAction!.click();
            disabledRow!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            expect(onFavoritePress).toHaveBeenCalledTimes(2);
            expect(onRowPress).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
});
