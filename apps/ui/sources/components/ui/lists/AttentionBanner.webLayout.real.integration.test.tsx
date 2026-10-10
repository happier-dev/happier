// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { AttentionBanner } from './AttentionBanner';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

it('keeps several ways forward beneath the words instead of squeezing the title beside them', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const title = 'Deletion has not been confirmed';
    const noop = () => {};
    try {
        async function measure(secondary: boolean) {
            await act(async () => root.render(
                <View style={{ width: 390 }}>
                    <AttentionBanner testID="notice" placement="inline" title={title}
                        action={{ label: 'Try again', onPress: noop }}
                        secondaryAction={secondary ? { label: 'Open the provider', onPress: noop } : null} />
                </View>,
            ));
            const layout = await measureWebLayout(host, { viewport: { width: 390, height: 844 }, texts: [title] });
            return { title: layout.textRects(title)[0]!, action: layout.rect('notice.action') };
        }
        const two = await measure(true);
        // The title keeps the banner's width (one line), and the buttons start under it.
        expect(two.action.top).toBeGreaterThanOrEqual(two.title.bottom);
        expect(two.title.height).toBeLessThan(30);
        const one = await measure(false);
        // One short action is the banner's trailing control until the banner itself is measured narrow.
        expect(one.action.top).toBeLessThan(one.title.bottom);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
