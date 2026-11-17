import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

type MockProps = React.Attributes & Record<string, unknown>;

vi.mock('@/components/ui/popover/Popover', () => ({
    Popover: (props: MockProps & { children: (value: { maxHeight: number }) => React.ReactNode }) => props.children({ maxHeight: 390 }),
}));
vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: MockProps) => React.createElement('FloatingOverlay', props),
}));
vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: MockProps) => React.createElement('RoundButton', props),
}));
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: MockProps) => React.createElement('Icon', props),
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('DateTimePickerPopover.web', () => {
    it('chooses a themed calendar day while preserving the draft time', async () => {
        const { DateTimePickerPopover } = await import('./DateTimePickerPopover.web');
        const onChange = vi.fn();
        const onDismiss = vi.fn();
        const screen = await renderScreen(<DateTimePickerPopover
            mode="date"
            anchorRef={{ current: null }}
            value={new Date(2026, 8, 11, 9, 25)}
            minimumDate={new Date(2026, 8, 10)}
            accentColor="#888"
            onChange={onChange}
            onDismiss={onDismiss}
        />);

        await act(async () => screen.findByTestId('date-time-picker-calendar-day-2026-9-27')?.props.onPress());
        expect(onChange).toHaveBeenCalledWith(new Date(2026, 8, 27, 9, 25));
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('scrolls the selected minute into the column instead of past it', async () => {
        const { resolveTimeColumnScrollOffset, TIME_OPTION_PITCH: pitch } = await import('./DateTimePickerPopover.web');
        const viewportHeight = 207;
        const optionHeight = 44;
        for (const selected of [0, 30, 59]) {
            const offset = resolveTimeColumnScrollOffset({ selected, viewportHeight });
            const rowTop = selected * pitch;
            expect(offset).toBeLessThanOrEqual(rowTop);
            expect(rowTop + optionHeight).toBeLessThanOrEqual(offset + viewportHeight);
        }
        expect(resolveTimeColumnScrollOffset({ selected: 0, viewportHeight })).toBe(0);
    });

    it('offers exact hour and minute choices without delegating to the browser picker', async () => {
        const { DateTimePickerPopover } = await import('./DateTimePickerPopover.web');
        function Harness() {
            const [value, setValue] = React.useState(new Date(2026, 8, 11, 9, 0));
            return <DateTimePickerPopover mode="time" anchorRef={{ current: null }} value={value} minimumDate={new Date(2026, 8, 10)} accentColor="#888" onChange={setValue} onDismiss={vi.fn()} />;
        }
        const screen = await renderScreen(<Harness />);

        await act(async () => screen.findByTestId('date-time-picker-time-hh-14')?.props.onPress());
        await act(async () => screen.findByTestId('date-time-picker-time-mm-37')?.props.onPress());

        expect(screen.findByTestId('date-time-picker-time-hh-14')?.props.accessibilityState.selected).toBe(true);
        expect(screen.findByTestId('date-time-picker-time-mm-37')?.props.accessibilityState.selected).toBe(true);
    });
});
