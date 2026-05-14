import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('createWindowsRemoteSessionLaunchModeActionChip', () => {
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
