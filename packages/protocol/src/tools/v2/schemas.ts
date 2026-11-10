import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import type { KnownCanonicalToolNameV2 } from './names.js';
import { ToolHappyMetaV2Schema, ToolHappierMetaSchema } from './meta.js';
import { StructuredQuestionAnswerDetailsV1Schema, StructuredQuestionAnswersV1Schema } from '../structuredQuestionAnswersV1.js';

const BaseEnvelopeSchema = lazyZodSchema(() => z.looseObject({
  _happier: z.optional(ToolHappierMetaSchema),
  // Legacy envelope key accepted for migration back-compat.
  _happy: z.optional(ToolHappyMetaV2Schema),
  _raw: z.optional(z.unknown()),
}));

// Common primitives (shared between many tools).
const FilePathSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
const UrlSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));

export const BashInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  command: z.optional(z.string().check(z.minLength(1))),
  timeout: z.optional(z.number().check(z.int(), z.positive())),
  // A *request* to detach the command. Only the result's `backgroundTaskId` attests that the
  // provider actually detached it, so renderers must not treat this flag as proof.
  run_in_background: z.optional(z.boolean()),
})));

export const BashResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  exit_code: z.optional(z.number().check(z.int())),
  errorMessage: z.optional(z.string()),
  // Present only when the provider detached the command. This is the join key between the `Bash`
  // tool result and the background-task ledger/record that tracks the detached process.
  backgroundTaskId: z.optional(z.string()),
})));

export const ReadInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  file_path: z.optional(FilePathSchema),
  limit: z.optional(z.number().check(z.int(), z.positive())),
  offset: z.optional(z.number().check(z.int(), z.minimum(0))),
})));

export const ReadResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  file: z.optional(z.partial(z.object({
    content: z.string(),
    filePath: z.optional(FilePathSchema),
    startLine: z.optional(z.number().check(z.int(), z.minimum(1))),
    numLines: z.optional(z.number().check(z.int(), z.positive())),
    totalLines: z.optional(z.number().check(z.int(), z.positive())),
  }))),
  errorMessage: z.optional(z.string()),
})));

export const WriteInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  file_path: z.optional(FilePathSchema),
  content: z.optional(z.string()),
})));

export const WriteResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  ok: z.optional(z.boolean()),
  applied: z.optional(z.boolean()),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  errorMessage: z.optional(z.string()),
})));

export const EditInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  file_path: z.optional(FilePathSchema),
  old_string: z.optional(z.string()),
  new_string: z.optional(z.string()),
  // Some providers emit full-file writes via Edit; preserve as optional canonical alias.
  file_content: z.optional(z.string()),
})));

export const MultiEditInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  file_path: z.optional(FilePathSchema),
  edits: z.optional(z.array(z.looseObject({
    oldText: z.optional(z.string()),
    newText: z.optional(z.string()),
    old_string: z.optional(z.string()),
    new_string: z.optional(z.string()),
  }))),
})));

export const EditResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  ok: z.optional(z.boolean()),
  applied: z.optional(z.boolean()),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  errorMessage: z.optional(z.string()),
})));

export const DeleteInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  file_path: z.optional(FilePathSchema),
  file_paths: z.optional(z.array(FilePathSchema)),
})));

export const DeleteResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  ok: z.optional(z.boolean()),
  applied: z.optional(z.boolean()),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  errorMessage: z.optional(z.string()),
})));

export const DiffInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  unified_diff: z.optional(z.string()),
  files: z.optional(z.array(
    z.looseObject({
        file_path: z.optional(FilePathSchema),
        // Preferred representation: per-file unified diff block.
        unified_diff: z.optional(z.string().check(z.minLength(1))),
        // Alternate representation (no unified diff available): provide old/new text directly.
        oldText: z.optional(z.string()),
        newText: z.optional(z.string()),
        old_text: z.optional(z.string()),
        new_text: z.optional(z.string()),
      }).check(z.refine((value) => {
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
        }, { message: 'Diff.files entries must include unified_diff or old/new text pairs' })),
  )),
})));

export const PatchInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  changes: z.optional(z.record(z.string(), z.unknown())),
  file_paths: z.optional(z.array(FilePathSchema)),
})));

export const PatchResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  applied: z.optional(z.boolean()),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  errorMessage: z.optional(z.string()),
})));

export const GlobInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  pattern: z.optional(z.string()),
})));
export const GrepInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  pattern: z.optional(z.string()),
  query: z.optional(z.string()),
})));
export const LSInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  path: z.optional(FilePathSchema),
})));
export const CodeSearchInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  query: z.optional(z.string()),
  pattern: z.optional(z.string()),
  text: z.optional(z.string()),
})));

export const SearchResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  items: z.optional(z.array(z.unknown())),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  errorMessage: z.optional(z.string()),
})));

export const WebFetchInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  url: z.optional(UrlSchema),
})));

export const WebSearchInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  query: z.optional(z.string()),
})));

export const WebResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  content: z.optional(z.unknown()),
  text: z.optional(z.string()),
  items: z.optional(z.array(z.unknown())),
  errorMessage: z.optional(z.string()),
})));

export const TodoWriteInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  todos: z.optional(z.array(z.looseObject({
    id: z.optional(z.string()),
    content: z.string().check(z.minLength(1)),
    status: z.optional(z.enum(['pending', 'in_progress', 'completed'])),
    priority: z.optional(z.string()),
  }))),
})));

export const TodoReadInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {})));

export const TodoResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  todos: z.optional(z.array(z.looseObject({
    id: z.optional(z.string()),
    content: z.string().check(z.minLength(1)),
    status: z.optional(z.enum(['pending', 'in_progress', 'completed'])),
    priority: z.optional(z.string()),
  }))),
  errorMessage: z.optional(z.string()),
})));

export const TaskInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  operation: z.optional(z.enum(['run', 'create', 'list', 'update', 'unknown'])),
  // Many providers supply human-facing labels; keep these optional but typed so renderers
  // can safely access them.
  title: z.optional(z.string()),
  description: z.optional(z.string()),
  status: z.optional(z.string()),
  progress: z.optional(z.number()),
})));

export const TaskResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  content: z.optional(z.string()),
  status: z.optional(z.string()),
  progress: z.optional(z.number()),
  tasks: z.optional(z.array(z.unknown())),
  errorMessage: z.optional(z.string()),
})));

export const SubAgentInputV2Schema = TaskInputV2Schema;
export const SubAgentResultV2Schema = TaskResultV2Schema;

/**
 * Background-task control tools.
 *
 * Field sets are taken from the Claude Agent SDK's generated tool schemas (`TaskOutputInput`,
 * `TaskStopInput`, `TaskStopOutput`) and nothing is added beyond them. The SDK publishes **no**
 * `TaskOutputOutput` in its `ToolOutputSchemas` union, and the Claude launcher additionally blanks
 * `TaskOutput` tool-result content to keep the transcript compact, so the result envelope stays
 * deliberately open rather than claiming a shape.
 */
export const TaskOutputInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  task_id: z.optional(z.string()),
  block: z.optional(z.boolean()),
  timeout: z.optional(z.number()),
})));

export const TaskOutputResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  errorMessage: z.optional(z.string()),
})));

export const TaskStopInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  task_id: z.optional(z.string()),
  // Deprecated by the SDK in favour of `task_id`; still accepted on the wire.
  shell_id: z.optional(z.string()),
})));

export const TaskStopResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  message: z.optional(z.string()),
  task_id: z.optional(z.string()),
  task_type: z.optional(z.string()),
  command: z.optional(z.string()),
  errorMessage: z.optional(z.string()),
})));

// Dynamic Workflow run. The provider-native input carries a workflow `script`; the result
// carries the canonical tool-use/task ids used to join the transcript card to the durable
// `activity/workflow_run.v1` snapshot. Kept permissive/passthrough — the workflow detail is
// normalized into provider-agnostic activity records, not parsed from this envelope by UI.
export const WorkflowInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  script: z.optional(z.string()),
  name: z.optional(z.string()),
  title: z.optional(z.string()),
  description: z.optional(z.string()),
})));

export const WorkflowResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  task_id: z.optional(z.string()),
  tool_use_id: z.optional(z.string()),
  run_id: z.optional(z.string()),
  status: z.optional(z.string()),
  summary: z.optional(z.string()),
})));

export const ReasoningInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  text: z.optional(z.string()),
})));

export const ReasoningResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  text: z.optional(z.string()),
})));

export const EnterPlanModeInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {})));

export const ExitPlanModeInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  plan: z.optional(z.string()),
})));

export const AskUserQuestionInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  questions: z.optional(z.array(z.looseObject({
    header: z.string(),
    question: z.string(),
    multiSelect: z.boolean(),
    options: z.array(z.looseObject({
      label: z.string(),
      description: z.optional(z.string()),
    })),
  }))),
})));

export const AskUserQuestionResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  answerDetails: z.optional(StructuredQuestionAnswerDetailsV1Schema),
  answers: z.optional(z.union([
    StructuredQuestionAnswersV1Schema,
    z.record(z.string(), z.string()),
  ])),
})));

export const SubAgentRunInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  intent: z.optional(z.string()),
  backendId: z.optional(z.string()),
  label: z.optional(z.string()),
  policy: z.optional(z.unknown()),
})));

export const SubAgentRunResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  status: z.optional(z.string()),
  summary: z.optional(z.string()),
  runId: z.optional(z.string()),
  callId: z.optional(z.string()),
  sidechainId: z.optional(z.string()),
  backendId: z.optional(z.string()),
  intent: z.optional(z.string()),
  startedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  finishedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  findingsDigest: z.optional(z.looseObject({
    total: z.number().check(z.int(), z.nonnegative()),
    items: z.array(z.looseObject({
      id: z.string().check(z.minLength(1)),
      title: z.string().check(z.minLength(1)),
      severity: z.string().check(z.minLength(1)),
      category: z.string().check(z.minLength(1)),
      filePath: z.optional(z.string().check(z.minLength(1))),
      startLine: z.optional(z.number().check(z.int(), z.minimum(1))),
      endLine: z.optional(z.number().check(z.int(), z.minimum(1))),
    })),
  })),
  triage: z.optional(z.looseObject({
    findings: z.array(z.looseObject({
      id: z.string().check(z.minLength(1)),
      status: z.string().check(z.minLength(1)),
      comment: z.optional(z.string().check(z.minLength(1))),
    })),
  })),
  limits: z.optional(z.looseObject({
    findingsTruncated: z.optional(z.boolean()),
    patchesTruncated: z.optional(z.boolean()),
  })),
  error: z.optional(z.looseObject({
    code: z.string().check(z.minLength(1)),
    message: z.optional(z.string()),
  })),
})));

const AgentTeamToolUseResultV2Schema = lazyZodSchema(() => z.looseObject({
  status: z.optional(z.string()),
  team_name: z.optional(z.string()),
  teamName: z.optional(z.string()),
  lead_agent_id: z.optional(z.string()),
  leadAgentId: z.optional(z.string()),
  agent_id: z.optional(z.string()),
  teammate_id: z.optional(z.string()),
  name: z.optional(z.string()),
  type: z.optional(z.string()),
  content: z.optional(z.string()),
}));

export const AgentTeamCreateInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  team_name: z.optional(z.string()),
  teamName: z.optional(z.string()),
  description: z.optional(z.string()),
  lead_agent_id: z.optional(z.string()),
  leadAgentId: z.optional(z.string()),
})));

export const AgentTeamCreateResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  status: z.optional(z.string()),
  team_name: z.optional(z.string()),
  teamName: z.optional(z.string()),
  description: z.optional(z.string()),
  lead_agent_id: z.optional(z.string()),
  leadAgentId: z.optional(z.string()),
  tool_use_result: z.optional(AgentTeamToolUseResultV2Schema),
})));

export const AgentTeamDeleteInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  team_name: z.optional(z.string()),
  teamName: z.optional(z.string()),
})));

export const AgentTeamDeleteResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  status: z.optional(z.string()),
  team_name: z.optional(z.string()),
  teamName: z.optional(z.string()),
  tool_use_result: z.optional(AgentTeamToolUseResultV2Schema),
})));

export const AgentTeamSendMessageInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  team_name: z.optional(z.string()),
  teamName: z.optional(z.string()),
  type: z.optional(z.string()),
  content: z.optional(z.string()),
  message: z.optional(z.string()),
  agent_id: z.optional(z.string()),
  teammate_id: z.optional(z.string()),
  name: z.optional(z.string()),
})));

export const AgentTeamSendMessageResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  status: z.optional(z.string()),
  team_name: z.optional(z.string()),
  teamName: z.optional(z.string()),
  type: z.optional(z.string()),
  content: z.optional(z.string()),
  tool_use_result: z.optional(AgentTeamToolUseResultV2Schema),
})));

export const AcpHistoryImportInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  provider: z.optional(z.string()),
  remoteSessionId: z.optional(z.string()),
  localCount: z.optional(z.number().check(z.int(), z.minimum(0))),
  remoteCount: z.optional(z.number().check(z.int(), z.minimum(0))),
  note: z.optional(z.string()),
  localTail: z.optional(z.array(z.looseObject({
    role: z.optional(z.string()),
    text: z.optional(z.string()),
  }))),
  remoteTail: z.optional(z.array(z.looseObject({
    role: z.optional(z.string()),
    text: z.optional(z.string()),
  }))),
})));

export const WorkspaceIndexingPermissionInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  title: z.optional(z.string()),
  options: z.optional(z.unknown()),
  toolCall: z.optional(z.unknown()),
})));

export const ChangeTitleInputV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  title: z.optional(z.string()),
})));

export const ChangeTitleResultV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseEnvelopeSchema, {
  title: z.optional(z.string()),
})));

const TOOL_INPUT_SCHEMAS: Record<KnownCanonicalToolNameV2, z.ZodMiniType> = {
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

const TOOL_RESULT_SCHEMAS: Record<KnownCanonicalToolNameV2, z.ZodMiniType> = {
  Bash: BashResultV2Schema,
  Read: ReadResultV2Schema,
  Write: WriteResultV2Schema,
  Edit: EditResultV2Schema,
  MultiEdit: EditResultV2Schema,
  Delete: DeleteResultV2Schema,
  Patch: PatchResultV2Schema,
  Diff: lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(BaseEnvelopeSchema)),
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
  EnterPlanMode: lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(BaseEnvelopeSchema)),
  ExitPlanMode: lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(BaseEnvelopeSchema)),
  AskUserQuestion: AskUserQuestionResultV2Schema,
  AcpHistoryImport: lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(BaseEnvelopeSchema)),
  WorkspaceIndexingPermission: lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(BaseEnvelopeSchema)),
  change_title: ChangeTitleResultV2Schema,
  SubAgentRun: SubAgentRunResultV2Schema,
  AgentTeamCreate: AgentTeamCreateResultV2Schema,
  AgentTeamDelete: AgentTeamDeleteResultV2Schema,
  AgentTeamSendMessage: AgentTeamSendMessageResultV2Schema,
};

export function getToolInputSchemaV2(toolName: KnownCanonicalToolNameV2): z.ZodMiniType {
  return TOOL_INPUT_SCHEMAS[toolName];
}

export function getToolResultSchemaV2(toolName: KnownCanonicalToolNameV2): z.ZodMiniType {
  return TOOL_RESULT_SCHEMAS[toolName];
}
