import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
            View: (props: any) => React.createElement('View', props, props.children),
        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                accent: { blue: '#09f' },
                success: '#0a0',
                warning: '#f90',
                warningCritical: '#c00',
                textSecondary: '#555',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

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
});
