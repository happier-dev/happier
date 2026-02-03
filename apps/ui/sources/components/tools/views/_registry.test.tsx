import { describe, expect, it, vi } from 'vitest';

// `_registry` imports every tool view module. For this unit test we only care about the
// `read` → `ReadView` mapping, so we stub the rest to keep the import surface minimal.
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

describe('toolViewRegistry', () => {
    it('registers a Read view for lowercase read tool name', async () => {
        // Import lazily so Vitest can apply stubs/mocks before module evaluation.
        let getToolViewComponent: (name: string) => any;
        let ReadView: any;
        try {
            ({ getToolViewComponent } = await import('./_registry'));
            ({ ReadView } = await import('./ReadView'));
        } catch (e: any) {
            // Re-throw with a stack that includes the failing module path (Vitest can sometimes
            // drop module-load context for syntax errors).
            throw new Error(e?.stack ? String(e.stack) : String(e));
        }

        expect(getToolViewComponent('read')).toBe(ReadView);
    });

    it('maps legacy provider tool names to the canonical renderer (CodexBash → BashView)', async () => {
        let getToolViewComponent: (name: string) => any;
        let BashView: any;
        try {
            ({ getToolViewComponent } = await import('./_registry'));
            ({ BashView } = await import('./BashView'));
        } catch (e: any) {
            throw new Error(e?.stack ? String(e.stack) : String(e));
        }

        expect(getToolViewComponent('CodexBash')).toBe(BashView);
    });

    it('maps ACP lowercase tool names to canonical renderers (search/glob/grep/ls/write/delete)', async () => {
        let getToolViewComponent: (name: string) => any;
        let CodeSearchView: any;
        let GlobView: any;
        let GrepView: any;
        let LSView: any;
        let WriteView: any;
        let DeleteView: any;
        try {
            ({ getToolViewComponent } = await import('./_registry'));
            ({ CodeSearchView } = await import('./CodeSearchView'));
            ({ GlobView } = await import('./GlobView'));
            ({ GrepView } = await import('./GrepView'));
            ({ LSView } = await import('./LSView'));
            ({ WriteView } = await import('./WriteView'));
            ({ DeleteView } = await import('./DeleteView'));
        } catch (e: any) {
            throw new Error(e?.stack ? String(e.stack) : String(e));
        }

        expect(getToolViewComponent('search')).toBe(CodeSearchView);
        expect(getToolViewComponent('glob')).toBe(GlobView);
        expect(getToolViewComponent('grep')).toBe(GrepView);
        expect(getToolViewComponent('ls')).toBe(LSView);
        expect(getToolViewComponent('write')).toBe(WriteView);
        expect(getToolViewComponent('delete')).toBe(DeleteView);
        expect(getToolViewComponent('remove')).toBe(DeleteView);
    });

    it('maps Claude task helper tools to TaskView (TaskCreate/TaskList/TaskUpdate)', async () => {
        let getToolViewComponent: (name: string) => any;
        let TaskView: any;
        try {
            ({ getToolViewComponent } = await import('./_registry'));
            ({ TaskView } = await import('./TaskView'));
        } catch (e: any) {
            throw new Error(e?.stack ? String(e.stack) : String(e));
        }

        expect(getToolViewComponent('TaskCreate')).toBe(TaskView);
        expect(getToolViewComponent('TaskList')).toBe(TaskView);
        expect(getToolViewComponent('TaskUpdate')).toBe(TaskView);
    });

    it('returns a renderer for canonical Patch tools', async () => {
        let getToolViewComponent: (name: string) => any;
        try {
            ({ getToolViewComponent } = await import('./_registry'));
        } catch (e: any) {
            throw new Error(e?.stack ? String(e.stack) : String(e));
        }

        expect(getToolViewComponent('Patch')).not.toBeNull();
    });

    it('uses the MCP tool renderer for any mcp__* tool name', async () => {
        let getToolViewComponent: (name: string) => any;
        let MCPToolView: any;
        try {
            ({ getToolViewComponent } = await import('./_registry'));
            ({ MCPToolView } = await import('./MCPToolView'));
        } catch (e: any) {
            throw new Error(e?.stack ? String(e.stack) : String(e));
        }

        expect(getToolViewComponent('mcp__linear__create_issue')).toBe(MCPToolView);
    });

    it('falls back to a generic renderer for unknown tool names (do not drop tool cards)', async () => {
        let getToolViewComponent: (name: string) => any;
        let UnknownToolView: any;
        try {
            ({ getToolViewComponent } = await import('./_registry'));
            ({ UnknownToolView } = await import('./UnknownToolView'));
        } catch (e: any) {
            throw new Error(e?.stack ? String(e.stack) : String(e));
        }

        expect(getToolViewComponent('TotallyNewToolFromFutureProvider')).toBe(UnknownToolView);
    });
});
