import { describe, expect, it, vi } from 'vitest';

// `_registry` imports every tool view module. For this unit test we only care about the
// `read` → `ReadView` mapping, so we stub the rest to keep the import surface minimal.
vi.mock('./EditView', () => ({ EditView: () => null }));
vi.mock('./BashView', () => ({ BashView: () => null }));
vi.mock('./WriteView', () => ({ WriteView: () => null }));
vi.mock('./TodoView', () => ({ TodoView: () => null }));
vi.mock('./ExitPlanToolView', () => ({ ExitPlanToolView: () => null }));
vi.mock('./MultiEditView', () => ({ MultiEditView: () => null }));
vi.mock('./TaskView', () => ({ TaskView: () => null }));
vi.mock('./BashViewFull', () => ({ BashViewFull: () => null }));
vi.mock('./EditViewFull', () => ({ EditViewFull: () => null }));
vi.mock('./MultiEditViewFull', () => ({ MultiEditViewFull: () => null }));
vi.mock('./CodexBashView', () => ({ CodexBashView: () => null }));
vi.mock('./CodexPatchView', () => ({ CodexPatchView: () => null }));
vi.mock('./CodexDiffView', () => ({ CodexDiffView: () => null }));
vi.mock('./PatchView', () => ({ PatchView: () => null }));
vi.mock('./DiffView', () => ({ DiffView: () => null }));
vi.mock('./AskUserQuestionView', () => ({ AskUserQuestionView: () => null }));
vi.mock('./GeminiEditView', () => ({ GeminiEditView: () => null }));
vi.mock('./GeminiExecuteView', () => ({ GeminiExecuteView: () => null }));
vi.mock('./AcpHistoryImportView', () => ({ AcpHistoryImportView: () => null }));
vi.mock('./GlobView', () => ({ GlobView: () => null }));
vi.mock('./GrepView', () => ({ GrepView: () => null }));
vi.mock('./WebFetchView', () => ({ WebFetchView: () => null }));
vi.mock('./WebSearchView', () => ({ WebSearchView: () => null }));
vi.mock('./CodeSearchView', () => ({ CodeSearchView: () => null }));
vi.mock('./ReasoningView', () => ({ ReasoningView: () => null }));

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
});
