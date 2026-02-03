import { z } from 'zod';
import type { KnownCanonicalToolNameV2 } from './names.js';
import { ToolHappierMetaV2Schema } from './meta.js';

const BaseEnvelopeSchema = z.object({
  _happy: ToolHappierMetaV2Schema.optional(),
  _raw: z.unknown().optional(),
}).passthrough();

// Common primitives (shared between many tools).
const FilePathSchema = z.string().min(1);
const UrlSchema = z.string().min(1);

export const BashInputV2Schema = BaseEnvelopeSchema.extend({
  command: z.string().min(1).optional(),
  timeout: z.number().int().positive().optional(),
}).passthrough();

export const BashResultV2Schema = BaseEnvelopeSchema.extend({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exit_code: z.number().int().optional(),
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
}).passthrough();

export const PatchInputV2Schema = BaseEnvelopeSchema.extend({
  changes: z.record(z.unknown()).optional(),
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
      description: z.string().optional(),
    }).passthrough()),
  }).passthrough()).optional(),
}).passthrough();

export const AskUserQuestionResultV2Schema = BaseEnvelopeSchema.extend({
  answers: z.record(z.string()).optional(),
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
  Task: TaskInputV2Schema,
  Reasoning: ReasoningInputV2Schema,
  EnterPlanMode: EnterPlanModeInputV2Schema,
  ExitPlanMode: ExitPlanModeInputV2Schema,
  AskUserQuestion: AskUserQuestionInputV2Schema,
  AcpHistoryImport: AcpHistoryImportInputV2Schema,
  WorkspaceIndexingPermission: WorkspaceIndexingPermissionInputV2Schema,
  change_title: ChangeTitleInputV2Schema,
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
  Task: TaskResultV2Schema,
  Reasoning: ReasoningResultV2Schema,
  EnterPlanMode: BaseEnvelopeSchema.passthrough(),
  ExitPlanMode: BaseEnvelopeSchema.passthrough(),
  AskUserQuestion: AskUserQuestionResultV2Schema,
  AcpHistoryImport: BaseEnvelopeSchema.passthrough(),
  WorkspaceIndexingPermission: BaseEnvelopeSchema.passthrough(),
  change_title: ChangeTitleResultV2Schema,
};

export function getToolInputSchemaV2(toolName: KnownCanonicalToolNameV2): z.ZodTypeAny {
  return TOOL_INPUT_SCHEMAS[toolName];
}

export function getToolResultSchemaV2(toolName: KnownCanonicalToolNameV2): z.ZodTypeAny {
  return TOOL_RESULT_SCHEMAS[toolName];
}
