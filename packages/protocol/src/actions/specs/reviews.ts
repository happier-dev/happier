import { ReviewListRequestV1Schema, ReviewListResponseV1Schema, ReviewGetRequestV1Schema, ReviewGetResponseV1Schema, ReviewHistoryRequestV1Schema, ReviewHistoryResponseV1Schema } from '../../reviews/reviewListV1.js';
import { REVIEW_HUMAN_ACTION_IDS_V1 } from '../actionIdsReviewHumanV1.js';
import { ReviewHumanGetInputV1Schema, ReviewHumanActionStateV1Schema, ReviewReviewersSetInputV1Schema, ReviewVerdictActionInputV1Schema, ReviewVerdictSubmitInputV1Schema } from '../../reviews/reviewHumanV1.js';
import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { selectTeamCredentialSourcesForApproval } from './teamCredentialApproval.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { ReviewFindingsApplyInputV1Schema, ReviewFindingsApplyResultV1Schema } from '../../reviews/reviewApplyV1.js';
import { reviewStartCompletion, reviewWalkthroughCompletion } from './executionRunCompletion.js';
import { ReviewStartInputSchema } from '../../reviews/reviewStart.js';
import { ReviewEngineProfileSelectionSchema, ReviewEngineScopeSchema } from '../../reviews/reviewEngines.js';
import { ReviewWalkthroughInputSchema, ReviewExplainFindingsInputSchema } from '../../reviews/reviewNarration.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { resolveExecutionRunMachineRuntimeDemand } from '../executor/sessionScope.js';


import { ReviewPrepareRoundInputV1Schema, ReviewPreparedRoundV1Schema, ReviewSettleRoundInputV1Schema, ReviewNewRoundInputV1Schema, ReviewNewRoundResultV1Schema } from '../../reviews/reviewRoundActionsV1.js';
import { ReviewRoundBindingV1Schema } from '../../reviews/reviewArtifactV1.js';
import { REVIEW_PREPARE_ROUND_ACTION_ID_V1, REVIEW_SETTLE_ROUND_ACTION_ID_V1, REVIEW_NEW_ROUND_ACTION_ID_V1 } from '../actionIds.js';

function resolveReviewExecutionPlacementForInput(input: unknown): 'machine' | 'session' {
  return readRecord(readRecord(input).target).kind === 'detached' ? 'machine' : 'session';
}

function createReviewActionSpecs(): readonly [
  PreNormalizedActionSpec & { readonly id: typeof REVIEW_HUMAN_ACTION_IDS_V1.get; readonly approval: { readonly result: 'required' }; readonly requiredAuthority: 'account_automation'; readonly inputSchema: typeof ReviewHumanGetInputV1Schema; readonly outputSchema: typeof ReviewHumanActionStateV1Schema },
  PreNormalizedActionSpec & { readonly id: typeof REVIEW_HUMAN_ACTION_IDS_V1.setReviewers; readonly approval: { readonly result: 'required' }; readonly requiredAuthority: 'account_automation'; readonly inputSchema: typeof ReviewReviewersSetInputV1Schema; readonly outputSchema: typeof ReviewHumanActionStateV1Schema },
  PreNormalizedActionSpec & { readonly id: typeof REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict; readonly approval: { readonly result: 'required' }; readonly requiredAuthority: 'present_user'; readonly inputSchema: typeof ReviewVerdictActionInputV1Schema; readonly outputSchema: typeof ReviewHumanActionStateV1Schema },
  PreNormalizedActionSpec & { readonly id: typeof REVIEW_PREPARE_ROUND_ACTION_ID_V1; readonly approval: { readonly result: 'optional'; readonly flow: 'deferred' }; readonly inputSchema: typeof ReviewPrepareRoundInputV1Schema; readonly outputSchema: typeof ReviewPreparedRoundV1Schema },
  PreNormalizedActionSpec & { readonly id: typeof REVIEW_SETTLE_ROUND_ACTION_ID_V1; readonly approval: { readonly result: 'optional'; readonly flow: 'deferred' }; readonly inputSchema: typeof ReviewSettleRoundInputV1Schema; readonly outputSchema: typeof ReviewRoundBindingV1Schema },
  PreNormalizedActionSpec & { readonly id: typeof REVIEW_NEW_ROUND_ACTION_ID_V1; readonly approval: { readonly result: 'optional'; readonly flow: 'deferred' }; readonly inputSchema: typeof ReviewNewRoundInputV1Schema; readonly outputSchema: typeof ReviewNewRoundResultV1Schema },
  PreNormalizedActionSpec & { readonly id: 'reviews.list'; readonly approval: { readonly result: 'required' }; readonly requiredAuthority: 'account_automation'; readonly inputSchema: typeof ReviewListRequestV1Schema; readonly outputSchema: typeof ReviewListResponseV1Schema },
  PreNormalizedActionSpec & { readonly id: 'review.get'; readonly approval: { readonly result: 'required' }; readonly requiredAuthority: 'account_automation'; readonly inputSchema: typeof ReviewGetRequestV1Schema; readonly outputSchema: typeof ReviewGetResponseV1Schema },
  PreNormalizedActionSpec & { readonly id: 'review.history.list'; readonly approval: { readonly result: 'required' }; readonly requiredAuthority: 'account_automation'; readonly inputSchema: typeof ReviewHistoryRequestV1Schema; readonly outputSchema: typeof ReviewHistoryResponseV1Schema },
  PreNormalizedActionSpec & { readonly id: 'review.start'; readonly approval: { readonly result: 'optional'; readonly flow: 'deferred' }; readonly inputSchema: typeof ReviewStartInputSchema; readonly outputSchema: typeof StrictJsonValueSchema },
  PreNormalizedActionSpec & { readonly id: 'review.apply'; readonly approval: { readonly result: 'optional'; readonly flow: 'deferred' }; readonly inputSchema: typeof ReviewFindingsApplyInputV1Schema; readonly outputSchema: typeof ReviewFindingsApplyResultV1Schema },
  PreNormalizedActionSpec & { readonly id: 'review.walkthrough'; readonly approval: { readonly result: 'optional'; readonly flow: 'deferred' }; readonly inputSchema: typeof ReviewWalkthroughInputSchema; readonly outputSchema: typeof StrictJsonValueSchema },
  PreNormalizedActionSpec & { readonly id: 'review.explain_findings'; readonly approval: { readonly result: 'optional'; readonly flow: 'deferred' }; readonly inputSchema: typeof ReviewExplainFindingsInputSchema; readonly outputSchema: typeof StrictJsonValueSchema },
] {
  return Object.freeze([
// Imports added to existing specs/reviews.ts; canonical Action-id constants live in actionIds.ts.
{
  id: REVIEW_HUMAN_ACTION_IDS_V1.get, executionPlacement: 'account', requiredAuthority: 'account_automation',
  approval: { result: 'required' }, title: 'Read requested reviewers and verdicts', safety: 'safe', sideEffectClass: 'read',
  description: 'Read the authorized Review’s requested people, round verdict history and needs-you facts.',
  placements: [], surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
  bindings: { mcpToolName: 'review_human_get', voiceClientToolName: 'review_human_get' },
  serverTransport: { method: 'GET', path: '/v1/reviews/:reviewId/human' },
  cli: { acceptsServerId: true, commands: [{ path: ['review', 'human', 'get'], visibility: 'canonical' }] },
  inputHints: { fields: [{ path: 'reviewId', title: 'Review', widget: 'text', required: true }] },
  inputSchema: ReviewHumanGetInputV1Schema, outputSchema: ReviewHumanActionStateV1Schema,
} satisfies PreNormalizedActionSpec,
{
  id: REVIEW_HUMAN_ACTION_IDS_V1.setReviewers, executionPlacement: 'account', requiredAuthority: 'account_automation',
  approval: { result: 'required' }, title: 'Set requested reviewers', safety: 'safe', sideEffectClass: 'external',
  description: 'Request people, Teams or Groups for this round. Requires Edit; requesting creates no access grant.',
  placements: [], surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
  bindings: { mcpToolName: 'review_reviewers_set', voiceClientToolName: 'review_reviewers_set' },
  serverTransport: { method: 'POST', path: '/v1/reviews/:reviewId/reviewers' },
  cli: { acceptsServerId: true, commands: [{ path: ['review', 'reviewers', 'set'], visibility: 'canonical' }] },
  inputHints: { fields: [{ path: 'reviewId', title: 'Review', widget: 'text', required: true },
    { path: 'roundOrdinal', title: 'Round', widget: 'integer', required: true },
    { path: 'reviewers', title: 'Requested reviewers', widget: 'json', required: true }] },
  inputSchema: ReviewReviewersSetInputV1Schema, outputSchema: ReviewHumanActionStateV1Schema,
} satisfies PreNormalizedActionSpec,
{
  id: REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict, executionPlacement: 'account', requiredAuthority: 'present_user',
  approval: { result: 'required' }, title: 'Submit your verdict', safety: 'safe', sideEffectClass: 'external',
  description: 'Answer a review request as yourself. View access and a request for you are required.',
  placements: [], surfaces: { ui: true, cli: true, agent: false, mcp: false, voice: false, rpc: false },
  serverTransport: { method: 'POST', path: '/v1/reviews/:reviewId/verdicts', inputSchema: ReviewVerdictSubmitInputV1Schema },
  cli: { acceptsServerId: true, commands: [{ path: ['review', 'verdict', 'submit'], visibility: 'canonical' }] },
  inputHints: { fields: [{ path: 'reviewId', title: 'Review', widget: 'text', required: true },
    { path: 'roundOrdinal', title: 'Round', widget: 'integer', required: true },
    { path: 'verdict', title: 'Verdict', widget: 'select', required: true, options: [
      { value: 'approve', label: 'Approve' }, { value: 'request_changes', label: 'Request changes' }, { value: 'comment', label: 'Comment' }] },
    { path: 'body', title: 'Comment', widget: 'textarea' }] },
  inputSchema: ReviewVerdictActionInputV1Schema, outputSchema: ReviewHumanActionStateV1Schema,
} satisfies PreNormalizedActionSpec,

  {
    id: REVIEW_PREPARE_ROUND_ACTION_ID_V1, executionPlacement: 'session', approval: { result: 'optional', flow: 'deferred' },
    title: 'Prepare Review round', safety: 'safe', sideEffectClass: 'external', placements: [],
    description: 'Consume the admitted first round or prepare the next round and capture its comparison before reviewers run.',
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
    bindings: { mcpToolName: 'review_prepare_round', voiceClientToolName: 'review_prepare_round' },
    inputSchema: ReviewPrepareRoundInputV1Schema, outputSchema: ReviewPreparedRoundV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: REVIEW_SETTLE_ROUND_ACTION_ID_V1, executionPlacement: 'session', approval: { result: 'optional', flow: 'deferred' },
    title: 'Finish Review round', safety: 'safe', sideEffectClass: 'external', placements: [],
    description: 'Settle one admitted Review round from its host-published reviewer outcomes.',
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
    bindings: { mcpToolName: 'review_settle_round', voiceClientToolName: 'review_settle_round' },
    inputSchema: ReviewSettleRoundInputV1Schema, outputSchema: ReviewRoundBindingV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: REVIEW_NEW_ROUND_ACTION_ID_V1, executionPlacement: 'session', approval: { result: 'optional', flow: 'deferred' },
    executionPlacements: ['account', 'session', 'machine'],
    executionPlacementForInput: input => typeof readRecord(input).reviewId === 'string'
      ? 'account' : resolveReviewExecutionPlacementForInput(input),
    title: 'New Review round', safety: 'safe', sideEffectClass: 'external', placements: [],
    description: 'Review current code in the same Review, reusing the accepted workflow or retained native reviewer.',
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
    bindings: { mcpToolName: 'review_new_round', voiceClientToolName: 'review_new_round' },
    inputSchema: ReviewNewRoundInputV1Schema, outputSchema: ReviewNewRoundResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'reviews.list', executionPlacement: 'account', requiredAuthority: 'account_automation',
    approval: { result: 'required' }, title: 'List Reviews', safety: 'safe', sideEffectClass: 'read',
    description: 'Read one authorized Review metadata page. Continue only when another page is explicitly requested. No Review bodies are read.',
    placements: [], surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
    bindings: { mcpToolName: 'reviews_list', voiceClientToolName: 'reviews_list' },
    serverTransport: { method: 'POST', path: '/v1/reviews/list' },
    cli: { acceptsServerId: true, commands: [{ path: ['reviews', 'list'], visibility: 'canonical' }] },
    inputHints: { fields: [{ path: 'limit', title: 'Page size', widget: 'integer', required: true },
      { path: 'cursor', title: 'Page cursor', widget: 'text' },
      { path: 'projectSourceId', title: 'Project source', widget: 'text' },
      { path: 'needsDecision', title: 'Needs a decision', widget: 'boolean' }] },
    inputSchema: ReviewListRequestV1Schema, outputSchema: ReviewListResponseV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'review.get', executionPlacement: 'account', requiredAuthority: 'account_automation',
    approval: { result: 'required' }, title: 'Read Review', safety: 'safe', sideEffectClass: 'read',
    description: 'Read authorized Review metadata, requested people, verdicts and needs-you facts in one snapshot.',
    placements: [], surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
    bindings: { mcpToolName: 'review_get', voiceClientToolName: 'review_get' },
    serverTransport: { method: 'POST', path: '/v1/reviews/get' },
    cli: { acceptsServerId: true, commands: [{ path: ['review', 'get'], visibility: 'canonical' }] },
    inputHints: { fields: [{ path: 'reviewId', title: 'Review', widget: 'text', required: true }] },
    inputSchema: ReviewGetRequestV1Schema, outputSchema: ReviewGetResponseV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'review.history.list', executionPlacement: 'account', requiredAuthority: 'account_automation',
    approval: { result: 'required' }, title: 'Read Review history', safety: 'safe', sideEffectClass: 'read',
    description: 'Read exact finding history across authorized Reviews of the selected workflow. Decisions stay local to each Review.',
    placements: [], surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
    bindings: { mcpToolName: 'review_history_list', voiceClientToolName: 'review_history_list' },
    serverTransport: { method: 'POST', path: '/v1/reviews/history/list' },
    cli: { acceptsServerId: true, commands: [{ path: ['review', 'history', 'list'], visibility: 'canonical' }] },
    inputHints: { fields: [{ path: 'reviewId', title: 'Review', widget: 'text', required: true },
      { path: 'workflowId', title: 'Workflow', widget: 'text', required: true }] },
    inputSchema: ReviewHistoryRequestV1Schema, outputSchema: ReviewHistoryResponseV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'review.start', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    executionPlacements: ['session', 'machine'],
    executionPlacementForInput: resolveReviewExecutionPlacementForInput,
    approvalPresentation: { teamCredentialSources: selectTeamCredentialSourcesForApproval },
    machineRuntimeDemandForInput: (input, context) => resolveExecutionRunMachineRuntimeDemand(
      resolveReviewExecutionPlacementForInput(input) === 'machine'
        || context.actionCaller?.kind === 'workflowRun' && readRecord(input).sessionId === undefined
        ? { sessionId: null } : input, context),
    title: 'Start review',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: ['agent_input_chips', 'session_action_menu', 'command_palette', 'slash_command', 'voice_panel'],
    prompting: { voiceHotPath: true },
    slash: { tokens: ['/review', '/h.review'] },
    bindings: { voiceClientToolName: 'startReview', mcpToolName: 'review_start' },
    inputHints: {
      title: 'Start a code review',
      description: 'Choose an ordered roster of engines, Sessions, models and requested people for a Review.',
      fields: [
        {
          path: 'reviewers',
          title: 'Reviewers',
          description: 'Ordered reviewer selections. Each engine selection retains its own model, profile, credentials and options.',
          widget: 'json',
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
          description: 'Optional inherited Team credential selection for a single engine. Mixed reviewers select credentials on each engine entry.',
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
      voice: { argsExample: '{"reviewers":[{"kind":"engine","engineId":"codex"}],"instructions":"Review this.","changeType":"uncommitted","base":{"kind":"none"}}' },
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
    approvalPolicy: { agentDefault: 'authority' },
    placements: [],
    sessionTarget: { field: 'sessionId', cardinality: 'one' },
    bindings: { mcpToolName: 'review_apply', voiceClientToolName: 'review_apply' },
    inputHints: { title: 'Apply accepted review findings', fields: [
      { path: 'sessionId', title: 'Session', widget: 'select', required: true, optionsSourceId: 'sessions' },
      { path: 'reviewId', title: 'Review', widget: 'text',
        description: 'Apply accepted persisted findings from this Review.' },
      { path: 'reviews', title: 'Reviewed findings', widget: 'json',
        description: 'Historical Run identities and findings, instead of a Review id. Current acceptance and revisions are read before sending.' },
    ] },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: ReviewFindingsApplyInputV1Schema,
    outputSchema: ReviewFindingsApplyResultV1Schema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'review.walkthrough', executionPlacement: 'session', approval: {result: 'optional',flow: 'deferred'},
    executionPlacements: ['session', 'machine'],
    executionPlacementForInput: resolveReviewExecutionPlacementForInput,
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
    executionPlacements: ['session', 'machine'],
    executionPlacementForInput: resolveReviewExecutionPlacementForInput,
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
}

export const REVIEW_ACTION_SPECS: ReturnType<typeof createReviewActionSpecs> = lazyActionSpecArray(createReviewActionSpecs);



export const ReviewEnginesListInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  includeDisabled: z.optional(z.boolean()),
  scope: z.optional(ReviewEngineScopeSchema),
  profileSelections: z.optional(z.array(ReviewEngineProfileSelectionSchema)),
}));

function createReviewEngineDiscoveryActionSpecs() {
  return Object.freeze([
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
}

export const REVIEW_ENGINE_DISCOVERY_ACTION_SPECS: ReturnType<typeof createReviewEngineDiscoveryActionSpecs> = lazyActionSpecArray(createReviewEngineDiscoveryActionSpecs);

