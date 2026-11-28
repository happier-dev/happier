// @vitest-environment jsdom

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SUPPORTERS_PAGE } from '../data/plans';
import { LocaleProvider } from '../i18n';
import { SupporterWall } from './SupporterWall';

/** A plan 05 `supporters.json`. Names are test values. */
const WALL = {
    schemaVersion: 1,
    generatedAt: '2026-11-03T08:00:00Z',
    total: 3,
    entries: [
        { number: 1, name: 'Mara K.', since: 2026, link: 'https://example.com/mara' },
        { number: 2, name: 'jonas.dev', since: 2026, link: 'javascript:alert(1)' },
        { number: 42, name: 'Sofia Ortega', since: 2026 },
    ],
};

async function mountAt(path: string, body: unknown = WALL) {
    window.history.replaceState(null, '', path);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(
            <LocaleProvider locale="en" path="/supporters">
                <SupporterWall />
            </LocaleProvider>,
        ),
    );
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('the supporter wall', () => {
    it('puts the pass holder first on /s/<n>', async () => {
        const { container, unmount } = await mountAt('/s/42');
        const first = container.querySelector('p');
        expect(first?.textContent).toBe('No. 42 · Sofia Ortega · since 2026, thank you');
        await unmount();
    });

    it('thanks an unknown pass number without inventing an entry', async () => {
        const { container, unmount } = await mountAt('/s/9999');
        expect(container.textContent).toContain(SUPPORTERS_PAGE.unknown);
        expect(container.textContent).not.toContain('No. 9999');
        await unmount();
    });

    it('shows the ?linked= result line', async () => {
        const { container, unmount } = await mountAt('/supporters?linked=none');
        expect(container.querySelector('[role="status"]')?.textContent).toBe(SUPPORTERS_PAGE.linked.none);
        await unmount();
    });

    it('shows the Discord role result and tells a supporter when to retry the contributor check', async () => {
        const { container, unmount } = await mountAt('/supporters?linked=supporter&via=discord&retry=1');
        const status = container.querySelector('[role="status"]');
        expect(status?.textContent).toMatch(/discord/i);
        expect(status?.textContent).toMatch(/try again/i);
        expect(status?.textContent).not.toBe(SUPPORTERS_PAGE.linked.supporter);
        await unmount();
    });

    it('links only https names, as user-generated nofollow links', async () => {
        const { container, unmount } = await mountAt('/supporters');
        const links = [...container.querySelectorAll('a')];
        expect(links.map((a) => a.textContent)).toEqual(['Mara K.']);
        expect(links[0].getAttribute('rel')).toBe('nofollow ugc noopener');
        expect(container.textContent).toContain('jonas.dev');
        await unmount();
    });

    it('keeps the empty wall when the document is malformed', async () => {
        const { container, unmount } = await mountAt('/supporters', { ...WALL, entries: [{ number: 'x', name: 'Mallory', since: 2026 }] });
        expect(container.textContent).toContain(SUPPORTERS_PAGE.empty);
        expect(container.textContent).not.toContain('Mallory');
        await unmount();
    });
});
