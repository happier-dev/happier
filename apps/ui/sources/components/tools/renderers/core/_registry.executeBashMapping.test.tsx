import { describe, expect, it, vi } from 'vitest';

vi.mock('../fileOps/EditView', () => ({ EditView: () => null, projectEditDisplayText: () => [] }));
vi.mock('../fileOps/WriteView', () => ({ WriteView: () => null, projectWriteDisplayText: () => [] }));
vi.mock('../workflow/TodoView', () => ({ TodoView: () => null, projectTodoDisplayText: () => [] }));
vi.mock('../workflow/ExitPlanToolView', () => ({ ExitPlanToolView: () => null, projectExitPlanDisplayText: () => [] }));
vi.mock('../fileOps/MultiEditView', () => ({ MultiEditView: () => null, projectMultiEditDisplayText: () => [] }));
vi.mock('../workflow/EnterPlanModeView', () => ({ EnterPlanModeView: () => null, projectEnterPlanModeDisplayText: () => [] }));
vi.mock('../workflow/SubAgentView', () => ({ SubAgentView: () => null, projectSubAgentDisplayText: () => [] }));
vi.mock('../fileOps/PatchView', () => ({ PatchView: () => null, projectPatchDisplayText: () => [] }));
vi.mock('../fileOps/DiffView', () => ({ DiffView: () => null, projectDiffDisplayText: () => [] }));
vi.mock('../workflow/AskUserQuestionView', () => ({ AskUserQuestionView: () => null, projectAskUserQuestionDisplayText: () => [] }));
vi.mock('../system/AcpHistoryImportView', () => ({ AcpHistoryImportView: () => null, projectAcpHistoryImportDisplayText: () => [] }));
vi.mock('../fileOps/GlobView', () => ({ GlobView: () => null, projectGlobDisplayText: () => [] }));
vi.mock('../fileOps/GrepView', () => ({ GrepView: () => null, projectGrepDisplayText: () => [] }));
vi.mock('../fileOps/ReadView', () => ({ ReadView: () => null, projectReadDisplayText: () => [] }));
vi.mock('../web/WebFetchView', () => ({ WebFetchView: () => null, projectWebFetchDisplayText: () => [] }));
vi.mock('../web/WebSearchView', () => ({ WebSearchView: () => null, projectWebSearchDisplayText: () => [] }));
vi.mock('../fileOps/CodeSearchView', () => ({ CodeSearchView: () => null, projectCodeSearchDisplayText: () => [] }));
vi.mock('../workflow/ReasoningView', () => ({ ReasoningView: () => null, projectReasoningDisplayText: () => [] }));
vi.mock('../system/WorkspaceIndexingPermissionView', () => ({ WorkspaceIndexingPermissionView: () => null, projectWorkspaceIndexingPermissionDisplayText: () => [] }));
vi.mock('../fileOps/LSView', () => ({ LSView: () => null, projectLSDisplayText: () => [] }));
vi.mock('../workflow/ChangeTitleView', () => ({ ChangeTitleView: () => null, projectChangeTitleDisplayText: () => [] }));

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
