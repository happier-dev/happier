import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installTimerCensus, renderScreen } from '@/dev/testkit';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { admitCatalogBrandMark } from '@/components/ui/media/catalogBrandMark';
import { admitRegistrySummaryMark } from '@/registries/registryBrandMark';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import { SafeExpoImage } from '@/components/ui/media/SafeExpoImage';

const appearance = vi.hoisted(() => ({ theme: null as Theme | null }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const boundary = await createUnistylesMock();
    return { ...boundary, useUnistyles: () => ({ ...boundary.useUnistyles(), theme: appearance.theme }) };
});
beforeEach(() => { appearance.theme = lightTheme; });

describe('catalog identity recovery', () => {
    it('keeps admitted marks stable at scale across presentation and theme changes without logo/body probes or timers', async () => {
        // Network is a system boundary. The platform image host owns decoding;
        // admission and presentation have no separate logo/body request.
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected logo/body probe'));
        vi.useFakeTimers();
        const timers = installTimerCensus();
        try {
            const input = Array.from({ length: 1000 }, (_, index) => ({
                sourceId: 'catalog', itemId: `item-${index}`, kind: 'mcpServer' as const,
                title: `Server ${index}`, iconUrl: `https://example.test/${index}.svg`, iconDarkUrl: `https://example.test/${index}-dark.svg`,
            }));
            const admitted = input.map(item => admitRegistrySummaryMark(item));
            const unchanged = input.map((item, index) => admitRegistrySummaryMark({ ...item }, admitted[index]));
            expect(unchanged.filter((item, index) => item.brandMark !== admitted[index]!.brandMark)).toHaveLength(0);
            const changed = input.map((item, index) => admitRegistrySummaryMark(index === 42
                ? { ...item, iconUrl: 'https://example.test/changed.svg' } : item, unchanged[index]));
            expect(changed.filter((item, index) => item.brandMark !== admitted[index]!.brandMark)).toHaveLength(1);
            const mark = changed[42]!.brandMark!;
            const screen = await renderScreen(<HappierBrandMark brand={mark} pixelSize={20} />);
            expect(screen.findByType(SafeExpoImage).props.source).toBe(mark.light);
            for (let index = 0; index < 8; index++) {
                appearance.theme = index % 2 ? darkTheme : lightTheme;
                await act(async () => screen.update(<HappierBrandMark brand={mark} pixelSize={index % 2 ? 28 : 20} />));
                expect(screen.findByType(SafeExpoImage).props.source).toBe(index % 2 ? mark.dark : mark.light);
            }
            expect(timers.read()).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
            await act(async () => { vi.advanceTimersByTime(60_000); });
            await act(async () => screen.update(<></>));
            expect(timers.read()).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            timers.stop();
            vi.useRealTimers();
            fetch.mockRestore();
        }
    });
    it('recovers from failed A to valid B with exactly one accessible identity', async () => {
        const first = { iconUrl: 'https://example.test/a.png', displayName: 'Example agent', size: 20 };
        const screen = await renderScreen(<HappierBrandMark brand={admitCatalogBrandMark(first)} pixelSize={20} />);
        await act(async () => screen.findByType('Image').props.onError());
        expect(screen.findAllByType('Image')).toHaveLength(0);
        expect(screen.getTextContent()).toBe('E');
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props.accessibilityLabel === first.displayName)).toHaveLength(1);
        await act(async () => screen.update(<HappierBrandMark brand={admitCatalogBrandMark({ ...first, iconUrl: 'https://example.test/b.png' })} pixelSize={20} />));
        expect(screen.findAllByType('Image')).toHaveLength(1);
        expect(screen.findByType('Image').props.source.uri).toBe('https://example.test/b.png');
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props.accessibilityLabel === first.displayName)).toHaveLength(1);
    });
    it('keeps absent or refused catalog URLs at the same named fallback without platform acquisition', async () => {
        const screen = await renderScreen(<></>);
        for (const iconUrl of [undefined, 'file:///catalog-mark.svg', 'not a URL', 'https://user:fixture@example.test/mark.svg']) {
            await act(async () => screen.update(<HappierBrandMark
                brand={admitCatalogBrandMark({ displayName: 'Example agent', iconUrl })} pixelSize={20}
            />));
            expect(screen.findAllByType(SafeExpoImage)).toHaveLength(0);
            expect(screen.getTextContent()).toBe('E');
            expect(screen.findAll((node) => typeof node.type === 'string' && node.props.accessibilityLabel === 'Example agent')).toHaveLength(1);
        }
    });
});
