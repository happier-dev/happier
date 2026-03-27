import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installCodeBlockCommonModuleMocks } from './codeBlockTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setStringAsyncSpy = vi.fn<(text: string) => Promise<void>>(async (_text) => {});
const alertSpy = vi.fn();

installCodeBlockCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: any[]) => alertSpy(...args),
            },
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('expo-clipboard', () => ({
    setStringAsync: (text: string) => setStringAsyncSpy(text),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

describe('CodeBlockViewFrame', () => {
    it('enables nested horizontal scrolling when wrap is false', async () => {
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'x'} language={null} wrap={false} showCopyButton={false}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        const scrollView = tree.findByType('ScrollView');
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.nestedScrollEnabled).toBe(true);
    });

    it('forwards scrollTestID when wrap is false (stable E2E locator)', async () => {
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(
            <CodeBlockViewFrame
                code={'x'}
                language={null}
                wrap={false}
                showCopyButton={false}
                scrollTestID="markdown-code-block-scroll"
            >
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        )).tree;

        const scrollView = tree.findByType('ScrollView');
        expect(scrollView.props.testID).toBe('markdown-code-block-scroll');
    });

    it('positions copy button absolutely when there is no header content', async () => {
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'x'} language={null} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        const pressable = tree.findByProps({ accessibilityLabel: 'common.copy' });
        const flattened = Array.isArray(pressable.props.style) ? pressable.props.style.flat() : [pressable.props.style];
        expect(flattened.some((s: any) => s?.position === 'absolute')).toBe(true);
    });

    it('keeps copy button in the header when language is provided', async () => {
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'x'} language={'typescript'} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        const pressable = tree.findByProps({ accessibilityLabel: 'common.copy' });
        const flattened = Array.isArray(pressable.props.style) ? pressable.props.style.flat() : [pressable.props.style];
        expect(flattened.some((s: any) => s?.position === 'absolute')).toBe(false);
    });

    it('copies without showing a modal and shows a temporary copied state', async () => {
        setStringAsyncSpy.mockClear();
        alertSpy.mockClear();

        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'hello'} language={null} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        const iconBefore = tree.findByType('Ionicons') as any;
        expect(iconBefore.props.name).toBe('copy-outline');

        const pressable = tree.findByProps({ accessibilityLabel: 'common.copy' });
        await pressTestInstanceAsync(pressable, 'common.copy');

        expect(setStringAsyncSpy).toHaveBeenCalledWith('hello');
        expect(alertSpy).toHaveBeenCalledTimes(0);

        const iconAfter = tree.findByType('Ionicons') as any;
        expect(iconAfter.props.name).toBe('checkmark-outline');
    });
});
