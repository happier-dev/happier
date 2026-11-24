// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { HappierListDetailLayout } from '@happier-dev/plugin-ui/presentation';
import { afterEach, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

afterEach(() => vi.restoreAllMocks());

it.each([
    { width: 1040, listWidth: 288 },
    { width: 390, listWidth: 0 },
])('starts with the settled detail geometry in a $width px host', async ({ width, listWidth }) => {
    installWebLayoutBridge();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const viewport = { width, height: 720 };
    const readWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!.get!;
    // Browser geometry is available during mounting, while the observer's first notification is held.
    const mountMeasurement = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'settings-teams-layout' ? width : readWidth.call(this);
    });
    try {
        await act(async () => root.render(
            <div style={{ display: 'flex', width, height: 600 }}>
                <HappierListDetailLayout
                    testID="settings-teams-layout"
                    list={<span>Teams</span>}
                    detail={<h1>Team overview</h1>}
                    detailTestID="settings-teams-detail-pane"
                    minListWidth={220}
                    minDetailWidth={480}
                    preferredListRatio={0.5}
                    listWidthPx={288}
                />
            </div>,
        ));
        mountMeasurement.mockRestore();
        const initial = await measureWebLayout(host, { viewport });
        const settled = await measureWebLayout(host, { viewport, settle: (replay) => act(replay) });
        const detail = (layout: typeof initial) => {
            const pane = layout.rect('settings-teams-detail-pane');
            return { offset: pane.left - layout.rect('settings-teams-layout').left, width: pane.width };
        };
        expect(detail(settled)).toEqual({ offset: listWidth, width: width - listWidth });
        expect(detail(initial)).toEqual(detail(settled));
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
