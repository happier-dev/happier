// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { MMKV } from 'react-native-mmkv';
import { expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { SegmentedTabBar } from './SegmentedTabBar';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installWebLayoutBridge();

it('owns selected gradient paint on the addressed tab so authored background replaces it', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const authored = document.createElement('style');
    try {
        await act(async () => root.render(<SegmentedTabBar
            tabs={[{ id: 'chat', label: 'Chat' }, { id: 'files', label: 'Files' }]}
            activeTabId="chat" onSelectTab={() => {}} testIDPrefix="paint-tabs" />));
        const painted = host.querySelector<HTMLElement>('[data-testid="paint-tabs:chat"] [data-surface="tab-bar"][data-part="tab"]')!;
        expect(painted).not.toBeNull();
        painted.dataset.testid = 'selected-tab-paint';
        const ordinary = await measureWebLayout(host, { viewport: { width: 390, height: 200 } });
        expect(ordinary.rect('selected-tab-paint').backgroundImage).toContain('linear-gradient');
        expect(painted.dataset.state).toBe('selected');
        authored.textContent = '[data-surface="tab-bar"][data-part="tab"][data-state="selected"] { background: rgb(12, 34, 56) !important; }';
        document.head.append(authored);
        const themed = await measureWebLayout(host, { viewport: { width: 390, height: 200 } });
        expect(themed.rect('selected-tab-paint').backgroundColor).toBe('rgb(12, 34, 56)');
        expect(themed.rect('selected-tab-paint').backgroundImage).toBe('none');
        expect(Array.from(painted.querySelectorAll<HTMLElement>('*')).some(node => node.style.backgroundImage.includes('gradient'))).toBe(false);
    } finally {
        authored.remove();
        await act(async () => root.unmount());
        host.remove();
    }
});

it('retains tab focus and local wrapper state when fit measurement turns on and off', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const tabs = [{ id: 'overview', label: 'Overview' }, { id: 'code', label: 'Code' }];
    function StatefulTab(props: Readonly<{ children: React.ReactNode }>) {
        const [draft, setDraft] = React.useState('');
        return <div>{props.children}<input data-testid="tab-draft" value={draft}
            onInput={event => setDraft(event.currentTarget.value)} /></div>;
    }
    const wrapTab = (id: string, tab: React.ReactElement) => id === 'overview'
        ? <StatefulTab key={id}>{tab}</StatefulTab> : tab;
    async function render(fit: boolean) {
        await act(async () => root.render(
            <View style={{ width: 600 }}>
                <SegmentedTabBar tabs={tabs} activeTabId="overview" onSelectTab={() => {}} presentation="plain"
                    wrapTab={wrapTab} overflow={fit ? { label: 'More', testID: 'pages.more' } : undefined} testIDPrefix="pages" />
            </View>,
        ));
        await measureWebLayout(host, { viewport: { width: 800, height: 200 }, settle: replay => act(replay) });
    }
    try {
        await render(false);
        const tab = host.querySelector<HTMLElement>('[data-testid="pages:overview"]')!;
        const draft = host.querySelector<HTMLInputElement>('[data-testid="tab-draft"]')!;
        await act(async () => {
            draft.value = 'Unsubmitted note';
            draft.dispatchEvent(new Event('input', { bubbles: true }));
            tab.focus();
        });
        expect(document.activeElement).toBe(tab);
        for (const fit of [true, false, true]) {
            await render(fit);
            expect(host.querySelector('[data-testid="pages:overview"]')).toBe(tab);
            expect(document.activeElement).toBe(tab);
            expect(host.querySelector('[data-testid="tab-draft"]')).toBe(draft);
            expect(draft.value).toBe('Unsubmitted note');
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it.each([false, true])('keeps a column mode control at its natural height beside growing content (compact=%s)', async compact => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const tabs = [{ id: 'titles', label: 'Titles' }, { id: 'conversations', label: 'Conversations' }];
    try {
        async function measure(height?: number) {
            await act(async () => root.render(
                <View style={{ height }}>
                    <SegmentedTabBar tabs={tabs} activeTabId="titles" onSelectTab={() => {}}
                        role="radiogroup" compact={compact} testIDPrefix="mode" />
                    <View testID="results" style={{ flex: 1 }} />
                </View>,
            ));
            return measureWebLayout(host, { viewport: { width: 390, height: 844 } });
        }
        const natural = await measure();
        const tall = await measure(844);
        const shorter = await measure(400);
        for (const layout of [tall, shorter]) {
            // Height belongs to the control's content, not its parent's spare vertical space.
            expect(layout.rect('mode:titles').height).toBe(natural.rect('mode:titles').height);
            expect(layout.rect('results').top).toBe(natural.rect('results').top);
            // Equal-width segments still fill the available horizontal row.
            expect(layout.rect('mode:titles').width).toBe(natural.rect('mode:titles').width);
            expect(layout.rect('mode:conversations').right).toBe(natural.rect('mode:conversations').right);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('lets a pointer reach every visible page tab and More when the row overflows', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const pages = ['Overview', 'Code', 'Changes', 'Scripts', 'Services', 'Context'].map(label => ({ id: label.toLowerCase(), label }));
    try {
        await act(async () => root.render(
            <View style={{ width: 260 }}>
                <SegmentedTabBar tabs={pages} activeTabId="overview" onSelectTab={() => {}} presentation="plain"
                    overflow={{ label: 'More', testID: 'pages.more' }} testIDPrefix="pages" />
            </View>,
        ));
        const layout = await measureWebLayout(host, { viewport: { width: 400, height: 200 }, settle: replay => act(replay) });
        // The row really overflowed: some pages went behind More.
        expect(layout.rects.has('pages.more')).toBe(true);
        // The off-screen measuring copy of the tabs must never sit on top of the live controls.
        expect(layout.rect('pages.more').receivesPointer).toBe(true);
        expect(layout.rect('pages:overview').receivesPointer).toBe(true);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('keeps the selected page a visible tab, before More and inside the row, however narrow the row gets', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const pages = ['Overview', 'Code', 'Changes', 'Scripts', 'Services', 'Context'].map(label => ({ id: label.toLowerCase(), label }));
    try {
        for (const width of [360, 260, 160]) {
            await act(async () => root.render(
                <View testID="project-row" style={{ width }}>
                    <SegmentedTabBar tabs={pages} activeTabId="context" onSelectTab={() => {}} presentation="plain"
                        overflow={{ label: 'More', testID: 'pages.more' }} testIDPrefix="pages" />
                </View>,
            ));
            const layout = await measureWebLayout(host, { viewport: { width: 400, height: 200 }, settle: replay => act(replay) });
            const selected = layout.rect('pages:context');
            const more = layout.rect('pages.more');
            expect(selected.receivesPointer).toBe(true);
            expect(selected.right).toBeLessThanOrEqual(more.left + 0.5);
            expect(more.right).toBeLessThanOrEqual(layout.rect('project-row').right + 0.5);
            expect(host.querySelector('[data-testid="pages:context"]')?.getAttribute('aria-selected')).toBe('true');
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('reserves measured room for explicit More and keeps its pages reachable at wide and narrow widths', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onSelectTab = vi.fn();
    const requests = vi.spyOn(globalThis, 'fetch');
    const persistedWrites = vi.spyOn(MMKV.prototype, 'set');
    const pages = [{ id: 'overview', label: 'Overview' }, { id: 'code', label: 'Code' }];
    try {
        let constrainedWidth = 600;
        for (const narrow of [false, true]) {
            const width = narrow ? constrainedWidth : 600;
            await act(async () => root.render(
                <View testID="project-row" style={{ width }}>
                    <SegmentedTabBar tabs={pages} activeTabId="overview" onSelectTab={onSelectTab} presentation="plain"
                        overflow={{ label: 'More', testID: 'pages.more', items: [{ id: 'actions', label: 'Actions', count: 'Running 2 · Failed 1' }] }} testIDPrefix="pages" />
                </View>,
            ));
            const layout = await measureWebLayout(host, { viewport: { width: 800, height: 200 }, settle: replay => act(replay) });
            const more = layout.rect('pages.more');
            expect(more.receivesPointer).toBe(true);
            expect(more.right).toBeLessThanOrEqual(layout.rect('project-row').right + 0.5);
            expect(host.querySelector('[data-testid="pages.more"]')?.getAttribute('aria-label')).toBe('More');
            expect(layout.rects.has('pages:code')).toBe(!narrow);
            // Just less than the measured complete row: both pinned names fit without More,
            // but the explicit menu must reserve its own width and move the trailing tab.
            if (!narrow) constrainedWidth = more.right - layout.rect('pages:overview').left - 1;
            for (const page of pages) {
                if (layout.rects.has(`pages:${page.id}`)) expect(layout.rect(`pages:${page.id}`).right).toBeLessThanOrEqual(more.left);
            }
        }
        expect(onSelectTab).not.toHaveBeenCalled();
        expect(requests).not.toHaveBeenCalled();
        expect(persistedWrites).not.toHaveBeenCalled();
    } finally {
        await act(async () => root.unmount());
        host.remove();
        requests.mockRestore();
        persistedWrites.mockRestore();
    }
});
