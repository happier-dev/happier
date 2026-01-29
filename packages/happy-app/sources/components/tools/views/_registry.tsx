import * as React from 'react';
import { EditView } from './EditView';
import { BashView } from './BashView';
import { Message, ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { WriteView } from './WriteView';
import { TodoView } from './TodoView';
import { ExitPlanToolView } from './ExitPlanToolView';
import { MultiEditView } from './MultiEditView';
import { EnterPlanModeView } from './EnterPlanModeView';
import { TaskView } from './TaskView';
import { PatchView } from './PatchView';
import { DiffView } from './DiffView';
import { AskUserQuestionView } from './AskUserQuestionView';
import { AcpHistoryImportView } from './AcpHistoryImportView';
import { GlobView } from './GlobView';
import { GrepView } from './GrepView';
import { ReadView } from './ReadView';
import { WebFetchView } from './WebFetchView';
import { WebSearchView } from './WebSearchView';
import { CodeSearchView } from './CodeSearchView';
import { ReasoningView } from './ReasoningView';
import { WorkspaceIndexingPermissionView } from './WorkspaceIndexingPermissionView';
import { LSView } from './LSView';
import { ChangeTitleView } from './ChangeTitleView';
import { DeleteView } from './DeleteView';
import { MCPToolView } from './MCPToolView';

export type ToolViewDetailLevel = 'title' | 'summary' | 'full';

export type ToolViewProps = {
    tool: ToolCall;
    metadata: Metadata | null;
    messages: Message[];
    sessionId?: string;
    detailLevel?: ToolViewDetailLevel;
    interaction?: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted';
    };
}

// Type for tool view components
export type ToolViewComponent = React.ComponentType<ToolViewProps>;

// Registry of tool-specific view components
export const toolViewRegistry: Record<string, ToolViewComponent> = {
    Edit: EditView,
    Bash: BashView,
    Delete: DeleteView,
    Patch: PatchView,
    Diff: DiffView,
    Reasoning: ReasoningView,
    CodexBash: BashView,
    CodexPatch: PatchView,
    CodexDiff: DiffView,
    Write: WriteView,
    Read: ReadView,
    read: ReadView,
    Glob: GlobView,
    Grep: GrepView,
    LS: LSView,
    WebFetch: WebFetchView,
    WebSearch: WebSearchView,
    CodeSearch: CodeSearchView,
    TodoWrite: TodoView,
    TodoRead: TodoView,
    EnterPlanMode: EnterPlanModeView,
    ExitPlanMode: ExitPlanToolView,
    exit_plan_mode: ExitPlanToolView,
    MultiEdit: MultiEditView,
    Task: TaskView,
    AskUserQuestion: AskUserQuestionView,
    AcpHistoryImport: AcpHistoryImportView,
    WorkspaceIndexingPermission: WorkspaceIndexingPermissionView,
    change_title: ChangeTitleView,
    // ACP providers often use lowercase tool names
    edit: EditView,
    execute: BashView,
    GeminiReasoning: ReasoningView,
    CodexReasoning: ReasoningView,
    think: ReasoningView,
};

// Helper function to get the appropriate view component for a tool
export function getToolViewComponent(toolName: string): ToolViewComponent | null {
    if (toolName.startsWith('mcp__')) return MCPToolView;
    return toolViewRegistry[toolName] || null;
}

// Export individual components
export { EditView } from './EditView';
export { BashView } from './BashView';
export { PatchView } from './PatchView';
export { DiffView } from './DiffView';
export { ExitPlanToolView } from './ExitPlanToolView';
export { MultiEditView } from './MultiEditView';
export { EnterPlanModeView } from './EnterPlanModeView';
export { TaskView } from './TaskView';
export { AskUserQuestionView } from './AskUserQuestionView';
export { AcpHistoryImportView } from './AcpHistoryImportView';
export { GlobView } from './GlobView';
export { GrepView } from './GrepView';
export { LSView } from './LSView';
export { ReadView } from './ReadView';
export { WebFetchView } from './WebFetchView';
export { WebSearchView } from './WebSearchView';
export { CodeSearchView } from './CodeSearchView';
export { WorkspaceIndexingPermissionView } from './WorkspaceIndexingPermissionView';
export { ChangeTitleView } from './ChangeTitleView';
export { DeleteView } from './DeleteView';
export { MCPToolView } from './MCPToolView';
