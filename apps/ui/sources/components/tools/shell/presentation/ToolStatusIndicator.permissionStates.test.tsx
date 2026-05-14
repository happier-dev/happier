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

        const icons = tree!.findAllByType('Ionicons' as any);
        expect(icons.some((n) => n.props.name === 'lock-closed-outline')).toBe(true);
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

        const icons = tree!.findAllByType('Ionicons' as any);
        expect(icons.some((n) => n.props.name === 'remove-circle-outline')).toBe(true);
    });

    it('uses the neutral loading color while running', async () => {
        const { ToolStatusIndicator } = await import('./ToolStatusIndicator');

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

        const spinner = screen.findByType('ActivityIndicator' as any);
        expect(spinner?.props?.color).toBe('#555555');
    });
});
