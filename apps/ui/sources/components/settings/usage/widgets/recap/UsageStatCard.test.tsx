import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { UsageRecapComposeResultSchema } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { buildUsageStatCardModel, type UsageRecapComposed } from './usageStatCardModel';
import { UsageStatCard } from './UsageStatCard';
import { USAGE_STAT_CARD_STYLES } from './usageStatCardStyles';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const tokens = { input: 900, output: 300, reasoning: 0, cacheRead: 600, cacheWrite: 100, total: 1_900_000_000 };
const composed = UsageRecapComposeResultSchema.parse({ kind: 'composed', v: 1, style: 'daybreak', format: 'square',
    selectedFields: ['tokens', 'activeDays', 'agentMix', 'rhythm'], unavailableFields: [],
    period: { startMs: Date.UTC(2026, 6, 1), endMs: Date.UTC(2026, 8, 30), timeZoneOffsetMinutes: 0 }, asOfMs: null,
    coverage: { accounting: null, sourceCoverage: [], sourceStatuses: [], pending: false },
    facts: { tokens, activeDays: 61, agentMix: [{ tokens: 3, events: 1 }, { tokens: 1, events: 1 }],
        rhythm: { calendarDays: [{ date: '2026-09-01', eventCount: 4 }, { date: '2026-09-02', eventCount: 0 }], weekdayHourBuckets: [] } },
}) as UsageRecapComposed;

describe('private stat card renderer', () => {
    it.each(USAGE_STAT_CARD_STYLES)('retains every selected mix share beyond the palette in %s', async style => {
        const model = buildUsageStatCardModel({ ...composed, style });
        const mix = Array.from({ length: 9 }, (_, index) => ({ id: `agent-${index}`, label: `Agent ${index}`, share: (index + 1) / 45 }));
        const screen = await renderScreen(<UsageStatCard model={{ ...model, mix }} tone="dark" testID="card" />);
        expect(screen.getTextContent()).toContain('Agent 8');
        expect(screen.findByTestId('card')!.props.accessibilityLabel).toContain('Agent 8 20%');
        const last = screen.tree.root.findAll(node => node.props.accessibilityLabel?.includes('Agent 8'));
        expect(last.some(node => node.props.accessibilityLabel.includes('20%'))).toBe(true);
        standardCleanup();
    });
    it.each(USAGE_STAT_CARD_STYLES.flatMap(style => (['square', 'story', 'link-preview'] as const).map(format => [style, format] as const)))(
        'draws %s · %s from the one model with exact readable facts', async (style, format) => {
            const model = buildUsageStatCardModel({ ...composed, style, format });
            const screen = await renderScreen(<UsageStatCard model={model} tone="dark" testID="card" />);
            const card = screen.findByTestId('card')!;
            expect(card.props.accessibilityLabel).toContain('1.9B');
            expect(card.props.accessibilityLabel).toContain('61');
            standardCleanup();
        });
});
