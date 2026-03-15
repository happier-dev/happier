import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setStringAsyncSpy = vi.fn<(text: string) => Promise<void>>(async (_text) => {});
const alertSpy = vi.fn();

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: ({ children, ...props }: any) => React.createElement('TextInput', props, children),
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
    Platform: {
        OS: 'web',
        select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
    },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: (text: string) => setStringAsyncSpy(text),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: (...args: any[]) => alertSpy(...args) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { divider: '#ddd', surfaceHigh: '#fff', surfaceHighest: '#f7f7f7', textSecondary: '#666' } } }),
    StyleSheet: { create: (v: any) => (typeof v === 'function' ? v() : v) },
}));

describe('CodeBlockViewFrame', () => {
    it('enables nested horizontal scrolling when wrap is false', async () => {
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeBlockViewFrame code={'x'} language={null} wrap={false} showCopyButton={false}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>,
            );
        });

        const scrollView = tree.root.findByType('ScrollView');
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.nestedScrollEnabled).toBe(true);
    });

    it('positions copy button absolutely when there is no header content', async () => {
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeBlockViewFrame code={'x'} language={null} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>,
            );
        });

        const pressable = tree.root.findByType('Pressable');
        const flattened = Array.isArray(pressable.props.style) ? pressable.props.style.flat() : [pressable.props.style];
        expect(flattened.some((s: any) => s?.position === 'absolute')).toBe(true);
    });

    it('keeps copy button in the header when language is provided', async () => {
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeBlockViewFrame code={'x'} language={'typescript'} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>,
            );
        });

        const pressable = tree.root.findByType('Pressable');
        const flattened = Array.isArray(pressable.props.style) ? pressable.props.style.flat() : [pressable.props.style];
        expect(flattened.some((s: any) => s?.position === 'absolute')).toBe(false);
    });

    it('copies without showing a modal and shows a temporary copied state', async () => {
        setStringAsyncSpy.mockClear();
        alertSpy.mockClear();

        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeBlockViewFrame code={'hello'} language={null} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>,
            );
        });

        const iconBefore = tree.root.findByType('Ionicons') as any;
        expect(iconBefore.props.name).toBe('copy-outline');

        const pressable = tree.root.findByType('Pressable');
        await renderer.act(async () => {
            await pressable.props.onPress();
        });

        expect(setStringAsyncSpy).toHaveBeenCalledWith('hello');
        expect(alertSpy).toHaveBeenCalledTimes(0);

        const iconAfter = tree.root.findByType('Ionicons') as any;
        expect(iconAfter.props.name).toBe('checkmark-outline');
    });
});
