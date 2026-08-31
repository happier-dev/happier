import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setWrapLines = vi.fn();
let wrapLines = false;

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => {
        if (key === 'wrapLinesInDiffs') return [wrapLines, setWrapLines];
        throw new Error(`Unexpected setting: ${key}`);
    },
}));

vi.mock('@/components/ui/buttons/IconButton', () => ({
    IconButton: (props: Record<string, unknown>) => React.createElement('IconButton', props),
}));

vi.mock('@/components/ui/interactiveTargetSize', () => ({
    resolveMinimumInteractiveTargetSize: () => 44,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('WrapLinesToggleButton', () => {
    beforeEach(() => {
        wrapLines = false;
        setWrapLines.mockClear();
    });

    it('exposes the global wrap setting through the canonical accessible icon action', async () => {
        const { WrapLinesToggleButton } = await import('./WrapLinesToggleButton');
        const screen = await renderScreen(<WrapLinesToggleButton />);
        const button = screen.findByType('IconButton' as never);

        expect(button.props).toEqual(expect.objectContaining({
            iconName: 'arrow-elbow-down-left',
            variant: 'plain',
            accessibilityRole: 'switch',
            checked: false,
            selected: false,
            minimumInteractiveTargetSize: 44,
        }));
        await pressTestInstanceAsync(button, 'WrapLinesToggleButton');
        expect(setWrapLines).toHaveBeenCalledWith(true);
    });

    it('keeps the glyph stable while selected state carries the setting', async () => {
        wrapLines = true;
        const { WrapLinesToggleButton } = await import('./WrapLinesToggleButton');
        const screen = await renderScreen(<WrapLinesToggleButton />);
        const button = screen.findByType('IconButton' as never);

        expect(button.props.iconName).toBe('arrow-elbow-down-left');
        expect(button.props.selected).toBe(true);
        expect(button.props.checked).toBe(true);
    });
});
