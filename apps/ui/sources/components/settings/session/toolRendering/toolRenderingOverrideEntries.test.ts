import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => {
        if (key === 'tools.names.changeTitle') return 'Change title';
        if (key === 'tools.names.subAgent') return 'Sub-agent';
        if (key === 'tools.names.planProposal') return 'Plan proposal';
        if (key === 'tools.names.readFile') return 'Read file';
        if (key === 'tools.names.editFile') return 'Edit file';
        if (key === 'tools.names.writeFile') return 'Write file';
        if (key === 'tools.names.searchFiles') return 'Search files';
        if (key === 'tools.names.searchContent') return 'Search content';
        if (key === 'tools.names.listFiles') return 'List files';
        if (key === 'tools.names.search') return 'Search';
        if (key === 'tools.names.fetchUrl') return 'Fetch URL';
        if (key === 'tools.names.webSearch') return 'Web search';
        if (key === 'tools.names.todoList') return 'To-do list';
        if (key === 'tools.names.reasoning') return 'Reasoning';
        if (key === 'tools.workspaceIndexingPermission.defaultTitle') return 'Workspace indexing';
        return key;
    },
}));

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
