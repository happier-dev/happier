import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
afterEach(standardCleanup);

describe('InlineTextField web geometry', () => {
    it('uses the initial content-size event without forcing another textarea layout', async () => {
        const { InlineTextField } = await import('./InlineTextField');
        let measurements = 0;
        const input = { style: { height: '64px' }, get scrollHeight() { measurements += 1; return 64; } };
        const screen = await renderScreen(<InlineTextField editor={{ value: 'A wrapped title', placeholder: 'Name',
            accessibilityLabel: 'Name', onChangeText: () => {}, testID: 'title' }} style={{ fontSize: 24 }} />,
        { createNodeMock: () => input });
        const field = () => screen.findHostByTestId('title')!;
        await act(async () => {
            field().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 64 } } });
            field().props.onLayout?.({ nativeEvent: { layout: { width: 220 } } });
        });
        const { StyleSheet } = await import('react-native');
        expect(StyleSheet.flatten(field().props.style).height).toBe(64);
        expect(measurements).toBe(0);
    });

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

    it('at rest shows a long title clamped to its resting lines, keeps the full value editable, and opens it on focus', async () => {
        const { InlineTextField } = await import('./InlineTextField');
        const long = 'Run the shell command: sleep 1500 (wait for it to finish; do not touch any file). Then reply.';
        const screen = await renderScreen(<InlineTextField editor={{ value: long, placeholder: 'Name',
            accessibilityLabel: 'Name', onChangeText: () => {}, testID: 'title' }} style={{ fontSize: 24 }} restingLines={2} />);
        const resting = () => screen.findHostByTestId('title-resting');
        const input = screen.findHostByTestId('title')!;
        expect(resting()?.props.numberOfLines).toBe(2);
        // The field itself still carries the whole title, so a click places the caret and readers hear all of it.
        expect(screen.findHostByTestId('title')!.props.value).toBe(long);
        await act(async () => screen.findHostByTestId('title')!.props.onFocus());
        expect(resting()).toBeNull();
        expect(screen.findHostByTestId('title') === input).toBe(true);
        await act(async () => input.props.onChangeText('A renamed title '));
        expect(screen.findHostByTestId('title') === input).toBe(true);
        expect(input.props.value).toBe('A renamed title ');
        await act(async () => input.props.onBlur());
        expect(screen.findHostByTestId('title') === input).toBe(true);
        expect(resting()?.props.numberOfLines).toBe(2);
    });

    it('keeps the same input when an initially empty clamped title receives its first value', async () => {
        const { InlineTextField } = await import('./InlineTextField');
        function Title() {
            const [value, setValue] = React.useState('');
            return <InlineTextField editor={{ value, placeholder: 'Name', accessibilityLabel: 'Name',
                onChangeText: setValue, testID: 'title' }} style={{}} restingLines={2} />;
        }
        const screen = await renderScreen(<Title />);
        const input = screen.findHostByTestId('title')!;
        await act(async () => input.props.onFocus());
        await act(async () => input.props.onChangeText('First title'));
        await act(async () => input.props.onBlur());
        expect(screen.findHostByTestId('title') === input).toBe(true);
        expect(input.props.value).toBe('First title');
        expect(screen.findHostByTestId('title-resting')?.props.children).toBe('First title');
    });
});
