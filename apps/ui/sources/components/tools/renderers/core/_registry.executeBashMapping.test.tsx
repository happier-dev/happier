import { describe, expect, it, vi } from 'vitest';

vi.mock('../fileOps/EditView', () => ({ EditView: () => null }));
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
vi.mock('../fileOps/ReadView', () => ({ ReadView: () => null }));
vi.mock('../web/WebFetchView', () => ({ WebFetchView: () => null }));
vi.mock('../web/WebSearchView', () => ({ WebSearchView: () => null }));
vi.mock('../fileOps/CodeSearchView', () => ({ CodeSearchView: () => null }));
vi.mock('../workflow/ReasoningView', () => ({ ReasoningView: () => null }));
vi.mock('../system/WorkspaceIndexingPermissionView', () => ({ WorkspaceIndexingPermissionView: () => null }));
vi.mock('../fileOps/LSView', () => ({ LSView: () => null }));
vi.mock('../workflow/ChangeTitleView', () => ({ ChangeTitleView: () => null }));

describe('toolViewRegistry (execute/codexbash)', () => {
    it('maps execute and CodexBash to the generic Bash renderer', async () => {
        const [{ getToolViewComponent }, { BashView }] = await Promise.all([
            import('./_registry'),
            import('../system/BashView'),
        ]);

        expect(getToolViewComponent('execute')).toBe(BashView);
        expect(getToolViewComponent('CodexBash')).toBe(BashView);
        expect(getToolViewComponent('Bash')).toBe(BashView);
    });
});
