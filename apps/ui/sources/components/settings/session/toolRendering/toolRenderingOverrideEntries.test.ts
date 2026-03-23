import { describe, expect, it, vi } from 'vitest';
import { installSessionSettingsCommonModuleMocks } from '../sessionSettingsViewTestHelpers';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

installSessionSettingsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => {
                switch (key) {
                    case 'tools.workspaceIndexingPermission.defaultTitle':
                        return 'Workspace indexing';
                    case 'tools.names.subAgent':
                        return 'Sub-agent';
                    case 'tools.names.changeTitle':
                        return 'Change title';
                    default:
                        return key;
                }
            },
        });
    },
});

describe('TOOL_RENDERING_OVERRIDE_ENTRIES', () => {
    it('covers normalized canonical tool names without stale omissions or alias duplicates', async () => {
        const { TOOL_RENDERING_OVERRIDE_ENTRIES } = await import('./toolRenderingOverrideEntries');

        expect(TOOL_RENDERING_OVERRIDE_ENTRIES).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ toolName: 'Delete', title: 'Delete' }),
                expect.objectContaining({ toolName: 'WorkspaceIndexingPermission', title: 'Workspace indexing' }),
                expect.objectContaining({ toolName: 'SubAgent', title: 'Sub-agent' }),
            ]),
        );

        expect(TOOL_RENDERING_OVERRIDE_ENTRIES.filter((entry) => entry.toolName === 'SubAgent')).toHaveLength(1);
        expect(TOOL_RENDERING_OVERRIDE_ENTRIES.find((entry) => entry.toolName === 'change_title')?.title).toBe('Change title');
    });
});
