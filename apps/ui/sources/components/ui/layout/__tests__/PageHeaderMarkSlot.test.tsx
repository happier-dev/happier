import * as React from 'react';
import { Image } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('PageHeaderMarkSlot', () => {
    it('keeps page and row artwork visible without a backing or clipping', async () => {
        for (const size of ['page', 'row'] as const) {
            const screen = await renderScreen(
                <PageHeaderMarkSlot testID="entity-mark" size={size}>
                    <Image testID="entity-artwork" accessibilityLabel="Agent" source={{ uri: 'agent.png' }} />
                </PageHeaderMarkSlot>,
            );
            const style = flattenTestStyle(screen.findByTestId('entity-mark')?.props.style);
            expect(style.backgroundColor).toBeUndefined();
            expect(style.borderWidth).toBeUndefined();
            expect(style.overflow).not.toBe('hidden');
            expect(screen.findByTestId('entity-artwork')?.props.accessibilityLabel).toBe('Agent');
            await screen.unmount();
        }
    });
});
