import { z } from 'zod';
import { StructuredQuestionAnswersV1Schema } from '../structuredQuestionAnswersV1.js';
import type { KnownCanonicalToolNameV2 } from './names.js';
import { ToolHappyMetaV2Schema, ToolHappierMetaV2Schema } from './meta.js';

const BaseEnvelopeSchema = z.object({
  _happier: ToolHappierMetaV2Schema.optional(),
  // Legacy envelope key accepted for migration back-compat.
  _happy: ToolHappyMetaV2Schema.optional(),
  _raw: z.unknown().optional(),
}).passthrough();

// Common primitives (shared between many tools).
const FilePathSchema = z.string().min(1);
const UrlSchema = z.string().min(1);

export const BashInputV2Schema = BaseEnvelopeSchema.extend({
  command: z.string().min(1).optional(),
  timeout: z.number().int().positive().optional(),
  // A *request* to detach the command. Only the result's `backgroundTaskId` attests that the
  // provider actually detached it, so renderers must not treat this flag as proof.
  run_in_background: z.boolean().optional(),
}).passthrough();

export const BashResultV2Schema = BaseEnvelopeSchema.extend({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exit_code: z.number().int().optional(),
  // Present only when the provider detached the command. This is the join key between the `Bash`
  // tool result and the background-task ledger/record that tracks the detached process.
  backgroundTaskId: z.string().optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const ReadInputV2Schema = BaseEnvelopeSchema.extend({
  file_path: FilePathSchema.optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).optional(),
}).passthrough();

export const ReadResultV2Schema = BaseEnvelopeSchema.extend({
  file: z.object({
    content: z.string(),
    filePath: FilePathSchema.optional(),
    startLine: z.number().int().min(1).optional(),
    numLines: z.number().int().positive().optional(),
    totalLines: z.number().int().positive().optional(),
  }).partial().optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const WriteInputV2Schema = BaseEnvelopeSchema.extend({
  file_path: FilePathSchema.optional(),
  content: z.string().optional(),
}).passthrough();

export const WriteResultV2Schema = BaseEnvelopeSchema.extend({
  ok: z.boolean().optional(),
  applied: z.boolean().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const EditInputV2Schema = BaseEnvelopeSchema.extend({
  file_path: FilePathSchema.optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  // Some providers emit full-file writes via Edit; preserve as optional canonical alias.
  file_content: z.string().optional(),
}).passthrough();

export const MultiEditInputV2Schema = BaseEnvelopeSchema.extend({
  file_path: FilePathSchema.optional(),
  edits: z.array(z.object({
    oldText: z.string().optional(),
    newText: z.string().optional(),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export const EditResultV2Schema = BaseEnvelopeSchema.extend({
  ok: z.boolean().optional(),
  applied: z.boolean().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const DeleteInputV2Schema = BaseEnvelopeSchema.extend({
  file_path: FilePathSchema.optional(),
  file_paths: z.array(FilePathSchema).optional(),
}).passthrough();

export const DeleteResultV2Schema = BaseEnvelopeSchema.extend({
  ok: z.boolean().optional(),
  applied: z.boolean().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const DiffInputV2Schema = BaseEnvelopeSchema.extend({
  unified_diff: z.string().optional(),
  files: z.array(
    z
      .object({
        file_path: FilePathSchema.optional(),
        // Preferred representation: per-file unified diff block.
        unified_diff: z.string().min(1).optional(),
        // Alternate representation (no unified diff available): provide old/new text directly.
        oldText: z.string().optional(),
        newText: z.string().optional(),
        old_text: z.string().optional(),
        new_text: z.string().optional(),
      })
      .passthrough()
      .refine(
        (value) => {
          const hasUnified = typeof value.unified_diff === 'string' && value.unified_diff.trim().length > 0;
          const hasCamel =
            typeof value.oldText === 'string' &&
            typeof value.newText === 'string' &&
            (value.oldText.length > 0 || value.newText.length > 0);
          const hasSnake =
            typeof value.old_text === 'string' &&
            typeof value.new_text === 'string' &&
            (value.old_text.length > 0 || value.new_text.length > 0);
          return hasUnified || hasCamel || hasSnake;
        },
        { message: 'Diff.files entries must include unified_diff or old/new text pairs' },
      ),
  ).optional(),
}).passthrough();

export const PatchInputV2Schema = BaseEnvelopeSchema.extend({
  changes: z.record(z.string(), z.unknown()).optional(),
  file_paths: z.array(FilePathSchema).optional(),
}).passthrough();

export const PatchResultV2Schema = BaseEnvelopeSchema.extend({
  applied: z.boolean().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const GlobInputV2Schema = BaseEnvelopeSchema.extend({
  pattern: z.string().optional(),
}).passthrough();
export const GrepInputV2Schema = BaseEnvelopeSchema.extend({
  pattern: z.string().optional(),
  query: z.string().optional(),
}).passthrough();
export const LSInputV2Schema = BaseEnvelopeSchema.extend({
  path: FilePathSchema.optional(),
}).passthrough();
export const CodeSearchInputV2Schema = BaseEnvelopeSchema.extend({
  query: z.string().optional(),
  pattern: z.string().optional(),
  text: z.string().optional(),
}).passthrough();

export const SearchResultV2Schema = BaseEnvelopeSchema.extend({
  items: z.array(z.unknown()).optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const WebFetchInputV2Schema = BaseEnvelopeSchema.extend({
  url: UrlSchema.optional(),
}).passthrough();

export const WebSearchInputV2Schema = BaseEnvelopeSchema.extend({
  query: z.string().optional(),
}).passthrough();

export const WebResultV2Schema = BaseEnvelopeSchema.extend({
  content: z.unknown().optional(),
  text: z.string().optional(),
  items: z.array(z.unknown()).optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const TodoWriteInputV2Schema = BaseEnvelopeSchema.extend({
  todos: z.array(z.object({
    id: z.string().optional(),
    content: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']).optional(),
    priority: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export const TodoReadInputV2Schema = BaseEnvelopeSchema.extend({}).passthrough();

export const TodoResultV2Schema = BaseEnvelopeSchema.extend({
  todos: z.array(z.object({
    id: z.string().optional(),
    content: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']).optional(),
    priority: z.string().optional(),
  }).passthrough()).optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const TaskInputV2Schema = BaseEnvelopeSchema.extend({
  operation: z.enum(['run', 'create', 'list', 'update', 'unknown']).optional(),
  // Many providers supply human-facing labels; keep these optional but typed so renderers
  // can safely access them.
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  progress: z.number().optional(),
}).passthrough();

export const TaskResultV2Schema = BaseEnvelopeSchema.extend({
  content: z.string().optional(),
  status: z.string().optional(),
  progress: z.number().optional(),
  tasks: z.array(z.unknown()).optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const SubAgentInputV2Schema = TaskInputV2Schema;
export const SubAgentResultV2Schema = TaskResultV2Schema;

/**
 * Background-task control tools.
 *
 * Field sets are taken from the Claude Agent SDK's generated tool schemas
 * (`TaskOutputInput`, `TaskStopInput`, `TaskStopOutput`) and nothing is added beyond them. The SDK
 * publishes **no** `TaskOutputOutput` in its `ToolOutputSchemas` union, and the Happier Claude
 * launcher additionally blanks `TaskOutput` tool-result content to keep the transcript compact, so
 * the result envelope stays deliberately open rather than claiming a shape.
 */
export const TaskOutputInputV2Schema = BaseEnvelopeSchema.extend({
  task_id: z.string().optional(),
  block: z.boolean().optional(),
  timeout: z.number().optional(),
}).passthrough();

export const TaskOutputResultV2Schema = BaseEnvelopeSchema.extend({
  errorMessage: z.string().optional(),
}).passthrough();

export const TaskStopInputV2Schema = BaseEnvelopeSchema.extend({
  task_id: z.string().optional(),
  // Deprecated by the SDK in favour of `task_id`; still accepted on the wire.
  shell_id: z.string().optional(),
}).passthrough();

export const TaskStopResultV2Schema = BaseEnvelopeSchema.extend({
  message: z.string().optional(),
  task_id: z.string().optional(),
  task_type: z.string().optional(),
  command: z.string().optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const ReasoningInputV2Schema = BaseEnvelopeSchema.extend({
  text: z.string().optional(),
}).passthrough();

export const ReasoningResultV2Schema = BaseEnvelopeSchema.extend({
  text: z.string().optional(),
}).passthrough();

export const EnterPlanModeInputV2Schema = BaseEnvelopeSchema.extend({}).passthrough();

export const ExitPlanModeInputV2Schema = BaseEnvelopeSchema.extend({
  plan: z.string().optional(),
}).passthrough();

export const AskUserQuestionInputV2Schema = BaseEnvelopeSchema.extend({
  questions: z.array(z.object({
    header: z.string(),
    question: z.string(),
    multiSelect: z.boolean(),
    options: z.array(z.object({
      label: z.string(),
      value: z.string().optional(),
      choice: z.string().optional(),
      description: z.string().optional(),
    }).passthrough()),
  }).passthrough()).optional(),
}).passthrough();

export const AskUserQuestionResultV2Schema = BaseEnvelopeSchema.extend({
  structuredAnswersV1: StructuredQuestionAnswersV1Schema.optional(),
  answers: z.record(z.string(), z.string()).optional(),
}).passthrough();

export const SubAgentRunInputV2Schema = BaseEnvelopeSchema.extend({
  intent: z.string().optional(),
  backendId: z.string().optional(),
  label: z.string().optional(),
  policy: z.unknown().optional(),
}).passthrough();

export const SubAgentRunResultV2Schema = BaseEnvelopeSchema.extend({
  status: z.string().optional(),
  summary: z.string().optional(),
  runId: z.string().optional(),
  callId: z.string().optional(),
  sidechainId: z.string().optional(),
  backendId: z.string().optional(),
  intent: z.string().optional(),
  startedAtMs: z.number().int().nonnegative().optional(),
  finishedAtMs: z.number().int().nonnegative().optional(),
  findingsDigest: z.object({
    total: z.number().int().nonnegative(),
    items: z.array(z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      severity: z.string().min(1),
      category: z.string().min(1),
      filePath: z.string().min(1).optional(),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }).passthrough()),
  }).passthrough().optional(),
  triage: z.object({
    findings: z.array(z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      comment: z.string().min(1).optional(),
    }).passthrough()),
  }).passthrough().optional(),
  limits: z.object({
    findingsTruncated: z.boolean().optional(),
    patchesTruncated: z.boolean().optional(),
  }).passthrough().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const AgentTeamToolUseResultV2Schema = z.object({
  status: z.string().optional(),
  team_name: z.string().optional(),
  teamName: z.string().optional(),
  lead_agent_id: z.string().optional(),
  leadAgentId: z.string().optional(),
  agent_id: z.string().optional(),
  teammate_id: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  content: z.string().optional(),
}).passthrough();

export const AgentTeamCreateInputV2Schema = BaseEnvelopeSchema.extend({
  team_name: z.string().optional(),
  teamName: z.string().optional(),
  description: z.string().optional(),
  lead_agent_id: z.string().optional(),
  leadAgentId: z.string().optional(),
}).passthrough();

export const AgentTeamCreateResultV2Schema = BaseEnvelopeSchema.extend({
  status: z.string().optional(),
  team_name: z.string().optional(),
  teamName: z.string().optional(),
  description: z.string().optional(),
  lead_agent_id: z.string().optional(),
  leadAgentId: z.string().optional(),
  tool_use_result: AgentTeamToolUseResultV2Schema.optional(),
}).passthrough();

export const AgentTeamDeleteInputV2Schema = BaseEnvelopeSchema.extend({
  team_name: z.string().optional(),
  teamName: z.string().optional(),
}).passthrough();

export const AgentTeamDeleteResultV2Schema = BaseEnvelopeSchema.extend({
  status: z.string().optional(),
  team_name: z.string().optional(),
  teamName: z.string().optional(),
  tool_use_result: AgentTeamToolUseResultV2Schema.optional(),
}).passthrough();

export const AgentTeamSendMessageInputV2Schema = BaseEnvelopeSchema.extend({
  team_name: z.string().optional(),
  teamName: z.string().optional(),
  type: z.string().optional(),
  content: z.string().optional(),
  message: z.string().optional(),
  agent_id: z.string().optional(),
  teammate_id: z.string().optional(),
  name: z.string().optional(),
}).passthrough();

export const AgentTeamSendMessageResultV2Schema = BaseEnvelopeSchema.extend({
  status: z.string().optional(),
  team_name: z.string().optional(),
  teamName: z.string().optional(),
  type: z.string().optional(),
  content: z.string().optional(),
  tool_use_result: AgentTeamToolUseResultV2Schema.optional(),
}).passthrough();

export const AcpHistoryImportInputV2Schema = BaseEnvelopeSchema.extend({
  provider: z.string().optional(),
  remoteSessionId: z.string().optional(),
  localCount: z.number().int().min(0).optional(),
  remoteCount: z.number().int().min(0).optional(),
  note: z.string().optional(),
  localTail: z.array(z.object({
    role: z.string().optional(),
    text: z.string().optional(),
  }).passthrough()).optional(),
  remoteTail: z.array(z.object({
    role: z.string().optional(),
    text: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export const WorkspaceIndexingPermissionInputV2Schema = BaseEnvelopeSchema.extend({
  title: z.string().optional(),
  options: z.unknown().optional(),
  toolCall: z.unknown().optional(),
}).passthrough();

// Dynamic Workflow run. The provider-native input carries a workflow `script`; the result
// carries the canonical tool-use/task ids used to join the transcript card to the durable
// `activity/workflow_run.v1` snapshot. Kept permissive/passthrough — the workflow detail is
// normalized into provider-agnostic activity records, not parsed from this envelope by UI.
export const WorkflowInputV2Schema = BaseEnvelopeSchema.extend({
  script: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

export const WorkflowResultV2Schema = BaseEnvelopeSchema.extend({
  task_id: z.string().optional(),
  tool_use_id: z.string().optional(),
  run_id: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
}).passthrough();

export const ChangeTitleInputV2Schema = BaseEnvelopeSchema.extend({
  title: z.string().optional(),
}).passthrough();

export const ChangeTitleResultV2Schema = BaseEnvelopeSchema.extend({
  title: z.string().optional(),
}).passthrough();

const TOOL_INPUT_SCHEMAS: Record<KnownCanonicalToolNameV2, z.ZodTypeAny> = {
  Bash: BashInputV2Schema,
  Read: ReadInputV2Schema,
  Write: WriteInputV2Schema,
  Edit: EditInputV2Schema,
  MultiEdit: MultiEditInputV2Schema,
  Delete: DeleteInputV2Schema,
  Patch: PatchInputV2Schema,
  Diff: DiffInputV2Schema,
  Glob: GlobInputV2Schema,
  Grep: GrepInputV2Schema,
  LS: LSInputV2Schema,
  CodeSearch: CodeSearchInputV2Schema,
  WebFetch: WebFetchInputV2Schema,
  WebSearch: WebSearchInputV2Schema,
  TodoWrite: TodoWriteInputV2Schema,
  TodoRead: TodoReadInputV2Schema,
  SubAgent: SubAgentInputV2Schema,
  Task: TaskInputV2Schema,
  TaskOutput: TaskOutputInputV2Schema,
  TaskStop: TaskStopInputV2Schema,
  Workflow: WorkflowInputV2Schema,
  Reasoning: ReasoningInputV2Schema,
  EnterPlanMode: EnterPlanModeInputV2Schema,
  ExitPlanMode: ExitPlanModeInputV2Schema,
  AskUserQuestion: AskUserQuestionInputV2Schema,
  AcpHistoryImport: AcpHistoryImportInputV2Schema,
  WorkspaceIndexingPermission: WorkspaceIndexingPermissionInputV2Schema,
  change_title: ChangeTitleInputV2Schema,
  SubAgentRun: SubAgentRunInputV2Schema,
  AgentTeamCreate: AgentTeamCreateInputV2Schema,
  AgentTeamDelete: AgentTeamDeleteInputV2Schema,
  AgentTeamSendMessage: AgentTeamSendMessageInputV2Schema,
};

const TOOL_RESULT_SCHEMAS: Record<KnownCanonicalToolNameV2, z.ZodTypeAny> = {
  Bash: BashResultV2Schema,
  Read: ReadResultV2Schema,
  Write: WriteResultV2Schema,
  Edit: EditResultV2Schema,
  MultiEdit: EditResultV2Schema,
  Delete: DeleteResultV2Schema,
  Patch: PatchResultV2Schema,
  Diff: BaseEnvelopeSchema.passthrough(),
  Glob: SearchResultV2Schema,
  Grep: SearchResultV2Schema,
  LS: SearchResultV2Schema,
  CodeSearch: SearchResultV2Schema,
  WebFetch: WebResultV2Schema,
  WebSearch: WebResultV2Schema,
  TodoWrite: TodoResultV2Schema,
  TodoRead: TodoResultV2Schema,
  SubAgent: SubAgentResultV2Schema,
  Task: TaskResultV2Schema,
  TaskOutput: TaskOutputResultV2Schema,
  TaskStop: TaskStopResultV2Schema,
  Workflow: WorkflowResultV2Schema,
  Reasoning: ReasoningResultV2Schema,
  EnterPlanMode: BaseEnvelopeSchema.passthrough(),
  ExitPlanMode: BaseEnvelopeSchema.passthrough(),
  AskUserQuestion: AskUserQuestionResultV2Schema,
  AcpHistoryImport: BaseEnvelopeSchema.passthrough(),
  WorkspaceIndexingPermission: BaseEnvelopeSchema.passthrough(),
  change_title: ChangeTitleResultV2Schema,
  SubAgentRun: SubAgentRunResultV2Schema,
  AgentTeamCreate: AgentTeamCreateResultV2Schema,
  AgentTeamDelete: AgentTeamDeleteResultV2Schema,
  AgentTeamSendMessage: AgentTeamSendMessageResultV2Schema,
};

export function getToolInputSchemaV2(toolName: KnownCanonicalToolNameV2): z.ZodTypeAny {
  return TOOL_INPUT_SCHEMAS[toolName];
}

export function getToolResultSchemaV2(toolName: KnownCanonicalToolNameV2): z.ZodTypeAny {
  return TOOL_RESULT_SCHEMAS[toolName];
}
