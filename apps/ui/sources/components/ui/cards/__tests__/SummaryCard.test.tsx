import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installCardCommonModuleMocks } from './cardTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installCardCommonModuleMocks();

const SAMPLE_ENTRIES = [
    { label: 'Theme', value: 'Dark' },
    { label: 'Language', value: 'English' },
    { label: 'Font', value: '16px' },
];

describe('SummaryCard', () => {
    it('renders label:value pairs', async () => {
        const { SummaryCard } = await import('../SummaryCard');
        const screen = await renderScreen(<SummaryCard entries={SAMPLE_ENTRIES} testID="summary-card" />);

        expect(screen.getTextContent()).toContain('Theme : Dark');
        expect(screen.getTextContent()).toContain('Language : English');
        expect(screen.getTextContent()).toContain('Font : 16px');
    });

    it('wraps in Pressable when onPress is provided', async () => {
        const { SummaryCard } = await import('../SummaryCard');
        const onPress = vi.fn();
        const screen = await renderScreen(<SummaryCard entries={SAMPLE_ENTRIES} onPress={onPress} testID="summary-card" />);

        const card = screen.findByTestId('summary-card');
        expect(card).toBeTruthy();
        expect(card?.props.onPress).toBe(onPress);
    });

    it('renders as View (not Pressable) when onPress is omitted', async () => {
        const { SummaryCard } = await import('../SummaryCard');
        const screen = await renderScreen(<SummaryCard entries={SAMPLE_ENTRIES} testID="summary-card" />);

        const card = screen.findByTestId('summary-card');
        expect(card).toBeTruthy();
        expect(card?.props.onPress).toBeUndefined();
    });

    it('shows chevron when onPress is provided', async () => {
        const { SummaryCard } = await import('../SummaryCard');
        const screen = await renderScreen(<SummaryCard entries={SAMPLE_ENTRIES} onPress={() => {}} testID="summary-card" />);

        expect(screen.findByProps({ name: 'chevron-forward' })).toBeTruthy();
    });

    it('does not show chevron without onPress', async () => {
        const { SummaryCard } = await import('../SummaryCard');
        const screen = await renderScreen(<SummaryCard entries={SAMPLE_ENTRIES} testID="summary-card" />);

        expect(() => screen.findByProps({ name: 'chevron-forward' })).toThrow();
    });
});
