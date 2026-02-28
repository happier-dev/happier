import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
        View: (props: any) => React.createElement('View', props, props.children),
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: { blue: '#09f' },
                success: '#0a0',
                warning: '#f90',
                warningCritical: '#c00',
                textSecondary: '#555',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

describe('ToolStatusIndicator (permission states)', () => {
    it('renders lock icon when waiting for permission', async () => {
        const { ToolStatusIndicator } = await import('./ToolStatusIndicator');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                        permission: { status: 'pending' } as any,
                    } as any}
                />,
            );
        });

        const icons = tree!.root.findAllByType('Ionicons' as any);
        expect(icons.some((n) => n.props.name === 'lock-closed-outline')).toBe(true);
    });

    it('renders remove icon when permission is denied', async () => {
        const { ToolStatusIndicator } = await import('./ToolStatusIndicator');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
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
                        permission: { status: 'denied' } as any,
                    } as any}
                />,
            );
        });

        const icons = tree!.root.findAllByType('Ionicons' as any);
        expect(icons.some((n) => n.props.name === 'remove-circle-outline')).toBe(true);
    });
});
