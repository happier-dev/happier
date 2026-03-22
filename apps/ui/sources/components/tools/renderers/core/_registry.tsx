import * as React from 'react';
import { EditView } from '../fileOps/EditView';
import { BashView } from '../system/BashView';
import { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import { Metadata } from '@/sync/domains/state/storageTypes';
import { WriteView } from '../fileOps/WriteView';
import { TodoView } from '../workflow/TodoView';
import { ExitPlanToolView } from '../workflow/ExitPlanToolView';
import { MultiEditView } from '../fileOps/MultiEditView';
import { EnterPlanModeView } from '../workflow/EnterPlanModeView';
import { SubAgentView } from '../workflow/SubAgentView';
import { PatchView } from '../fileOps/PatchView';
import { DiffView } from '../fileOps/DiffView';
import { AskUserQuestionView } from '../workflow/AskUserQuestionView';
import { AcpHistoryImportView } from '../system/AcpHistoryImportView';
import { GlobView } from '../fileOps/GlobView';
import { GrepView } from '../fileOps/GrepView';
import { ReadView } from '../fileOps/ReadView';
import { WebFetchView } from '../web/WebFetchView';
import { WebSearchView } from '../web/WebSearchView';
import { CodeSearchView } from '../fileOps/CodeSearchView';
import { ReasoningView } from '../workflow/ReasoningView';
import { WorkspaceIndexingPermissionView } from '../system/WorkspaceIndexingPermissionView';
import { LSView } from '../fileOps/LSView';
import { ChangeTitleView } from '../workflow/ChangeTitleView';
import { DeleteView } from '../fileOps/DeleteView';
import { MCPToolView } from '../system/MCPToolView';
import { UnknownToolView } from '../system/UnknownToolView';
import { SubAgentRunView } from '../workflow/SubAgentRunView';
import { AgentTeamView } from '../workflow/AgentTeamView';
import { KnownCanonicalToolNameV2Schema, type KnownCanonicalToolNameV2 } from '@happier-dev/protocol';
import { normalizeToolNameForView } from '@/components/tools/normalization/policy/normalizeToolNameForView';

export type ToolViewDetailLevel = 'title' | 'summary' | 'full';

export type ToolViewProps = {
    tool: ToolCall;
    metadata: Metadata | null;
    messages: Message[];
    sessionId?: string;
    messageId?: string;
    detailLevel?: ToolViewDetailLevel;
    interaction?: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    };
}

// Type for tool view components
export type ToolViewComponent = React.ComponentType<ToolViewProps>;

// Registry of tool-specific view components
export const toolViewRegistry: Record<KnownCanonicalToolNameV2, ToolViewComponent> = {
    Edit: EditView,
    Bash: BashView,
    Delete: DeleteView,
    Patch: PatchView,
    Diff: DiffView,
    Reasoning: ReasoningView,
    Write: WriteView,
    Read: ReadView,
    Glob: GlobView,
    Grep: GrepView,
    LS: LSView,
    WebFetch: WebFetchView,
    WebSearch: WebSearchView,
    CodeSearch: CodeSearchView,
    TodoWrite: TodoView,
    TodoRead: TodoView,
    SubAgent: SubAgentView,
    EnterPlanMode: EnterPlanModeView,
    ExitPlanMode: ExitPlanToolView,
    MultiEdit: MultiEditView,
    Task: SubAgentView,
    AskUserQuestion: AskUserQuestionView,
    AcpHistoryImport: AcpHistoryImportView,
    WorkspaceIndexingPermission: WorkspaceIndexingPermissionView,
    change_title: ChangeTitleView,
    SubAgentRun: SubAgentRunView,
    AgentTeamCreate: AgentTeamView,
    AgentTeamDelete: AgentTeamView,
    AgentTeamSendMessage: AgentTeamView,
};

// Helper function to get the appropriate view component for a tool
export function getToolViewComponent(toolName: string): ToolViewComponent | null {
    if (toolName.startsWith('mcp__')) return MCPToolView;
    const normalizedName = normalizeToolNameForView(toolName);
    const parsed = KnownCanonicalToolNameV2Schema.safeParse(normalizedName);
    if (!parsed.success) return UnknownToolView;
    return toolViewRegistry[parsed.data] ?? UnknownToolView;
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
export { MCPToolView } from '../system/MCPToolView';
export { UnknownToolView } from '../system/UnknownToolView';
export { SubAgentRunView } from '../workflow/SubAgentRunView';
