import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
afterEach(standardCleanup);

describe('InlineTextField web geometry', () => {
    it('shrinks a wrapped title when its available width increases without changing its text', async () => {
        const { InlineTextField } = await import('./InlineTextField');
        // DOM layout is the system boundary; the real field owns its measured height.
        let scrollHeight = 64;
        const input = { style: { height: '64px' }, get scrollHeight() { return scrollHeight; }, focus: vi.fn(), blur: vi.fn() };
        const screen = await renderScreen(<InlineTextField editor={{ value: 'A long workflow name', placeholder: 'Name',
            accessibilityLabel: 'Name', onChangeText: () => {}, testID: 'title' }} style={{ fontSize: 24 }} />,
        { createNodeMock: () => input });
        const field = () => screen.findHostByTestId('title')!;
        await act(async () => field().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 64 } } }));
        await act(async () => field().props.onLayout?.({ nativeEvent: { layout: { width: 220, height: 64, x: 0, y: 0 } } }));
        scrollHeight = 32;
        await act(async () => field().props.onLayout?.({ nativeEvent: { layout: { width: 500, height: 64, x: 0, y: 0 } } }));
        const { StyleSheet } = await import('react-native');
        expect(StyleSheet.flatten(field().props.style).height).toBe(32);
        expect(field().props.value).toBe('A long workflow name');
    });
});
