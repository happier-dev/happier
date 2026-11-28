// @vitest-environment jsdom

import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPEN_MONEY } from '../data/open';
import { LocaleProvider } from '../i18n';
import { FINANCES_SNAPSHOT, MoneySheet, parseFinances } from './MoneySheet';

/** A plan 07 `finances.json` v1 document. Figures are test values, not real ones. */
function financesDoc() {
    const month = (m: string, ai: number, servers: number, income: number) => ({
        month: m,
        chfPerUsd: 0.8,
        costs: { ai, servers, marketing: 20, software: 15 },
        costsTotal: ai + servers + 35,
        incomeReceived: income,
        earnedUsd: { hosted: 0, supporter: income },
        people: { plus: 0, teamSeats: 0, supportersRecurring: 2, supportersOneTime: 1 },
        someFutureField: true,
    });
    return {
        schemaVersion: 1,
        generatedAt: '2026-11-03T08:00:00Z',
        asOf: '2026-10-31',
        currency: 'USD',
        fx: { source: 'the SNB monthly average', sourceUrl: 'https://data.snb.ch/' },
        scope: 'Confirmed expenses paid from the Happier account',
        months: [month('2026-09', 2150, 120, 0), month('2026-10', 2050, 140, 45)],
        goals: [
            { id: 'servers', costUsd: 140, coveredPercent: 32, plusMembersToCover: 24 },
            { id: 'everything', costUsd: 2225, coveredPercent: 2, plusMembersToCover: null },
        ],
    };
}

/** The network is the boundary: stats.happier.dev answers through this stub. */
function stubStats(finances: unknown) {
    const fetchMock = vi.fn(async (url: string) => {
        const body = url.includes('finances.json') ? finances : { schemaVersion: 1, total: 0, entries: [] };
        return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

async function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(
            <LocaleProvider locale="en" path="/open">
                <MoneySheet />
            </LocaleProvider>,
        ),
    );
    return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('the /open money sheet', () => {
    it('prerenders the compiled snapshot, which is the dated empty state until the first approved month', () => {
        expect(FINANCES_SNAPSHOT).toBeNull();
        const html = renderToStaticMarkup(
            <LocaleProvider locale="en" path="/open">
                <MoneySheet />
            </LocaleProvider>,
        );
        expect(html).toContain(OPEN_MONEY.empty);
        expect(html).not.toMatch(/\$\d/);
    });

    it('upgrades in place from one finances.json fetch and prints the period it covers', async () => {
        const fetchMock = stubStats(financesDoc());
        const { container, unmount } = await mount();
        await vi.waitFor(() => expect(container.textContent).toContain('Up to October 31, 2026, in US dollars.'));
        expect(container.textContent).toContain('$45');
        expect(container.textContent).toContain('Servers are covered at 24 Plus members.');
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('finances.json'))).toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('supporters.json'))).toHaveLength(1);
        await unmount();
    });

    it('draws income on the same axis as costs, not scaled up', async () => {
        stubStats(financesDoc());
        const { container, unmount } = await mount();
        await vi.waitFor(() => expect(container.querySelector('.money-bars__inc')).not.toBeNull());
        const last = container.querySelector('.money-bars__m--last')!;
        const height = (selector: string) => parseFloat((last.querySelector(selector) as HTMLElement).style.height);
        // 45 of income against 140 of servers in the same month: the ratio survives.
        expect(height('.money-bars__inc') / height('.money-bars__srv')).toBeCloseTo(45 / 140, 5);
        await unmount();
    });

    it('keeps the snapshot whole when any part of the published document is malformed', async () => {
        const doc = financesDoc();
        (doc.months[0] as Record<string, unknown>).costsTotal = '2305';
        stubStats(doc);
        const { container, unmount } = await mount();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(container.textContent).toContain(OPEN_MONEY.empty);
        expect(container.textContent).not.toContain('$45');
        await unmount();
    });
});

describe('parseFinances', () => {
    it('accepts unknown fields but rejects months out of order or a goal outside 0-100', () => {
        expect(parseFinances(financesDoc())).not.toBeNull();

        const reversed = financesDoc();
        reversed.months.reverse();
        expect(parseFinances(reversed)).toBeNull();

        const over = financesDoc();
        over.goals[0].coveredPercent = 140;
        expect(parseFinances(over)).toBeNull();

        expect(parseFinances({ ...financesDoc(), schemaVersion: 2 })).toBeNull();
    });
});
