import { describe, expect, it, vi } from 'vitest';
import type { ToolViewComponent } from './_registry';

// `_registry` imports every tool view module. For these mapping tests we only care
// about registry behavior, so all views are mocked to keep imports light and deterministic.
vi.mock('./EditView', () => ({ EditView: () => null }));
vi.mock('./BashView', () => ({ BashView: () => null }));
vi.mock('./WriteView', () => ({ WriteView: () => null }));
vi.mock('./TodoView', () => ({ TodoView: () => null }));
vi.mock('./ExitPlanToolView', () => ({ ExitPlanToolView: () => null }));
vi.mock('./MultiEditView', () => ({ MultiEditView: () => null }));
vi.mock('./EnterPlanModeView', () => ({ EnterPlanModeView: () => null }));
vi.mock('./TaskView', () => ({ TaskView: () => null }));
vi.mock('./PatchView', () => ({ PatchView: () => null }));
vi.mock('./DiffView', () => ({ DiffView: () => null }));
vi.mock('./AskUserQuestionView', () => ({ AskUserQuestionView: () => null }));
vi.mock('./AcpHistoryImportView', () => ({ AcpHistoryImportView: () => null }));
vi.mock('./GlobView', () => ({ GlobView: () => null }));
vi.mock('./GrepView', () => ({ GrepView: () => null }));
vi.mock('./LSView', () => ({ LSView: () => null }));
vi.mock('./WebFetchView', () => ({ WebFetchView: () => null }));
vi.mock('./WebSearchView', () => ({ WebSearchView: () => null }));
vi.mock('./CodeSearchView', () => ({ CodeSearchView: () => null }));
vi.mock('./ReasoningView', () => ({ ReasoningView: () => null }));
vi.mock('./WorkspaceIndexingPermissionView', () => ({ WorkspaceIndexingPermissionView: () => null }));
vi.mock('./DeleteView', () => ({ DeleteView: () => null }));
vi.mock('./UnknownToolView', () => ({ UnknownToolView: () => null }));
vi.mock('./MCPToolView', () => ({
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
        const [{ getToolViewComponent }, { ReadView }] = await Promise.all([import('./_registry'), import('./ReadView')]);
        expect(getToolViewComponent('read')).toBe(ReadView);
    });

    it('maps ACP lowercase tool names to canonical renderers (search/glob/grep/ls/write/delete)', async () => {
        const [{ getToolViewComponent, CodeSearchView, GlobView, GrepView, LSView, DeleteView }, { WriteView }] =
            await Promise.all([import('./_registry'), import('./WriteView')]);

        expect(getToolViewComponent('search')).toBe(CodeSearchView);
        expect(getToolViewComponent('glob')).toBe(GlobView);
        expect(getToolViewComponent('grep')).toBe(GrepView);
        expect(getToolViewComponent('ls')).toBe(LSView);
        expect(getToolViewComponent('write')).toBe(WriteView);
        expect(getToolViewComponent('delete')).toBe(DeleteView);
        expect(getToolViewComponent('remove')).toBe(DeleteView);
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

    it('uses the MCP tool renderer for any mcp__* tool name', async () => {
        const [{ getToolViewComponent }, { MCPToolView }] = await Promise.all([import('./_registry'), import('./MCPToolView')]);
        expect(getToolViewComponent('mcp__linear__create_issue')).toBe(MCPToolView);
    });

    it('falls back to a generic renderer for unknown tool names', async () => {
        const [{ getToolViewComponent }, { UnknownToolView }] = await Promise.all([import('./_registry'), import('./UnknownToolView')]);
        expect(getToolViewComponent('TotallyNewToolFromFutureProvider')).toBe(UnknownToolView);
    });
});
