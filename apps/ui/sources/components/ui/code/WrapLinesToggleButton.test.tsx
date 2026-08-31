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

vi.mock('@/components/ui/buttons/IconAction', () => ({
    IconAction: (props: Record<string, unknown>) => React.createElement('IconAction', props, props.children as React.ReactNode),
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
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

    it('exposes the global wrap setting as an immediately actionable switch', async () => {
        const { WrapLinesToggleButton } = await import('./WrapLinesToggleButton');
        const screen = await renderScreen(<WrapLinesToggleButton />);
        const button = screen.findByType('IconAction' as never);

        expect(button.props.accessibilityRole).toBe('switch');
        expect(button.props.accessibilityState).toEqual({ checked: false });
        expect(button.props.active).toBe(false);

        await pressTestInstanceAsync(button, 'WrapLinesToggleButton');
        expect(setWrapLines).toHaveBeenCalledWith(true);
    });

    it('keeps the glyph stable while selected state carries the setting', async () => {
        wrapLines = true;
        const { WrapLinesToggleButton } = await import('./WrapLinesToggleButton');
        const screen = await renderScreen(<WrapLinesToggleButton />);

        expect(screen.findByType('IconAction' as never).props.active).toBe(true);
        expect(screen.findByType('Icon' as never).props.name).toBe('arrow-elbow-down-left');
    });
});
