import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installToolShellPresentationCommonModuleMocks } from './toolShellPresentationTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellPresentationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    text: {
                        secondary: '#555555',
                    },
                    state: {
                        neutral: { foreground: '#666666' },
                    },
                },
            },
        });
    },
});

describe('ToolStatusIndicator (permission states)', () => {
    it('renders lock icon when waiting for permission', async () => {
        const { ToolStatusIndicator } = await import('./ToolStatusIndicator');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ToolStatusIndicator
                    tool={{
                        name: 'edit',
                        state: 'running',
                        input: {},
                        createdAt: 1,
                        startedAt: 1,
                        completedAt: null,
                        description: null,
                        result: null,
                        permission: { status: 'pending' } as any,
                    } as any}
                />)).tree;

        const icons = tree!.findAllByType('Icon' as any);
        expect(icons.some((n) => n.props.name === 'lock')).toBe(true);
    });

    it('renders remove icon when permission is denied', async () => {
        const { ToolStatusIndicator } = await import('./ToolStatusIndicator');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ToolStatusIndicator
                    tool={{
                        name: 'edit',
                        state: 'running',
                        input: {},
                        createdAt: 1,
                        startedAt: 1,
                        completedAt: null,
                        description: null,
                        result: null,
                        permission: { status: 'denied' } as any,
                    } as any}
                />)).tree;

        const icons = tree!.findAllByType('Icon' as any);
        expect(icons.some((n) => n.props.name === 'minus-circle')).toBe(true);
    });

    it('uses the neutral loading color while running', async () => {
        const { ToolStatusIndicator } = await import('./ToolStatusIndicator');
        const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');

        const screen = await renderScreen(
            <ToolStatusIndicator
                tool={{
                    name: 'edit',
                    state: 'running',
                    input: {},
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: null,
                    description: null,
                    result: null,
                } as any}
            />,
        );

        // The indicator owns which colour its spinner gets; how the spinner draws it depends on the
        // user's loading indicator style.
        expect(screen.findByType(ActivitySpinner).props.color).toBe('#555555');
    });

    it('draws a finished tool quietly in the ink, a failed one in rose and one waiting on permission in attention amber', async () => {
        const { ToolStatusIndicator } = await import('./ToolStatusIndicator');
        const { lightTheme } = await import('@/theme');
        const glyph = async (tool: Record<string, unknown>, name: string) => {
            const screen = await renderScreen(
                <ToolStatusIndicator
                    tool={{
                        name: 'edit',
                        input: {},
                        createdAt: 1,
                        startedAt: 1,
                        completedAt: 2,
                        description: null,
                        result: null,
                        ...tool,
                    } as any}
                />,
            );
            return screen.tree.root.findAllByType('Icon' as any).find((node) => node.props.name === name)?.props.color;
        };

        expect(await glyph({ state: 'completed', result: 'ok' }, 'check-circle')).toBe('#555555');
        expect(await glyph({ state: 'error' }, 'x-circle')).toBe(lightTheme.colors.state.danger.foreground);
        expect(await glyph({ state: 'running', completedAt: null, permission: { status: 'pending' } }, 'lock'))
            .toBe(lightTheme.colors.state.attention.foreground);
    });
});
