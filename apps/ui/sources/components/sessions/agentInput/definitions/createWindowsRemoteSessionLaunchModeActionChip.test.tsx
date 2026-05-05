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

        expect(chip.collapsedOptionsPopover?.options.map((option) => option.id)).toEqual([
            'hidden',
            'windows_terminal',
            'console',
        ]);
        expect(chip.collapsedOptionsPopover?.options.find((option) => option.id === 'windows_terminal')).toMatchObject({
            disabled: true,
        });
    });
});
