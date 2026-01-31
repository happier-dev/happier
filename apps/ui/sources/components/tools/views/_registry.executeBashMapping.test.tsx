import { describe, expect, it, vi } from 'vitest';

vi.mock('./EditView', () => ({ EditView: () => null }));
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
vi.mock('./ReadView', () => ({ ReadView: () => null }));
vi.mock('./WebFetchView', () => ({ WebFetchView: () => null }));
vi.mock('./WebSearchView', () => ({ WebSearchView: () => null }));
vi.mock('./CodeSearchView', () => ({ CodeSearchView: () => null }));
vi.mock('./ReasoningView', () => ({ ReasoningView: () => null }));
vi.mock('./WorkspaceIndexingPermissionView', () => ({ WorkspaceIndexingPermissionView: () => null }));
vi.mock('./LSView', () => ({ LSView: () => null }));
vi.mock('./ChangeTitleView', () => ({ ChangeTitleView: () => null }));

describe('toolViewRegistry (execute/codexbash)', () => {
    it('maps execute and CodexBash to the generic Bash renderer', async () => {
        const { getToolViewComponent } = await import('./_registry');
        const { BashView } = await import('./BashView');

        expect(getToolViewComponent('execute')).toBe(BashView);
        expect(getToolViewComponent('CodexBash')).toBe(BashView);
        expect(getToolViewComponent('Bash')).toBe(BashView);
    });
});
