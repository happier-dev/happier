// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { expect, it, vi } from 'vitest';
import { HappierPageHeader } from '@happier-dev/plugin-ui/presentation';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { PageHeaderMenu } from '../PageHeaderEntityParts';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installWebLayoutBridge();

it.each([610, 800, 1200])('keeps the title readable beside a long readout in a %spx pane', async width => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<HappierPageHeader testID="header" actionsLayout="inline"
            title={<Text testID="name" style={{ fontSize: 32, lineHeight: 38 }}>Gather and review changes</Text>}
            leading={<View style={{ width: 40, height: 40 }} />}
            actions={<View style={{ alignItems: 'flex-end' }}>
                <View testID="controls" style={{ width: 320, height: 32 }} />
                <Text testID="readout" style={{ fontSize: 13 }}>Unsaved changes · 12 things to fix before this can run</Text>
            </View>} />));
        const layout = await measureWebLayout(host, { viewport: { width, height: 900 } });
        const title = layout.rect('name');
        const readout = layout.rect('readout');
        expect(title.width).toBeGreaterThanOrEqual(200);
        expect(title.height).toBeLessThanOrEqual(3 * 38);
        expect(readout.right).toBeLessThanOrEqual(width);
        expect(title.right <= readout.left || readout.top >= title.bottom).toBe(true);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

async function measureStatusHeader(width: number, status: string) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<HappierPageHeader testID="header" actionsLayout="inline"
            title={<Text testID="name" style={{ fontSize: 32, lineHeight: 38 }}>QA header with a fairly long name</Text>}
            leading={<View style={{ width: 40, height: 40 }} />}
            actions={<View testID="controls" style={{ width: 190, height: 32 }} />}
            status={<Text testID="readout" style={{ fontSize: 13, lineHeight: 18, textAlign: 'right' }}>{status}</Text>} />));
        return await measureWebLayout(host, { viewport: { width, height: 900 } });
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
}

it.each([560, 760, 1100])('never reflows the title when the status line changes length, in a %spx pane (DESIGN-9 N52)', async width => {
    const ready = await measureStatusHeader(width, 'Unsaved changes · Save · Ready');
    const issues = await measureStatusHeader(width, 'Unsaved changes · Save · 2 things to fix before this can run');
    // The status line is the actions' own row: its words never take width from the title.
    expect(issues.rect('name').width).toBe(ready.rect('name').width);
    expect(issues.rect('name').height).toBe(ready.rect('name').height);
    // Nor does its height: a status that wraps to more lines never moves the identity down.
    expect(issues.rect('name').top).toBe(ready.rect('name').top);
    for (const layout of [ready, issues]) {
        const controls = layout.rect('controls');
        const readout = layout.rect('readout');
        // It sits under the actions, within their width, ending on their right edge.
        expect(readout.top).toBeGreaterThanOrEqual(controls.bottom);
        expect(readout.left).toBeGreaterThanOrEqual(controls.left - 1);
        expect(Math.abs(readout.right - controls.right)).toBeLessThanOrEqual(1);
    }
});

it('keeps wrapped inline actions on the content\'s right edge, never floating mid-column (DESIGN-9 N47)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<ItemList>
            <HappierPageHeader testID="header" actionsLayout="inline"
                title={<Text testID="name" style={{ fontSize: 32, lineHeight: 38 }}>QA header with a fairly long name</Text>}
                leading={<View style={{ width: 40, height: 40 }} />}
                actions={<View testID="controls" style={{ width: 190, height: 32 }} />}
                status={<Text style={{ fontSize: 13, lineHeight: 18, textAlign: 'right' }}>Unsaved changes · Save · 2 things to fix before this can run</Text>} />
            <ItemGroup><View testID="sheet-content" style={{ height: 40 }} /></ItemGroup>
        </ItemList>));
        const layout = await measureWebLayout(host, { viewport: { width: 460, height: 900 } });
        const name = layout.rect('name');
        const controls = layout.rect('controls');
        // Too narrow for both: the actions wrap beneath the identity...
        expect(controls.top).toBeGreaterThanOrEqual(name.bottom);
        // ...and keep the actual sheet's trailing edge below them (fb7ec10d1ac).
        expect(Math.abs(controls.right - layout.rect('sheet-content').right)).toBeLessThanOrEqual(1);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('draws the header overflow with the shared keyboard focus ring, not the browser default', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<PageHeaderMenu testID="menu" actions={[{ id: 'export', title: 'Export', onSelect: () => {} }]} />));
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            host.querySelector<HTMLElement>('[data-testid="menu.trigger"]')!.focus();
        });
        const layout = await measureWebLayout(host, { viewport: { width: 390, height: 400 }, focusedTestId: 'menu.trigger' });
        // IconButton delegates its one visible ring to the drawn square; its
        // focusable frame must not also paint the browser's default outline.
        expect(layout.rect('menu.trigger').outlineStyle).toBe('none');
        expect(layout.rect('menu.trigger-surface').outlineStyle).toBe('solid');
        expect(layout.rect('menu.trigger-surface').outlineWidth).toBe(2);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it.each([1000, 1200])('runs an entity header\'s purpose line under its actions, not in the space beside them, in a %spx pane (lab cforms F2)', async width => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<HappierPageHeader testID="header" columnMaxWidthPx={704}
            title={<Text testID="name" style={{ fontSize: 24, lineHeight: 30 }}>Fast review</Text>}
            description={<Text testID="purpose" style={{ fontSize: 14, lineHeight: 20 }}>Used when a new session starts with this profile.</Text>}
            actions={<View testID="controls" style={{ width: 380, height: 32 }} />} />));
        const layout = await measureWebLayout(host, { viewport: { width, height: 900 } });
        const name = layout.rect('name');
        const controls = layout.rect('controls');
        const purpose = layout.rect('purpose');
        // The actions share the title's line only...
        expect(controls.top).toBeLessThan(name.bottom);
        // ...and the purpose runs the column beneath them, on one line, from the title's edge.
        expect(purpose.top).toBeGreaterThanOrEqual(Math.max(name.bottom, controls.bottom) - 1);
        expect(purpose.height).toBeLessThanOrEqual(20 * 1.5);
        expect(Math.abs(purpose.left - name.left)).toBeLessThanOrEqual(1);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('wraps entity actions beneath a title that needs its width instead of breaking a short name (DESIGN-14 D5)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<HappierPageHeader testID="header"
            title={<Text testID="name" style={{ fontSize: 28, lineHeight: 34 }}>Prepare the 0.3 release</Text>}
            leading={<View style={{ width: 40, height: 40 }} />}
            actions={<View testID="controls" style={{ width: 300, height: 34 }} />} />));
        const layout = await measureWebLayout(host, { viewport: { width: 620, height: 900 } });
        const name = layout.rect('name');
        const controls = layout.rect('controls');
        // The name is read on one line...
        expect(name.height).toBeLessThanOrEqual(34);
        // ...and the actions that no longer fit beside it sit beneath.
        expect(controls.top).toBeGreaterThanOrEqual(name.bottom);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it.each([620, 1200])('keeps mark, title and meta one identity block when the actions wrap, in a %spx pane (DESIGN-15 R1)', async width => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<HappierPageHeader testID="header"
            title={<Text testID="name" style={{ fontSize: 28, lineHeight: 34 }}>Prepare the 0.3 release</Text>}
            leading={<View testID="mark" style={{ width: 40, height: 40 }} />}
            meta={[{ key: 'machine', text: 'NLDW4-5-40-40', testID: 'fact-machine' }, { key: 'started', text: 'Started 01:35' }]}
            actions={<View testID="controls" style={{ width: 300, height: 34 }} />} />));
        const layout = await measureWebLayout(host, { viewport: { width, height: 900 }, settle: replay => act(replay) });
        const name = layout.rect('name');
        const mark = layout.rect('mark');
        const meta = layout.rect('header-meta');
        const controls = layout.rect('controls');
        // The mark stays beside the identity it names, never down beside the actions.
        expect(mark.right).toBeLessThanOrEqual(name.left);
        expect(mark.top).toBeLessThan(name.bottom);
        // The facts follow the title directly.
        expect(meta.top - name.bottom).toBeLessThan(12);
        if (width >= 1200) {
            // Room for both: the actions share the title's line.
            expect(controls.top).toBeLessThan(name.bottom);
        } else {
            // No room: the actions wrap as one group after the whole identity, never between title and meta.
            expect(controls.top).toBeGreaterThanOrEqual(meta.bottom);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

async function measureDescribedHeader(actionsLayout: 'inline' | 'hang') {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<HappierPageHeader testID="header" actionsLayout={actionsLayout}
            title={<Text testID="name" style={{ fontSize: 32, lineHeight: 38 }}>Gather and review changes</Text>}
            description={<Text testID="sentence" style={{ fontSize: 15, lineHeight: 22 }}>Calm. Two sessions are working and nothing on this machine needs you right now, so there is room here.</Text>}
            leading={<View style={{ width: 40, height: 40 }} />}
            actions={<View testID="controls" style={{ width: 240, height: 32 }} />} />));
        return await measureWebLayout(host, { viewport: { width: 1200, height: 900 } });
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
}

it('keeps the description beside the controls under the title for inline and runs it beneath both only when the header hangs', async () => {
    const inline = await measureDescribedHeader('inline');
    // Inline: the sentence belongs to the title's column, beside the controls.
    expect(inline.rect('sentence').right).toBeLessThanOrEqual(inline.rect('controls').left);
    expect(inline.rect('sentence').top).toBeLessThan(inline.rect('controls').bottom + 40);

    const hang = await measureDescribedHeader('hang');
    // Hanging: mark and controls hang from the title's line, the sentence runs beneath at the identity's full width.
    expect(hang.rect('sentence').top).toBeGreaterThanOrEqual(hang.rect('controls').bottom);
    expect(hang.rect('sentence').right).toBeGreaterThan(hang.rect('controls').left);
});

async function measurePlainHeader(actions: React.ReactNode) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<View>
            <HappierPageHeader testID="header" title={<Text testID="name" style={{ fontSize: 22, lineHeight: 28 }}>Actions</Text>}
                description={<Text testID="purpose" style={{ fontSize: 14, lineHeight: 20 }}>What agents can do.</Text>} actions={actions} />
            <View testID="section" style={{ height: 40 }} />
        </View>));
        return await measureWebLayout(host, { viewport: { width: 900, height: 600 } });
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
}

it('keeps the title and everything under it in place whether or not the page has a header action', async () => {
    const plain = await measurePlainHeader(undefined);
    const withAction = await measurePlainHeader(<View testID="action" style={{ width: 120, height: 32 }} />);
    expect(withAction.rect('name').top).toBe(plain.rect('name').top);
    expect(withAction.rect('purpose').top).toBe(plain.rect('purpose').top);
    expect(withAction.rect('section').top).toBe(plain.rect('section').top);
});
