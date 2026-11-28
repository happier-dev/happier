// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Dimensions, View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { HappierPageHeader, HappierPageSectionHeader, type HappierPageHeaderMetaFact } from '@happier-dev/plugin-ui/presentation';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

installWebLayoutBridge();

it.each([
    { width: 390, pane: 390, stacked: true },
    { width: 1440, pane: 1440, stacked: false },
    { width: 1440, pane: 390, stacked: true },
])('lands header actions in their final place in a $pane px pane ($width px window)', async ({ width, pane, stacked }) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const dimensions = vi.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width });
    const viewport = { width, height: 844 };
    try {
        await act(async () => root.render(
            <View style={{ width: pane }}>
                <HappierPageHeader
                    testID="machine"
                    initialFrameWidthPx={pane}
                    columnMaxWidthPx={704}
                    markSpan="title"
                    actionsLayout="hang"
                    leading={<View style={{ width: 40, height: 40 }} />}
                    title={<View testID="machine-name" style={{ width: 180, height: 28 }} />}
                    description="Calm. 2 sessions working."
                    meta={[{ key: 'platform', text: 'Linux x64' }]}
                    actions={<View testID="start-session" style={{ width: 220, height: 32 }} />}
                />
                <HappierPageSectionHeader testID="setup" title="What’s set up" insetPx={18} />
            </View>,
        ));
        const first = await measureWebLayout(host, { viewport });
        const settled = await measureWebLayout(host, { viewport, settle: replay => act(replay) });
        for (const id of ['machine-name', 'machine-meta', 'start-session', 'setup']) {
            const position = ({ top, left }: { top: number; left: number }) => ({ top, left });
            expect(position(settled.rect(id)), id).toEqual(position(first.rect(id)));
        }
        if (stacked) {
            expect(first.rect('start-session').top).toBeGreaterThanOrEqual(first.rect('machine-meta').bottom);
            expect(first.rect('start-session').left).toBe(first.rect('machine-meta').left);
        } else {
            expect(first.rect('start-session').top).toBeLessThan(first.rect('machine-name').bottom);
            expect(first.rect('start-session').left).toBeGreaterThanOrEqual(first.rect('machine-name').right);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
        dimensions.mockRestore();
    }
});

it.each([390, 1440])('keeps the start of the facts and Setup in place when facts open at %s px', async width => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const viewport = { width, height: 844 };
    const facts = (open: boolean): HappierPageHeaderMetaFact[] => [
        { key: 'presence', text: 'Online', testID: 'presence' },
        { key: 'platform', text: 'Linux x64' },
        { key: 'host-size', text: open ? '64 cores · 192 GB memory' : '8 cores', pending: !open },
        { key: 'encryption', text: 'End-to-end encrypted', testID: 'encryption' },
    ];
    const render = (open: boolean) => act(async () => root.render(
        <View style={{ width }}>
            <HappierPageHeader
                testID="machine"
                title="Build machine"
                markSpan="title"
                initialFrameWidthPx={width}
                columnMaxWidthPx={704}
                leading={<View style={{ width: 40, height: 40 }} />}
                meta={facts(open)}
                reserveNarrowMetaLines={2}
            />
            <HappierPageSectionHeader testID="setup" title="What’s set up" insetPx={18} />
        </View>,
    ));
    try {
        await render(false);
        const pending = await measureWebLayout(host, { viewport, settle: replay => act(replay) });
        await render(true);
        const opened = await measureWebLayout(host, { viewport, settle: replay => act(replay) });
        expect(opened.rect('machine-meta').top).toBe(pending.rect('machine-meta').top);
        expect(opened.rect('presence').top).toBe(pending.rect('presence').top);
        expect(opened.rect('setup').top).toBe(pending.rect('setup').top);
        if (width === 390) {
            expect(opened.rect('encryption').top).toBeGreaterThan(opened.rect('presence').top);
        } else {
            expect(opened.rect('encryption').top).toBe(opened.rect('presence').top);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
