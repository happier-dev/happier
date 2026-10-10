import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';

const platformBoundary = vi.hoisted(() => ({ os: 'web' }));

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const mock = await createReactNativeWebMock();
        Object.defineProperty(mock.Platform, 'OS', { configurable: true, get: () => platformBoundary.os });
        return mock;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

type ChipProps = React.ComponentProps<(typeof import('./AgentInputFolderChip'))['AgentInputFolderChip']>;

async function renderChip(overrides: Partial<ChipProps>) {
    const { AgentInputFolderChip } = await import('./AgentInputFolderChip');
    const onPress = vi.fn();
    const onRemove = vi.fn();
    const props: ChipProps = {
        state: { kind: 'folder', path: '~/code/happier' },
        tint: '#767676',
        chipStyle: () => ({}),
        textStyle: {},
        onPress,
        onRemove,
        ...overrides,
    };
    const screen = await renderScreen(<AgentInputFolderChip {...props} />);
    return { screen, onPress, onRemove };
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') return flattenStyle(style({ pressed: false }));
    if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

function textsOf(node: { findAll: (predicate: (node: { type?: unknown }) => boolean) => Array<{ props: unknown }> }): unknown[] {
    return node
        .findAll((candidate) => candidate?.type === 'Text')
        .map((candidate) => (candidate.props as { children?: unknown }).children);
}

describe('AgentInputFolderChip', () => {
    afterEach(() => { platformBoundary.os = 'web'; });

    it('reserves no × slot on a touch device: removal stays on the picker row and the screen-reader action', async () => {
        platformBoundary.os = 'ios';
        const { screen, onRemove } = await renderChip({});
        const chip = screen.findByTestId('agent-input-path-chip')!;
        await act(async () => { chip.props.onFocus({}); });
        expect(screen.findByTestId('agent-input-path-chip-remove')).toBeFalsy();
        expect(flattenStyle(chip.props.style).paddingRight).not.toBe(2);
        await act(async () => { chip.props.onAccessibilityAction({ nativeEvent: { actionName: 'remove' } }); });
        expect(onRemove).toHaveBeenCalledOnce();
    });

    it('paints the canonical focus ring on the chip and on × for keyboard focus', async () => {
        const { screen } = await renderChip({});
        const chip = screen.findByTestId('agent-input-path-chip')!;
        expect(flattenStyle(chip.props.style).outlineStyle).not.toBe('solid');
        await act(async () => { chip.props.onFocus({}); });
        expect(flattenStyle(screen.findByTestId('agent-input-path-chip')!.props.style)).toMatchObject({ outlineStyle: 'solid', outlineWidth: 2 });

        const remove = screen.findByTestId('agent-input-path-chip-remove')!;
        await act(async () => { remove.props.onFocus({}); });
        expect(flattenStyle(screen.findByTestId('agent-input-path-chip-remove')!.props.style)).toMatchObject({ outlineStyle: 'solid', outlineWidth: 2 });
    });
    it('opens the picker from the chip and removes the folder only from ×, never both', async () => {
        const { screen, onPress, onRemove } = await renderChip({});
        const chip = screen.findByTestId('agent-input-path-chip');
        expect(chip).toBeTruthy();
        expect(textsOf(chip!)).toContain('~/code/happier');
        expect(screen.findByTestId('agent-input-path-chip-remove')!.props.disabled).toBe(true);

        await act(async () => { (chip!.props as { onPress: () => void }).onPress(); });
        expect(onPress).toHaveBeenCalledTimes(1);
        expect(onRemove).not.toHaveBeenCalled();

        // One hover region covers the chip and ×, so moving onto × never hides it.
        await act(async () => { screen.findByTestId('agent-input-path-chip-region')!.props.onPointerEnter(); });
        const remove = screen.findByTestId('agent-input-path-chip-remove');
        expect(remove).toBeTruthy();
        expect(remove!.props.disabled).toBe(false);
        await act(async () => { (remove!.props as { onPress: () => void }).onPress(); });
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('removes the folder from the keyboard and from the screen-reader action through the same handler', async () => {
        const { screen, onRemove } = await renderChip({});
        const chip = screen.findByTestId('agent-input-path-chip')!;
        const props = chip.props as {
            onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
            accessibilityActions?: ReadonlyArray<{ name: string; label?: string }>;
        };
        expect(props.accessibilityActions?.map((action) => action.name)).toContain('remove');
        // Keys reach the chip through the shared pressable's key hook; a handled key is consumed.
        const pressable = screen.root.findAll((node) => typeof node.type !== 'string'
            && node.props.testID === 'agent-input-path-chip' && typeof node.props.onKeyDown === 'function')[0]!;
        const onKeyDown = pressable.props.onKeyDown as (key: string, event: unknown) => boolean;

        let consumed: boolean[] = [];
        await act(async () => { consumed = [onKeyDown('Delete', {}), onKeyDown('Backspace', {}), onKeyDown('a', {})]; });
        expect(consumed).toEqual([true, true, false]);
        await act(async () => { props.onAccessibilityAction?.({ nativeEvent: { actionName: 'remove' } }); });
        expect(onRemove).toHaveBeenCalledTimes(3);
    });

    it('reads “Add folder” with no folder, and offers no × to remove what is not there', async () => {
        const { screen, onPress, onRemove } = await renderChip({ state: { kind: 'none' } });
        const chip = screen.findByTestId('agent-input-path-chip')!;
        expect(textsOf(chip)).toContain('newSession.folder.addFolder');
        expect(screen.findByTestId('agent-input-path-chip-remove')).toBeFalsy();
        await act(async () => { (chip.props as { onPress: () => void }).onPress(); });
        expect(onPress).toHaveBeenCalledTimes(1);
        const pressable = screen.root.findAll((node) => typeof node.type !== 'string'
            && node.props.testID === 'agent-input-path-chip' && typeof node.props.onKeyDown === 'function')[0]!;
        let consumed = true;
        await act(async () => { consumed = (pressable.props.onKeyDown as (key: string, event: unknown) => boolean)('Delete', {}); });
        expect(consumed).toBe(false);
        expect(onRemove).not.toHaveBeenCalled();
    });

    it('never offers “Add folder” or × while the folder is loading', async () => {
        const { screen } = await renderChip({ state: { kind: 'resolving', lastKnownPath: '~/code/website' } });
        const chip = screen.findByTestId('agent-input-path-chip')!;
        expect(textsOf(chip)).toContain('~/code/website');
        expect(textsOf(chip)).not.toContain('newSession.folder.addFolder');
        expect(screen.findByTestId('agent-input-path-chip-remove')).toBeFalsy();
        expect((chip.props as { accessibilityLabel?: string }).accessibilityLabel).toBe('newSession.folder.a11y.loading');
    });

    it('is disabled with the machine’s reason while the machine is unavailable, and keeps its value', async () => {
        const { screen, onPress } = await renderChip({
            state: { kind: 'machine_unavailable', label: { kind: 'folder', path: '~/code/happier' }, reason: 'MacBook Pro is offline' },
        });
        const chip = screen.findByTestId('agent-input-path-chip')!;
        const props = chip.props as {
            disabled?: boolean;
            accessibilityState?: { disabled?: boolean };
            accessibilityHint?: string;
            onPress?: () => void;
        };
        expect(textsOf(chip)).toContain('~/code/happier');
        expect(textsOf(chip)).not.toContain('newSession.folder.addFolder');
        expect(props.disabled).toBe(true);
        expect(props.accessibilityState?.disabled).toBe(true);
        expect(props.accessibilityHint).toBe('MacBook Pro is offline');
        expect(screen.findByTestId('agent-input-path-chip-remove')).toBeFalsy();
        expect(onPress).not.toHaveBeenCalled();
    });
});
