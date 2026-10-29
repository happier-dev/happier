import type { PreNormalizedActionSpec } from './definition.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { z } from 'zod/mini';
import { WorkflowActionInputSchemasV1, WorkflowActionOutputSchemasV1, type WorkflowActionIdV1 } from '../../workflows/actionsV1.js';
import { WORKFLOW_ACTION_IDS_V1 } from '../actionIds.js';
import { getWorkflowInputHints } from './workflowInputHints.js';


export const WORKFLOW_DIRECT_MCP_ACTION_IDS = new Set<WorkflowActionIdV1>([
  'workflow.run.start', 'workflow.run.get', 'workflow.run.wait', 'workflow.run.cancel',
]);

export const WORKFLOW_DANGER_ACTION_IDS = new Set<WorkflowActionIdV1>([
  'workflow.run.delete', 'workflow.definition.delete',
  'workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove',
  'workflow.trigger.run_now',
  'session.trigger.remove',
]);

export const WORKFLOW_ACTION_TITLES: Readonly<Record<WorkflowActionIdV1, string>> = {
  'workflow.validate': 'Validate workflow',
  'workflow.run.start': 'Start workflow Run',
  'workflow.run.list': 'List workflow Runs',
  'workflow.run.summaries': 'Summarize workflow Runs',
  'workflow.run.get': 'Get workflow Run',
  'workflow.run.read_state.set': 'Mark workflow failure seen',
  'workflow.run.wait': 'Wait for workflow Run',
  'workflow.run.pause': 'Pause workflow Run',
  'workflow.run.resume': 'Resume workflow Run',
  'workflow.run.cancel': 'Cancel workflow Run',
  'workflow.run.invocations.list': 'List workflow invocations',
  'workflow.run.invocations.get': 'Get workflow invocation',
  'workflow.run.invocations.retry': 'Retry workflow invocation',
  'workflow.run.invocations.publish_draft': 'Publish workflow draft result',
  'workflow.run.invocations.complete_review': 'Complete workflow review',
  'workflow.run.delete': 'Delete workflow Run history',
  'workflow.definition.list': 'List saved workflow definitions',
  'workflow.definition.get': 'Get saved workflow definition',
  'workflow.definition.create': 'Create workflow definition',
  'workflow.definition.update': 'Update workflow definition',
  'workflow.definition.edit': 'Edit workflow definition',
  'workflow.definition.delete': 'Delete workflow definition',
  'workflow.definition.import': 'Import workflow document',
  'workflow.definition.export': 'Export saved workflow document',
  'workflow.definition.capture': 'Prepare an editable pattern',
  'workflow.trigger.list': 'List workflow triggers',
  'workflow.trigger.add': 'Add workflow trigger',
  'workflow.trigger.update': 'Update workflow trigger',
  'workflow.trigger.remove': 'Remove workflow trigger',
  'workflow.trigger.run_now': 'Run saved Automation now',
  'session.trigger.list': 'List session triggers',
  'session.trigger.add': 'Add session trigger',
  'session.trigger.update': 'Update session trigger',
  'session.trigger.remove': 'Remove session trigger',
};

export const WORKFLOW_TRIGGER_VOICE_ARGS_EXAMPLES: Readonly<Partial<Record<WorkflowActionIdV1, string>>> = {
  'workflow.run.list': '{"targetSessionId":"session_123"}',
  'workflow.run.start': '{"runId":"22222222-2222-4222-8222-222222222222","source":{"kind":"inline","definition":{"blocks":["Use the accepted workflow"]},"replay":{"runId":"11111111-1111-4111-8111-111111111111","intent":"another_round"}}}',
  'workflow.trigger.list': '{"workflow":"builtin:review-and-converge"}',
  'workflow.trigger.add': '{"workflow":"builtin:review-and-converge","project":{"machineId":"machine_123","directory":"/workspace/project"},"trigger":{"kind":"schedule","enabled":true,"schedule":{"kind":"cron","scheduleExpr":"0 9 * * *","everyMs":null,"timezone":"UTC"}}}',
  'workflow.trigger.update': '{"automationId":"automation_123","triggerId":"trigger_123","expectedRevision":1,"patch":{"enabled":false}}',
  'workflow.trigger.remove': '{"automationId":"automation_123","triggerId":"trigger_123"}',
  'workflow.trigger.run_now': '{"automationId":"automation_123"}',
  'session.trigger.list': '{"sessionId":"session_123"}',
  'session.trigger.add': '{"sessionId":"session_123","target":{"kind":"workflow","ref":"builtin:keep-going"},"trigger":{"kind":"sessionLifecycle","enabled":true,"sourceSessionId":"session_123","events":["parentTurnCompleted"],"policy":{"kind":"everyMatch"}}}',
  'session.trigger.update': '{"sessionId":"session_123","triggerId":"trigger_123","expectedRevision":1,"patch":{"enabled":false}}',
  'session.trigger.remove': '{"sessionId":"session_123","triggerId":"trigger_123"}',
};

export const WORKFLOW_ACTION_DESCRIPTIONS: Readonly<Partial<Record<WorkflowActionIdV1, string>>> = {
  'workflow.definition.capture': 'Prepare an editable draft from explicitly selected authorized Discussion messages. Review inferred steps, exact dependencies and per-run question/participant inputs; use choices to resolve unlinked messages. Workflow-backed exchanges reuse their authored definition and source provenance. Capture does not save, share or start work; open the draft in the ordinary editor and save with workflow.definition.create.',
  'workflow.run.start': `Start an ordinary workflow from a built-in/plugin catalog, a saved definition, or an inline definition. A Session caller supplies the origin Session and its Machine/workspace through authenticated Action context. inputs contains only declared workflow input values; machineId and directory inside inputs do not select a run target. executionTarget selects the leaf execution kind, not the Machine/workspace. For an inline definition, put model and effort on defaults.engine or a step execution.engine, for example {agentTarget,modelSelection,effort:"low"}; do not place reasoning_effort in sessionConfigOptionOverrides. Validate the definition with ${'workflow.validate' satisfies WorkflowActionIdV1} before starting. Retain runId when a response is uncertain. Run again uses source.replay.runId to reopen the accepted graph, runtime and participants; Another round adds source.replay.intent="another_round" and the owner reads authorized prior outcomes into its declared previousRoundContext input. Another round retains all accepted inputs and participants; unavailable context or targets requires repair before starting. It uses the ordinary start approval; contained Actions keep their own approval and authority.`,
  'workflow.trigger.remove': 'Remove one trigger by automationId and triggerId; the last child removal leaves a Manual set. Omit triggerId to delete the whole Account trigger set, including an empty Manual set. Past Runs are kept.',
  'workflow.definition.list': 'List saved workflows in this Home Account and available plugin workflows. Returns definitions with metadata, content availability and trigger summaries, plus pluginWorkflows when available. Follow nextCursor to read later pages; use workflow.definition.get to read a saved definition.',
  'workflow.definition.get': 'Read one saved workflow definition, its metadata, revision and destinations using a definitionId from workflow.definition.list.',
  'workflow.definition.create': 'Save an authored workflow definition without running it. Supply a UUID definitionId for the new Artifact; reuse that UUID only to rejoin the same create. For named starter templates, first execute workflow.starters.list and workflow.starters.resolve. Block kinds describe workflow syntax; eligible trigger events come from workflow.events.list.',
  'workflow.run.list': 'List started workflow Runs and their progress in this Home Account. Run history can be empty while saved definitions exist; use workflow.definition.list for the workflow library. Use execution.run.list for agent execution runs.',
  'workflow.definition.edit': 'Prefer this typed operation batch for partial workflow changes; workflow.definition.update replaces the whole definition.',
  'workflow.run.invocations.publish_draft': "Publish a private draft value validated against the invocation's exact frozen result contract. Prose does not publish a result. Publication does not complete or advance the invocation. If publication fails, request a present-user follow-up; an agent must not complete the review.",
  'workflow.run.invocations.complete_review': 'Present-user only: use the stored or supplied validated result, or request generation on the held invocation, using its exact content revision. Automated callers cannot resolve review.',
};

export const WorkflowInvocationRetryCliInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(WorkflowActionInputSchemasV1[
  'workflow.run.invocations.retry'
], { input: true }), {
  retryInput: WorkflowActionInputSchemasV1['workflow.run.invocations.retry'].shape.input,
})));

export function bindWorkflowInvocationRetryCliInputV1(value: unknown): unknown {
  const { retryInput, ...rest } = WorkflowInvocationRetryCliInputV1Schema.parse(value);
  return { ...rest, input: retryInput };
}

export const WORKFLOW_READ_ACTION_IDS: ReadonlySet<WorkflowActionIdV1> = new Set([
  'workflow.validate', 'workflow.run.list', 'workflow.run.summaries', 'workflow.run.get', 'workflow.run.wait',
  'workflow.run.invocations.list', 'workflow.run.invocations.get',
  'workflow.definition.list', 'workflow.definition.get', 'workflow.definition.import', 'workflow.definition.export', 'workflow.definition.capture',
  'workflow.trigger.list', 'session.trigger.list',
]);

export const WORKFLOW_ACTION_SPECS_V1: readonly PreNormalizedActionSpec[] = WORKFLOW_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
  const directMcp = WORKFLOW_DIRECT_MCP_ACTION_IDS.has(actionId);
  // Voice reaches the ordinary Action owner but cannot complete a person's review.
  const voice = actionId !== 'workflow.run.invocations.complete_review';
  const voiceArgsExample = WORKFLOW_TRIGGER_VOICE_ARGS_EXAMPLES[actionId];
  const sideEffectClass = WORKFLOW_DANGER_ACTION_IDS.has(actionId)
    ? 'danger' as const
    : WORKFLOW_READ_ACTION_IDS.has(actionId)
      ? 'read' as const
      : 'write' as const;
  const commandPath = actionId.split('.');
  const deletesRetainedContent = actionId === 'workflow.run.delete' || actionId === 'workflow.definition.delete';
  return {
    id: actionId,
    executionPlacement: actionId === 'workflow.run.start' ? 'machine' : 'account',
    approvalPolicy: {
      uiConfirmation: deletesRetainedContent ? 'policy' : 'direct',
      // Removing a child leaves the Habit intact; deleting the whole set loses its saved recipe.
      ...(actionId === 'workflow.trigger.remove' ? {
        uiConfirmationForInput: (input: unknown) => typeof readRecord(input).triggerId !== 'string',
      } : {}),
      ...(actionId === 'session.trigger.remove' ? { scopeAdmissionOwnsConfirmation: true as const } : {}),
    },
    ...(deletesRetainedContent || actionId === 'workflow.trigger.remove'
      ? { irreversible: true as const, confirmVerb: { key: 'common.delete', fallback: 'Delete' } } : {}),
    approval: WORKFLOW_READ_ACTION_IDS.has(actionId) ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
    title: WORKFLOW_ACTION_TITLES[actionId],
    description: WORKFLOW_ACTION_DESCRIPTIONS[actionId]
      ?? `${WORKFLOW_ACTION_TITLES[actionId]} through the canonical workflow Action owner.`,
    safety: WORKFLOW_DANGER_ACTION_IDS.has(actionId) ? 'danger' : 'safe',
    placements: [],
    bindings: {
      mcpToolName: actionId.replaceAll('.', '_'),
      // Trusted clients reach the same daemon-owned Workflow Action port. The
      // method is the Action id, so there is no second transport vocabulary.
      rpcMethod: actionId,
      ...(voice
        ? { voiceClientToolName: actionId.replaceAll('.', '_') } : {}),
    },
    surfaces: {
      ui: true,
      voice,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    // Only the four interactive operations project as direct MCP tools; the
    // other Workflow operations stay executable through the generic external
    // MCP `action_execute` transport and discoverable through Action search
    // without gaining a dedicated tool row.
    toolExposure: directMcp
      ? { agent: 'direct' as const, mcp: 'direct' as const }
      : { mcp: 'discoverable_only' as const },
    sideEffectClass,
    ...(actionId === 'workflow.run.invocations.complete_review' ? { requiredAuthority: 'present_user' as const } : {}),
    inputSchema: WorkflowActionInputSchemasV1[actionId],
    outputSchema: WorkflowActionOutputSchemasV1[actionId],
    ...(voiceArgsExample ? { examples: { voice: { argsExample: voiceArgsExample } } } : {}),
    inputHints: getWorkflowInputHints(actionId, WORKFLOW_ACTION_TITLES[actionId]),
    cli: {
      acceptsServerId: true,
      commands: [{ path: commandPath, visibility: 'canonical' }],
      ...(actionId === 'workflow.run.invocations.retry' ? {
        inputSchema: WorkflowInvocationRetryCliInputV1Schema,
        inputHints: {
          title: 'Retry workflow invocation',
          fields: [{
            path: 'retryInput',
            title: 'Retry input',
            description: 'Use {"kind":"original"} or provide a replacement authored input.',
            widget: 'json',
            required: true,
          }],
        },
        bindInput: bindWorkflowInvocationRetryCliInputV1,
      } : {}),
    },
  };
});
