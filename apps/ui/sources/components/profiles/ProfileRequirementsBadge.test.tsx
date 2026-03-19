import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                status: {
                    connecting: '#999',
                    connected: '#0a0',
                    disconnected: '#a00',
                },
                surface: '#fff',
            },
        },
    }),
    StyleSheet: {
        create: (styles: any) => (typeof styles === 'function' ? styles({
            colors: {
                status: {
                    connecting: '#999',
                    connected: '#0a0',
                    disconnected: '#a00',
                },
                surface: '#fff',
            },
        }) : styles),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/hooks/session/useProfileEnvRequirements', () => ({
    useProfileEnvRequirements: () => ({ isReady: false, isLoading: false }),
}));

vi.mock('@/sync/domains/profiles/profileSecrets', () => ({
    hasRequiredSecret: () => true,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

describe('ProfileRequirementsBadge', () => {
    it('does not emit raw text nodes under View when icons render as text on web', async () => {
        const { ProfileRequirementsBadge } = await import('./ProfileRequirementsBadge');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ProfileRequirementsBadge
                    profile={{ id: 'p1' } as any}
                    machineId={null}
                />,
            );
        });

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string' || typeof node === 'number') {
                const value = String(node);
                if (parentType !== 'Text' && value.trim().length > 0) badNodes.push({ parent: parentType, value });
                return;
            }
            if (Array.isArray(node)) {
                for (const item of node) walk(item, parentType);
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : parentType;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree.toJSON(), null);
        expect(badNodes).toEqual([]);

        act(() => {
            tree.unmount();
        });
    });
});
