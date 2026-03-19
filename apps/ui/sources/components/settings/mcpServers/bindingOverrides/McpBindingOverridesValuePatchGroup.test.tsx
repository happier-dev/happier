import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { McpValueRefV1 } from '@happier-dev/protocol';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#999',
                textDestructive: '#f00',
                accent: { indigo: '#44f' },
                success: '#0f0',
            },
        },
    }),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('McpBindingOverridesValuePatchGroup', () => {
    it('renders malformed value refs with a safe fallback instead of throwing', async () => {
        const { McpBindingOverridesValuePatchGroup } = await import('./McpBindingOverridesValuePatchGroup');
        const invalidValueRef = { t: 'savedSecret' } as unknown as McpValueRefV1;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(McpBindingOverridesValuePatchGroup, {
                    kind: 'env',
                    patch: { BROKEN: invalidValueRef },
                    setPatch: vi.fn(),
                    openValueRefModal: vi.fn(),
                    onPressDeleteKey: vi.fn(),
                }),
            );
        });

        const brokenRow = tree.root.findAll((node) => node.props?.title === 'BROKEN')[0];
        expect(brokenRow?.props.subtitle).toBe('settings.mcpServersValidationFailed');
    });
});
