import type { Session } from '@/sync/domains/state/storageTypes';
import * as React from 'react';
import { EditView, projectEditDisplayText } from '../fileOps/EditView';
import { BashView, projectBashDisplayText } from '../system/BashView';
import { Message, ToolCall } from "@happier-dev/session-core/messages";
import { Metadata } from '@happier-dev/session-core/state';
import { WriteView, projectWriteDisplayText } from '../fileOps/WriteView';
import { TodoView, projectTodoDisplayText } from '../workflow/TodoView';
import { ExitPlanToolView, projectExitPlanDisplayText } from '../workflow/ExitPlanToolView';
import { MultiEditView, projectMultiEditDisplayText } from '../fileOps/MultiEditView';
import { EnterPlanModeView, projectEnterPlanModeDisplayText } from '../workflow/EnterPlanModeView';
import { SubAgentView, projectSubAgentDisplayText } from '../workflow/SubAgentView';
import { PatchView, projectPatchDisplayText } from '../fileOps/PatchView';
import { DiffView, projectDiffDisplayText } from '../fileOps/DiffView';
import { AskUserQuestionView, projectAskUserQuestionDisplayText } from '../workflow/AskUserQuestionView';
import { AcpHistoryImportView, projectAcpHistoryImportDisplayText } from '../system/AcpHistoryImportView';
import { GlobView, projectGlobDisplayText } from '../fileOps/GlobView';
import { GrepView, projectGrepDisplayText } from '../fileOps/GrepView';
import { ReadView, projectReadDisplayText } from '../fileOps/ReadView';
import { WebFetchView, projectWebFetchDisplayText } from '../web/WebFetchView';
import { WebSearchView, projectWebSearchDisplayText } from '../web/WebSearchView';
import { CodeSearchView, projectCodeSearchDisplayText } from '../fileOps/CodeSearchView';
import { ReasoningView, projectReasoningDisplayText } from '../workflow/ReasoningView';
import { WorkspaceIndexingPermissionView, projectWorkspaceIndexingPermissionDisplayText } from '../system/WorkspaceIndexingPermissionView';
import { LSView, projectLSDisplayText } from '../fileOps/LSView';
import { ChangeTitleView, projectChangeTitleDisplayText } from '../workflow/ChangeTitleView';
import { DeleteView, projectDeleteDisplayText } from '../fileOps/DeleteView';
import { MCPToolView, projectMCPDisplayText } from '../system/MCPToolView';
import { UnknownToolView, projectUnknownDisplayText } from '../system/UnknownToolView';
import { SubAgentRunView, projectSubAgentRunDisplayText } from '../workflow/SubAgentRunView';
import { AgentTeamView, projectAgentTeamDisplayText } from '../workflow/AgentTeamView';
import { WorkflowActivityView, projectWorkflowActivityDisplayText } from '../workflow/WorkflowActivityView';
import { TaskOutputView, projectTaskOutputDisplayText } from '../system/TaskOutputView';
import { TaskStopView, projectTaskStopDisplayText } from '../system/TaskStopView';
import { KnownCanonicalToolNameV2Schema, type KnownCanonicalToolNameV2 } from '@happier-dev/protocol';
import { normalizeToolNameForView } from '@/components/tools/normalization/policy/normalizeToolNameForView';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { ExecutionRunPromptResponseTarget } from '@/components/tools/shell/permissions/executionRunPromptResponseTarget';
import type { ToolDisplayTextProjector } from './toolDisplayTextTypes';

export type ToolViewDetailLevel = 'title' | 'summary' | 'full';

export type ToolViewProps = {
    tool: ToolCall;
    metadata: Metadata | null;
    messages: Message[];
    sessionId?: string;
    serverId?: string;
    session?: Session;
    messageId?: string;
    /** Original body block when a text message is presented as a synthetic tool. */
    findBodyBlockId?: string;
    detailLevel?: ToolViewDetailLevel;
    interaction?: TranscriptInteraction;
    /**
     * Set only when a prompt card answers this pending request for an Execution
     * Run; the view then has no Session and must not answer through one.
     */
    executionRun?: ExecutionRunPromptResponseTarget;
}

// Type for tool view components
export type ToolViewComponent = React.ComponentType<ToolViewProps>;

// Registry of tool-specific view components
type ToolViewDescriptor = Readonly<{ component: ToolViewComponent; projectDisplayText: ToolDisplayTextProjector }>;
const toolViewDescriptors: Record<KnownCanonicalToolNameV2, ToolViewDescriptor> = {
    Edit: { component: EditView, projectDisplayText: projectEditDisplayText },
    Bash: { component: BashView, projectDisplayText: projectBashDisplayText },
    Delete: { component: DeleteView, projectDisplayText: projectDeleteDisplayText },
    Patch: { component: PatchView, projectDisplayText: projectPatchDisplayText },
    Diff: { component: DiffView, projectDisplayText: projectDiffDisplayText },
    Reasoning: { component: ReasoningView, projectDisplayText: projectReasoningDisplayText },
    Write: { component: WriteView, projectDisplayText: projectWriteDisplayText },
    Read: { component: ReadView, projectDisplayText: projectReadDisplayText },
    Glob: { component: GlobView, projectDisplayText: projectGlobDisplayText },
    Grep: { component: GrepView, projectDisplayText: projectGrepDisplayText },
    LS: { component: LSView, projectDisplayText: projectLSDisplayText },
    WebFetch: { component: WebFetchView, projectDisplayText: projectWebFetchDisplayText },
    WebSearch: { component: WebSearchView, projectDisplayText: projectWebSearchDisplayText },
    CodeSearch: { component: CodeSearchView, projectDisplayText: projectCodeSearchDisplayText },
    TodoWrite: { component: TodoView, projectDisplayText: projectTodoDisplayText },
    TodoRead: { component: TodoView, projectDisplayText: projectTodoDisplayText },
    SubAgent: { component: SubAgentView, projectDisplayText: projectSubAgentDisplayText },
    EnterPlanMode: { component: EnterPlanModeView, projectDisplayText: projectEnterPlanModeDisplayText },
    ExitPlanMode: { component: ExitPlanToolView, projectDisplayText: projectExitPlanDisplayText },
    MultiEdit: { component: MultiEditView, projectDisplayText: projectMultiEditDisplayText },
    Workflow: { component: WorkflowActivityView, projectDisplayText: projectWorkflowActivityDisplayText },
    Task: { component: SubAgentView, projectDisplayText: projectSubAgentDisplayText },
    // Background-task control tools. Deliberately NOT the subagent card: they act on a detached
    // process, not on a roster entry.
    TaskOutput: { component: TaskOutputView, projectDisplayText: projectTaskOutputDisplayText },
    TaskStop: { component: TaskStopView, projectDisplayText: projectTaskStopDisplayText },
    AskUserQuestion: { component: AskUserQuestionView, projectDisplayText: projectAskUserQuestionDisplayText },
    AcpHistoryImport: { component: AcpHistoryImportView, projectDisplayText: projectAcpHistoryImportDisplayText },
    WorkspaceIndexingPermission: { component: WorkspaceIndexingPermissionView, projectDisplayText: projectWorkspaceIndexingPermissionDisplayText },
    change_title: { component: ChangeTitleView, projectDisplayText: projectChangeTitleDisplayText },
    SubAgentRun: { component: SubAgentRunView, projectDisplayText: projectSubAgentRunDisplayText },
    AgentTeamCreate: { component: AgentTeamView, projectDisplayText: projectAgentTeamDisplayText },
    AgentTeamDelete: { component: AgentTeamView, projectDisplayText: projectAgentTeamDisplayText },
    AgentTeamSendMessage: { component: AgentTeamView, projectDisplayText: projectAgentTeamDisplayText },
};

// Compatibility projection for existing component consumers; descriptors own both paths.
export const toolViewRegistry = Object.fromEntries(Object.entries(toolViewDescriptors)
    .map(([name, descriptor]) => [name, descriptor.component])) as Record<KnownCanonicalToolNameV2, ToolViewComponent>;

function getToolViewDescriptor(toolName: string): ToolViewDescriptor {
    if (toolName.startsWith('mcp__')) return { component: MCPToolView, projectDisplayText: projectMCPDisplayText };
    const parsed = KnownCanonicalToolNameV2Schema.safeParse(normalizeToolNameForView(toolName));
    return parsed.success ? toolViewDescriptors[parsed.data] : { component: UnknownToolView, projectDisplayText: projectUnknownDisplayText };
}

export function getToolDisplayTextProjector(toolName: string): ToolDisplayTextProjector {
    return getToolViewDescriptor(toolName).projectDisplayText;
}

// Helper function to get the appropriate view component for a tool
export function getToolViewComponent(toolName: string): ToolViewComponent | null {
    return getToolViewDescriptor(toolName).component;
}

// Export individual components
export { EditView } from '../fileOps/EditView';
export { BashView } from '../system/BashView';
export { PatchView } from '../fileOps/PatchView';
export { DiffView } from '../fileOps/DiffView';
export { ExitPlanToolView } from '../workflow/ExitPlanToolView';
export { MultiEditView } from '../fileOps/MultiEditView';
export { EnterPlanModeView } from '../workflow/EnterPlanModeView';
export { SubAgentView } from '../workflow/SubAgentView';
export { AskUserQuestionView } from '../workflow/AskUserQuestionView';
export { AcpHistoryImportView } from '../system/AcpHistoryImportView';
export { GlobView } from '../fileOps/GlobView';
export { GrepView } from '../fileOps/GrepView';
export { LSView } from '../fileOps/LSView';
export { ReadView } from '../fileOps/ReadView';
export { WebFetchView } from '../web/WebFetchView';
export { WebSearchView } from '../web/WebSearchView';
export { CodeSearchView } from '../fileOps/CodeSearchView';
export { WorkspaceIndexingPermissionView } from '../system/WorkspaceIndexingPermissionView';
export { ChangeTitleView } from '../workflow/ChangeTitleView';
export { DeleteView } from '../fileOps/DeleteView';
export { TaskOutputView } from '../system/TaskOutputView';
export { TaskStopView } from '../system/TaskStopView';
export { MCPToolView } from '../system/MCPToolView';
export { UnknownToolView } from '../system/UnknownToolView';
export { SubAgentRunView } from '../workflow/SubAgentRunView';
export { WorkflowActivityView } from '../workflow/WorkflowActivityView';
