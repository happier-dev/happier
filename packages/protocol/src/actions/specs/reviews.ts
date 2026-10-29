import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ReviewFindingsApplyInputV1Schema, ReviewFindingsApplyResultV1Schema } from '../../reviews/reviewApplyV1.js';
import { reviewStartCompletion, reviewWalkthroughCompletion } from './executionRunCompletion.js';
import { ReviewStartInputSchema } from '../../reviews/reviewStart.js';
import { ReviewWalkthroughInputSchema, ReviewExplainFindingsInputSchema } from '../../reviews/reviewNarration.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import type { PreNormalizedActionSpec } from './definition.js';


export const REVIEW_ACTION_SPECS = Object.freeze([
  {
    id: 'review.start', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    title: 'Start review',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/review', '/h.review'] },
    bindings: { voiceClientToolName: 'startReview', mcpToolName: 'review_start' },
    inputHints: {
      title: 'Start a code review',
      description: 'Start one or more parallel review runs against the current worktree.',
      fields: [
        {
          path: 'engineIds',
          title: 'Review engines',
          description: 'Select one or more engines. Each engine runs as its own execution run.',
          widget: 'multiselect',
          required: true,
          requireExplicitSelection: true,
          optionsSourceId: 'review.engines.available',
        },
        {
          path: 'outputs', title: 'Also write a walkthrough', widget: 'multiselect',
          options: [{ value: 'walkthrough', label: 'Walkthrough' }],
        },
        {
          path: 'comparisonId', title: 'Captured comparison', widget: 'text',
          description: 'Saved exact comparison identity required when requesting a walkthrough.',
        },
        {
          path: 'narrator.engineId', title: 'Narrator', widget: 'select',
          description: 'Optional explicit capable engine; defaults to the first selected capable reviewer.',
          optionsSourceId: 'review.engines.available',
        },
        { path: 'narrator.modelId', title: 'Narrator model', widget: 'text' },
        {
          path: 'instructions',
          title: 'Instructions',
          description: 'What you want the reviewers to focus on.',
          widget: 'textarea',
          required: true,
        },
        {
          path: 'teamCredentialModel',
          title: 'Team credential model (json)',
          description: 'Optional exact Team credential resource/model selection from the recipient-safe Team catalog. Requires one review engine.',
          widget: 'json',
          optionsSourceId: 'teams.credential_models.available',
        },
        {
          path: 'secretReferenceOverlay',
          title: 'Saved Secret overrides (json)',
          description: 'Optional value-free Saved Secret references for this launch only. Values are resolved by the exact daemon and the selected Profile is not changed.',
          widget: 'json',
        },
        {
          path: 'changeType',
          title: 'Change type',
          description: 'Which changes to review.',
          widget: 'select',
          required: true,
          options: [
            { value: 'committed', label: 'Committed' },
            { value: 'uncommitted', label: 'Uncommitted' },
            { value: 'all', label: 'All' },
          ],
        },
        {
          path: 'base.kind',
          title: 'Base selection',
          description: 'How to define the review base for engines that need it.',
          widget: 'select',
          required: true,
          options: [
            { value: 'none', label: 'None' },
            { value: 'branch', label: 'Base branch' },
            { value: 'commit', label: 'Base commit' },
          ],
        },
        {
          path: 'base.baseBranch',
          title: 'Base branch',
          description: 'Branch name to diff against (when base.kind=branch).',
          widget: 'text',
          visibleWhen: { op: 'eq', path: 'base.kind', value: 'branch' },
          requiredWhen: { op: 'eq', path: 'base.kind', value: 'branch' },
        },
        {
          path: 'base.baseCommit',
          title: 'Base commit',
          description: 'Commit SHA to diff against (when base.kind=commit).',
          widget: 'text',
          visibleWhen: { op: 'eq', path: 'base.kind', value: 'commit' },
          requiredWhen: { op: 'eq', path: 'base.kind', value: 'commit' },
        },
      ],
    },
    examples: {
      voice: { argsExample: '{"engineIds":["codex"],"instructions":"Review this.","changeType":"uncommitted","base":{"kind":"none"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ReviewStartInputSchema,
    completion: reviewStartCompletion,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'review.apply', executionPlacement: 'session', approval: { result: 'optional', flow: 'deferred' },
    title: 'Apply accepted review findings',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    bindings: { mcpToolName: 'review_apply', voiceClientToolName: 'review_apply' },
    inputHints: { title: 'Apply accepted review findings', fields: [
      { path: 'sessionId', title: 'Session', widget: 'select', required: true, optionsSourceId: 'sessions' },
      { path: 'reviews', title: 'Reviewed findings', widget: 'json', required: true,
        description: 'Review Run identities and selected findings. Current acceptance and revisions are rechecked before sending.' },
    ] },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: ReviewFindingsApplyInputV1Schema,
    outputSchema: ReviewFindingsApplyResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'review.walkthrough', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    title: 'Walk through review',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['session_action_menu', 'command_palette', 'voice_panel'],
    bindings: { voiceClientToolName: 'reviewWalkthrough', mcpToolName: 'review_walkthrough' },
    cli: { commands: [{ path: ['review', 'walkthrough'], visibility: 'canonical' }] },
    examples: { voice: { argsExample: '{"runId":"review-1","comparisonId":"comparison-1"}' } },
    inputHints: { description: 'Have an agent walk you through a finished review, change by change.', fields: [
      { path: 'target.kind', title: 'Detached target', widget: 'select', options: [{ value: 'detached', label: 'Machine workspace (no Session)' }] },
      { path: 'runId', title: 'Reviewer Run', widget: 'text', required: true },
      { path: 'reviewRunIds', title: 'Reviewer Runs', widget: 'text_list', listSeparator: 'comma' },
      { path: 'comparisonId', title: 'Captured comparison', widget: 'text', required: true },
      { path: 'narrator.engineId', title: 'Narrator', widget: 'select', optionsSourceId: 'review.engines.available' },
      { path: 'narrator.modelId', title: 'Narrator model', widget: 'text' },
    ] },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: ReviewWalkthroughInputSchema,
    outputSchema: StrictJsonValueSchema,
    completion: reviewWalkthroughCompletion,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'review.explain_findings', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    title: 'Explain review findings',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['session_action_menu', 'command_palette', 'voice_panel'],
    bindings: { voiceClientToolName: 'reviewExplainFindings', mcpToolName: 'review_explain_findings' },
    cli: { commands: [{ path: ['review', 'explain-findings'], visibility: 'canonical' }] },
    examples: { voice: { argsExample: '{"runId":"review-1","cwd":"/repo","resultId":"result-1","expectedRevision":1,"findingIds":[{"runId":"review-1","findingId":"finding-1"}]}' } },
    inputHints: { description: 'Have an agent explain chosen review findings: what is wrong, why it matters and what to do.', fields: [
      { path: 'target.kind', title: 'Detached target', widget: 'select', options: [{ value: 'detached', label: 'Machine workspace (no Session)' }] },
      { path: 'runId', title: 'Reviewer Run', widget: 'text', required: true },
      { path: 'reviewRunIds', title: 'Reviewer Runs', widget: 'text_list', listSeparator: 'comma' },
      { path: 'cwd', title: 'Repository', widget: 'text', required: true },
      { path: 'resultId', title: 'Saved result', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Current result revision', widget: 'integer', required: true },
      { path: 'findingIds', title: 'Finding Run identities', widget: 'json', required: true },
      { path: 'instructions', title: 'Instructions', widget: 'textarea' },
    ] },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: ReviewExplainFindingsInputSchema,
    outputSchema: StrictJsonValueSchema,
  } satisfies PreNormalizedActionSpec,
] as const);



export const ReviewEnginesListInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  includeDisabled: z.optional(z.boolean()),
  scope: z.optional(z.literal('paths')),
}));

export const REVIEW_ENGINE_DISCOVERY_ACTION_SPECS = Object.freeze([
  {
    id: 'review.engines.list', executionPlacement: 'session', approval: {result: 'required'},
    title: 'List review engines',
    sideEffectClass: 'read',
    description: 'List review engines available for an authorized Session or detached Machine.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listReviewEngines', mcpToolName: 'review_engines_list' },
    cli: { commands: [{ path: ['review', 'engines'], visibility: 'canonical' }] },
    executionPlacementForInput: (input: unknown) =>
      typeof input === 'object' && input !== null && 'sessionId' in input && input.sessionId === null
        ? 'machine' : 'session',
    examples: {
      voice: { argsExample: '{"sessionId":"{{sessionId}}","includeDisabled":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List review engines',
      fields: [
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text' },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'includeDisabled', title: 'Include disabled', widget: 'boolean' },
        { path: 'scope', title: 'Scope', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ReviewEnginesListInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);

