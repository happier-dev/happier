import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installCodeBlockCommonModuleMocks } from './codeBlockTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setStringAsyncSpy = vi.fn<(text: string) => Promise<void>>(async (_text) => {});
const alertSpy = vi.fn();

installCodeBlockCommonModuleMocks({
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

function mockPlatform(os: 'android' | 'web') {
    installCodeBlockCommonModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: {
                    OS: os,
                    select: (options: any) => options?.[os] ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
                },
            });
        },
    });
}

describe('CodeBlockViewFrame', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('uses a gesture-handler ScrollView on Android so horizontal code block drags win nested gesture negotiation', async () => {
        mockPlatform('android');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'x'} language={null} wrap={false} showCopyButton={false}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        const scrollView = tree.findByType('GestureHandlerScrollView');
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.nestedScrollEnabled).toBe(true);
        expect(scrollView.props.disallowInterruption).toBe(true);
    });

    it('forwards scrollTestID when wrap is false (stable E2E locator)', async () => {
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        const screen = await renderScreen(
            <CodeBlockViewFrame
                code={'x'}
                language={null}
                wrap={false}
                showCopyButton={false}
                scrollTestID="markdown-code-block-scroll"
            >
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        );

        const scrollView = screen.findByTestId('markdown-code-block-scroll')!;
        expect(scrollView.props.testID).toBe('markdown-code-block-scroll');
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.nestedScrollEnabled).toBe(true);
    });

    it('positions copy button absolutely when there is no header content', async () => {
        mockPlatform('web');
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
        mockPlatform('web');
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
        mockPlatform('web');

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
