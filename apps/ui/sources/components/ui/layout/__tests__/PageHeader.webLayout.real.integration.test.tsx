// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { expect, it, vi } from 'vitest';
import { HappierPageHeader } from '@happier-dev/plugin-ui/presentation';
import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

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
    const layout = await measureStatusHeader(460, 'Unsaved changes · Save · 2 things to fix before this can run');
    const row = layout.rect('header-title-row');
    const name = layout.rect('name');
    const controls = layout.rect('controls');
    // Too narrow for both: the actions wrap beneath the identity...
    expect(controls.top).toBeGreaterThanOrEqual(name.bottom);
    // ...and keep the trailing edge they had on the title line.
    expect(Math.abs(controls.right - row.right)).toBeLessThanOrEqual(1);
});

it('draws the header overflow with the shared keyboard focus ring, not the browser default', async () => {
    const { PageHeaderMenu } = await import('../PageHeaderEntityParts');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<PageHeaderMenu testID="menu" actions={[{ id: 'export', title: 'Export', onSelect: () => {} }]} />));
        await act(async () => host.querySelector<HTMLElement>('[data-testid="menu.trigger"]')!.focus());
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
