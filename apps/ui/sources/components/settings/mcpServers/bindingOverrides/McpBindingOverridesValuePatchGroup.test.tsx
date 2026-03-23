import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { McpValueRefV1 } from '@happier-dev/protocol';
import { renderSettingsView } from '@/dev/testkit';


(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                textSecondary: '#999',
                textDestructive: '#f00',
                accent: { indigo: '#44f' },
                success: '#0f0',
            },
        },
    });
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('McpBindingOverridesValuePatchGroup', () => {
    it('renders malformed value refs with a safe fallback instead of throwing', async () => {
        const { McpBindingOverridesValuePatchGroup } = await import('./McpBindingOverridesValuePatchGroup');
        const invalidValueRef = { t: 'savedSecret' } as unknown as McpValueRefV1;

        const screen = await renderSettingsView(React.createElement(McpBindingOverridesValuePatchGroup, {
                    kind: 'env',
                    patch: { BROKEN: invalidValueRef },
                    setPatch: vi.fn(),
                    openValueRefModal: vi.fn(),
                    onPressDeleteKey: vi.fn(),
                }));

        const brokenRow = screen.findRowByTitle('BROKEN');
        expect(brokenRow?.props.subtitle).toBe('settings.mcpServersValidationFailed');
    });
});
