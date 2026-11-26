// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Dimensions, View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

installWebLayoutBridge();

it.each([
    { width: 390, columnWidth: undefined, stacked: true },
    { width: 1440, columnWidth: undefined, stacked: false },
    { width: 1440, columnWidth: 390, stacked: true },
])('keeps the described action in place in a $width px window (column $columnWidth)', async ({ width, columnWidth, stacked }) => {
    const window = Dimensions.get('window');
    const getDimensions = vi.spyOn(Dimensions, 'get').mockReturnValue({ ...window, width });
    const { HappierPageSectionHeader } = await import('@happier-dev/plugin-ui/presentation');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <View style={{ width: columnWidth ?? width }}>
                <HappierPageSectionHeader
                    title={<View testID="title" style={{ width: 110, height: 20 }} />}
                    description={<View testID="description" style={{ height: 40, alignSelf: 'stretch' }} />}
                    action={<View testID="action" style={{ width: 132, height: 28 }} />}
                    columnWidthPx={columnWidth}
                    insetPx={18}
                />
            </View>,
        ));

        const viewport = { width, height: 844 };
        const first = await measureWebLayout(host, { viewport });
        const settled = await measureWebLayout(host, { viewport, settle: replay => act(replay) });
        const action = first.rect('action');
        expect({ left: settled.rect('action').left, top: settled.rect('action').top })
            .toEqual({ left: action.left, top: action.top });
        if (stacked) {
            expect(action.top).toBeGreaterThanOrEqual(first.rect('description').bottom);
            expect(action.left).toBe(first.rect('description').left);
        } else {
            expect(action.top).toBeLessThan(first.rect('description').top);
            expect(action.left).toBeGreaterThanOrEqual(first.rect('title').right);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
        getDimensions.mockRestore();
    }
});
