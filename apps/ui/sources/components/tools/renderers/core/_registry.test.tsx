import { describe, expect, it, vi } from 'vitest';
import type { ToolViewComponent } from './_registry';

// `_registry` imports every tool view module. For these mapping tests we only care
// about registry behavior, so all views are mocked to keep imports light and deterministic.
vi.mock('../fileOps/EditView', () => ({ EditView: () => null, projectEditDisplayText: () => [] }));
vi.mock('../system/BashView', () => ({ BashView: () => null, projectBashDisplayText: () => [] }));
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
vi.mock('../fileOps/LSView', () => ({ LSView: () => null, projectLSDisplayText: () => [] }));
vi.mock('../web/WebFetchView', () => ({ WebFetchView: () => null, projectWebFetchDisplayText: () => [] }));
vi.mock('../web/WebSearchView', () => ({ WebSearchView: () => null, projectWebSearchDisplayText: () => [] }));
vi.mock('../fileOps/CodeSearchView', () => ({ CodeSearchView: () => null, projectCodeSearchDisplayText: () => [] }));
vi.mock('../workflow/ReasoningView', () => ({ ReasoningView: () => null, projectReasoningDisplayText: () => [] }));
vi.mock('../workflow/SubAgentRunView', () => ({ SubAgentRunView: () => null, projectSubAgentRunDisplayText: () => [] }));
vi.mock('../workflow/WorkflowActivityView', () => ({ WorkflowActivityView: () => null, projectWorkflowActivityDisplayText: () => [] }));
vi.mock('../workflow/AgentTeamView', () => ({ AgentTeamView: () => null, projectAgentTeamDisplayText: () => [] }));
vi.mock('../system/WorkspaceIndexingPermissionView', () => ({ WorkspaceIndexingPermissionView: () => null, projectWorkspaceIndexingPermissionDisplayText: () => [] }));
vi.mock('../fileOps/DeleteView', () => ({ DeleteView: () => null, projectDeleteDisplayText: () => [] }));
vi.mock('../system/UnknownToolView', () => ({ UnknownToolView: () => null, projectUnknownDisplayText: () => [] }));
vi.mock('../system/MCPToolView', () => ({
    MCPToolView: () => null,
    projectMCPDisplayText: () => [],
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

    it('keeps background-task control tools off the subagent card', async () => {
        const [{ getToolViewComponent, SubAgentView, TaskOutputView, TaskStopView }] = await Promise.all([import('./_registry')]);

        for (const name of ['TaskOutput', 'task_output']) {
            expect(getToolViewComponent(name)).toBe(TaskOutputView);
            expect(getToolViewComponent(name)).not.toBe(SubAgentView);
        }
        for (const name of ['TaskStop', 'task_stop']) {
            expect(getToolViewComponent(name)).toBe(TaskStopView);
            expect(getToolViewComponent(name)).not.toBe(SubAgentView);
        }
    });

    it('maps Claude task helper tools to SubAgentView (TaskCreate/TaskList/TaskUpdate)', async () => {
        const [{ getToolViewComponent }, { SubAgentView }] = await Promise.all([import('./_registry'), import('./_registry')]);

        expect(getToolViewComponent('TaskCreate')).toBe(SubAgentView);
        expect(getToolViewComponent('TaskList')).toBe(SubAgentView);
        expect(getToolViewComponent('TaskUpdate')).toBe(SubAgentView);
        expect(getToolViewComponent('SubAgent')).toBe(SubAgentView);
    });

    it('returns a renderer for canonical Patch tools', async () => {
        const { getToolViewComponent } = await loadRegistry();
        expect(getToolViewComponent('Patch')).not.toBeNull();
    });

    it('maps SubAgentRun to its dedicated view', async () => {
        const [{ getToolViewComponent, toolViewRegistry }] = await Promise.all([import('./_registry')]);
        expect(getToolViewComponent('SubAgentRun')).toBe(toolViewRegistry.SubAgentRun);
    });

    it('maps canonical Workflow to the records-backed WorkflowActivityView, distinct from the subagent view (no double render)', async () => {
        const [{ getToolViewComponent, toolViewRegistry }, { WorkflowActivityView }, { SubAgentView }] = await Promise.all([
            import('./_registry'),
            import('../workflow/WorkflowActivityView'),
            import('./_registry'),
        ]);
        expect(getToolViewComponent('Workflow')).toBe(WorkflowActivityView);
        expect(toolViewRegistry.Workflow).toBe(WorkflowActivityView);
        // The durable workflow card and the message-derived subagent summary are SEPARATE renderers:
        // a canonical `Workflow` tool must never resolve to the subagent path (would double-render).
        expect(getToolViewComponent('Workflow')).not.toBe(SubAgentView);
        expect(getToolViewComponent('Task')).toBe(SubAgentView);
        expect(getToolViewComponent('SubAgent')).toBe(SubAgentView);
    });

    it('maps Agent Team tools to a dedicated view', async () => {
        const [{ getToolViewComponent, toolViewRegistry }] = await Promise.all([import('./_registry')]);
        expect(getToolViewComponent('AgentTeamCreate')).toBe(toolViewRegistry.AgentTeamCreate);
        expect(getToolViewComponent('AgentTeamDelete')).toBe(toolViewRegistry.AgentTeamDelete);
        expect(getToolViewComponent('AgentTeamSendMessage')).toBe(toolViewRegistry.AgentTeamSendMessage);
    });

    it('uses the MCP tool renderer for any mcp__* tool name', async () => {
        const [{ getToolViewComponent }, { MCPToolView }] = await Promise.all([import('./_registry'), import('../system/MCPToolView')]);
        expect(getToolViewComponent('mcp__linear__create_issue')).toBe(MCPToolView);
    });

    it('does not route malformed slash-delimited change title names directly to the dedicated renderer', async () => {
        const [{ getToolViewComponent }, { UnknownToolView }] = await Promise.all([import('./_registry'), import('../system/UnknownToolView')]);

        expect(getToolViewComponent('happier/change_title')).toBe(UnknownToolView);
    });

    it('falls back to a generic renderer for unknown tool names', async () => {
        const [{ getToolViewComponent }, { UnknownToolView }] = await Promise.all([import('./_registry'), import('../system/UnknownToolView')]);
        expect(getToolViewComponent('TotallyNewToolFromFutureProvider')).toBe(UnknownToolView);
    });
});
