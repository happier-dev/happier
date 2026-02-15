import { describe, expect, it, vi } from 'vitest';
import type { ToolViewComponent } from './_registry';

// `_registry` imports every tool view module. For these mapping tests we only care
// about registry behavior, so all views are mocked to keep imports light and deterministic.
vi.mock('../fileOps/EditView', () => ({ EditView: () => null }));
vi.mock('../system/BashView', () => ({ BashView: () => null }));
vi.mock('../fileOps/WriteView', () => ({ WriteView: () => null }));
vi.mock('../workflow/TodoView', () => ({ TodoView: () => null }));
vi.mock('../workflow/ExitPlanToolView', () => ({ ExitPlanToolView: () => null }));
vi.mock('../fileOps/MultiEditView', () => ({ MultiEditView: () => null }));
vi.mock('../workflow/EnterPlanModeView', () => ({ EnterPlanModeView: () => null }));
vi.mock('../workflow/TaskView', () => ({ TaskView: () => null }));
vi.mock('../fileOps/PatchView', () => ({ PatchView: () => null }));
vi.mock('../fileOps/DiffView', () => ({ DiffView: () => null }));
vi.mock('../workflow/AskUserQuestionView', () => ({ AskUserQuestionView: () => null }));
vi.mock('../system/AcpHistoryImportView', () => ({ AcpHistoryImportView: () => null }));
vi.mock('../fileOps/GlobView', () => ({ GlobView: () => null }));
vi.mock('../fileOps/GrepView', () => ({ GrepView: () => null }));
vi.mock('../fileOps/LSView', () => ({ LSView: () => null }));
vi.mock('../web/WebFetchView', () => ({ WebFetchView: () => null }));
vi.mock('../web/WebSearchView', () => ({ WebSearchView: () => null }));
vi.mock('../fileOps/CodeSearchView', () => ({ CodeSearchView: () => null }));
vi.mock('../workflow/ReasoningView', () => ({ ReasoningView: () => null }));
vi.mock('../workflow/SubAgentRunView', () => ({ SubAgentRunView: () => null }));
vi.mock('../system/WorkspaceIndexingPermissionView', () => ({ WorkspaceIndexingPermissionView: () => null }));
vi.mock('../fileOps/DeleteView', () => ({ DeleteView: () => null }));
vi.mock('../system/UnknownToolView', () => ({ UnknownToolView: () => null }));
vi.mock('../system/MCPToolView', () => ({
    MCPToolView: () => null,
    formatMCPTitle: () => 'MCP',
    formatMCPSubtitle: () => '',
}));

async function loadRegistry() {
    const [{ getToolViewComponent }, views] = await Promise.all([import('./_registry'), import('./_registry')]);
    return {
        getToolViewComponent: getToolViewComponent as (name: string) => ToolViewComponent | null,
        views,
    };
}

describe('toolViewRegistry', () => {
    it('registers a Read view for lowercase read tool name', async () => {
        const [{ getToolViewComponent }, { ReadView }] = await Promise.all([import('./_registry'), import('../fileOps/ReadView')]);
        expect(getToolViewComponent('read')).toBe(ReadView);
    });

    it('maps ACP lowercase tool names to canonical renderers (search/glob/grep/ls/write/delete)', async () => {
        const [{ getToolViewComponent, toolViewRegistry }] = await Promise.all([import('./_registry')]);

        expect(getToolViewComponent('search')).toBe(toolViewRegistry.CodeSearch);
        expect(getToolViewComponent('glob')).toBe(toolViewRegistry.Glob);
        expect(getToolViewComponent('grep')).toBe(toolViewRegistry.Grep);
        expect(getToolViewComponent('ls')).toBe(toolViewRegistry.LS);
        expect(getToolViewComponent('write')).toBe(toolViewRegistry.Write);
        expect(getToolViewComponent('delete')).toBe(toolViewRegistry.Delete);
        expect(getToolViewComponent('remove')).toBe(toolViewRegistry.Delete);
    });

    it('maps Claude task helper tools to TaskView (TaskCreate/TaskList/TaskUpdate)', async () => {
        const [{ getToolViewComponent }, { TaskView }] = await Promise.all([import('./_registry'), import('./_registry')]);

        expect(getToolViewComponent('TaskCreate')).toBe(TaskView);
        expect(getToolViewComponent('TaskList')).toBe(TaskView);
        expect(getToolViewComponent('TaskUpdate')).toBe(TaskView);
    });

    it('returns a renderer for canonical Patch tools', async () => {
        const { getToolViewComponent } = await loadRegistry();
        expect(getToolViewComponent('Patch')).not.toBeNull();
    });

    it('maps SubAgentRun to its dedicated view', async () => {
        const [{ getToolViewComponent, toolViewRegistry }] = await Promise.all([import('./_registry')]);
        expect(getToolViewComponent('SubAgentRun')).toBe(toolViewRegistry.SubAgentRun);
    });

    it('uses the MCP tool renderer for any mcp__* tool name', async () => {
        const [{ getToolViewComponent }, { MCPToolView }] = await Promise.all([import('./_registry'), import('../system/MCPToolView')]);
        expect(getToolViewComponent('mcp__linear__create_issue')).toBe(MCPToolView);
    });

    it('falls back to a generic renderer for unknown tool names', async () => {
        const [{ getToolViewComponent }, { UnknownToolView }] = await Promise.all([import('./_registry'), import('../system/UnknownToolView')]);
        expect(getToolViewComponent('TotallyNewToolFromFutureProvider')).toBe(UnknownToolView);
    });
});
