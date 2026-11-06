import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { AgentInputExtraActionChipRenderContext } from '../agentInputContracts';
import { buildCollapsedExtraControlActions } from '../controls/buildCollapsedExtraControlActions';
import { resolveRenderedExtraActionChipNodes } from '../controls/resolveRenderedExtraActionChipNodes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

afterEach(() => standardCleanup());

const renderContext = {
    chipStyle: () => ({}),
    showLabel: true,
    iconColor: 'currentColor',
    textStyle: {},
    countTextStyle: {},
    popoverAnchorRef: React.createRef(),
} satisfies AgentInputExtraActionChipRenderContext;

describe('createWindowsRemoteSessionLaunchModeActionChip', () => {
    it.each(['press', 'focus', 'hover'] as const)('demands Terminal facts once on visible %s, never on render', async (entry) => {
        const { createWindowsRemoteSessionLaunchModeActionChip } = await import('./createWindowsRemoteSessionLaunchModeActionChip');
        const onIntent = vi.fn();
        const chip = createWindowsRemoteSessionLaunchModeActionChip({
            mode: 'hidden', windowsTerminalAvailable: false, onModeChange: vi.fn(), onIntent,
        });
        const nodes = resolveRenderedExtraActionChipNodes({
            placementIds: ['windowsRemoteSessionMode'],
            chips: [chip], renderContext, autoHideRenderContext: renderContext,
        });
        const screen = await renderScreen(<>{nodes.extraControlNodesById.windowsRemoteSessionMode}</>);
        expect(onIntent).not.toHaveBeenCalled();
        const visibleChip = screen.findByTestId('agent-input-windows-launch-mode-chip');
        if (!visibleChip) throw new Error('Expected the visible Windows launch chip');
        await act(async () => {
            if (entry === 'press') {
                // React Native's press-in demand precedes its completed press/open, as on the capabilities chip.
                visibleChip.props.onPressIn?.();
                visibleChip.props.onPress();
            } else if (entry === 'focus') {
                visibleChip.props.onFocus?.();
            } else {
                visibleChip.props.onHoverIn?.();
            }
        });
        expect(onIntent).toHaveBeenCalledTimes(1);
    });

    it('keeps overflow on the same one-demand path before opening its existing picker', async () => {
        const { createWindowsRemoteSessionLaunchModeActionChip } = await import('./createWindowsRemoteSessionLaunchModeActionChip');
        const entries: string[] = [];
        const onIntent = vi.fn(() => { entries.push('intent'); });
        const chip = createWindowsRemoteSessionLaunchModeActionChip({
            mode: 'hidden', windowsTerminalAvailable: false, onModeChange: vi.fn(), onIntent,
        });
        const openCollapsedOptionsPopover = vi.fn(() => { entries.push('open'); });
        const actions = buildCollapsedExtraControlActions({
            chips: [chip], tint: 'currentColor', dismiss: vi.fn(), blurInput: vi.fn(), openCollapsedOptionsPopover,
        });
        expect(onIntent).not.toHaveBeenCalled();
        actions.windowsRemoteSessionMode?.[0]?.onPress?.();
        expect(onIntent).toHaveBeenCalledTimes(1);
        expect(openCollapsedOptionsPopover).toHaveBeenCalledWith(chip.key);
        expect(entries).toEqual(['intent', 'open']);
    });

    it('keeps Windows Terminal visible but disabled when it is unavailable', async () => {
        const { createWindowsRemoteSessionLaunchModeActionChip } = await import('./createWindowsRemoteSessionLaunchModeActionChip');

        const chip = createWindowsRemoteSessionLaunchModeActionChip({
            mode: 'hidden',
            windowsTerminalAvailable: false,
            onModeChange: vi.fn(),
        });

        const section = chip.collapsedOptionsPopover?.rootStep?.sections?.[0];
        const sectionOptions = section && section.kind === 'static' ? section.options : [];
        expect(sectionOptions.map((option) => option.id)).toEqual([
            'hidden',
            'windows_terminal',
            'console',
        ]);
        expect(sectionOptions.find((option) => option.id === 'windows_terminal')).toMatchObject({
            disabled: true,
        });
    });

    it('exposes per-option onSelect callbacks that dispatch onModeChange so the overlay route fires the mutation', async () => {
        const { createWindowsRemoteSessionLaunchModeActionChip } = await import('./createWindowsRemoteSessionLaunchModeActionChip');

        const onModeChange = vi.fn();
        const chip = createWindowsRemoteSessionLaunchModeActionChip({
            mode: 'console',
            windowsTerminalAvailable: true,
            onModeChange,
        });

        const section = chip.collapsedOptionsPopover?.rootStep?.sections?.[0];
        if (!section || section.kind !== 'static') throw new Error('expected static section');

        const hiddenOption = section.options.find((option) => option.id === 'hidden');
        expect(typeof hiddenOption?.onSelect).toBe('function');

        hiddenOption!.onSelect!();
        expect(onModeChange).toHaveBeenCalledWith('hidden');
    });

    it('descriptor-level onSelect is a documented close-only no-op (does NOT mutate launch-mode state)', async () => {
        const { createWindowsRemoteSessionLaunchModeActionChip } = await import('./createWindowsRemoteSessionLaunchModeActionChip');

        const onModeChange = vi.fn();
        const chip = createWindowsRemoteSessionLaunchModeActionChip({
            mode: 'console',
            windowsTerminalAvailable: true,
            onModeChange,
        });

        chip.collapsedOptionsPopover!.onSelect('hidden');
        chip.collapsedOptionsPopover!.onSelect('console');
        expect(onModeChange).not.toHaveBeenCalled();
    });
});
