import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type {
  CanonicalActionSpecDefinition,
  PluginActionInputById,
  PluginActionResultById,
  PluginInvocableActionId,
  PublicActionId,
  PublicActionInputById,
  PublicActionResultById,
  SignedRootActionId,
  SessionTranscriptGetExternalShareableInputV1,
  SessionTranscriptGetExternalShareableResultV1,
} from './actionSpecs.js';
import {
  getActionSpec,
  PLUGIN_ACTION_INPUT_SCHEMAS,
  PLUGIN_ACTION_OUTPUT_SCHEMAS,
  PUBLIC_ACTION_INPUT_SCHEMAS,
  PUBLIC_ACTION_OUTPUT_SCHEMAS,
  PublicActionIdSchema,
  SignedRootActionIdSchema,
} from './actionSpecs.js';
import type {
  BrowserCommandDispatchResultV1,
} from '../browser/control/v1.js';
import {
  BrowserHandBackCommandV1Schema,
  BrowserNavigateCommandV1Schema,
  BrowserTakeControlCommandV1Schema,
} from '../browser/control/v1.js';
import { ComputerTargetSelectRequestV1Schema, type ComputerTargetV1 } from '../computer/v1.js';
import type {
  ExternalSessionMaterializeActionResultV1,
} from '../sessions/external/operationActionSchemasV1.js';
import type {
  ExecutionRunGetResponse,
  ExecutionRunListResponse,
  ExecutionRunSendResponse,
  ExecutionRunStartResponse,
  ExecutionRunStopResponse,
  ExecutionRunWaitResult,
} from '../execution/runs/index.js';
import {
  SessionMessageSendResultV1Schema,
  type SessionMessageSendResultV1,
} from '../sessions/messages/sessionInputAdmission.js';
import type { SessionSpawnNewInputV2 } from '../sessions/creation/sessionSpawnNewInputV2.js';
import {
  EPHEMERAL_RUNNER_ACTION_IDS_V1,
  EphemeralRunnerActionInputSchemasV1,
  EphemeralRunnerActionOutputSchemasV1,
  type EphemeralRunnerActionIdV1,
} from '../ephemeralRunner/actionsV1.js';
import {
  WORKFLOW_ACTION_IDS_V1,
  WorkflowActionInputSchemasV1,
  WorkflowActionOutputSchemasV1,
  type WorkflowActionIdV1,
} from '../workflows/actionsV1.js';
import { RuntimeActionIdV1Schema } from './actionIds.js';
import type { ActionExecutorDeps } from './executor/types.js';
import { ROLE_ACTION_IDS_V1 } from '../prompts/roles/roleActionIdsV1.js';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1 } from '../prompts/roles/roleActionsV1.js';

type BrowserNavigateCommandV1 = z.infer<typeof BrowserNavigateCommandV1Schema>;

type IsUnknown<T> = unknown extends T
  ? ([keyof T] extends [never] ? true : false)
  : false;
type IsAny<T> = 0 extends (1 & T) ? true : false;

type UnknownPluginInputIds = {
  [K in PluginInvocableActionId]: IsUnknown<PluginActionInputById[K]> extends true ? K : never;
}[PluginInvocableActionId];

type UnknownPluginResultIds = {
  [K in PluginInvocableActionId]: IsUnknown<PluginActionResultById[K]> extends true ? K : never;
}[PluginInvocableActionId];

type UnknownPublicInputIds = {
  [K in PublicActionId]: IsUnknown<PublicActionInputById[K]> extends true ? K : never;
}[PublicActionId];

type UnknownPublicResultIds = {
  [K in PublicActionId]: IsUnknown<PublicActionResultById[K]> extends true ? K : never;
}[PublicActionId];

type ActionDiscoverySummary = PublicActionResultById['action.spec.search']['actionSpecs'][number];
type ActionDiscoveryDefinition = PublicActionResultById['action.spec.get']['actionSpec'];

// @ts-expect-error external Action discovery summaries are a closed DTO
type ActionDiscoverySummaryUnknownMember = ActionDiscoverySummary['unexpected'];
// @ts-expect-error external Action discovery slash bindings are closed
type ActionDiscoverySlashUnknownMember = NonNullable<ActionDiscoverySummary['slash']>['unexpected'];
// @ts-expect-error external Action discovery bindings are closed
type ActionDiscoveryBindingsUnknownMember = NonNullable<ActionDiscoverySummary['bindings']>['unexpected'];
// @ts-expect-error external Action discovery execution descriptors are closed
type ActionDiscoveryExecutionUnknownMember = NonNullable<ActionDiscoveryDefinition['execution']>['unexpected'];

type PluginActionInputByRuntimeSchemaMap = Readonly<{
  [K in keyof typeof PLUGIN_ACTION_INPUT_SCHEMAS]: z.input<
    (typeof PLUGIN_ACTION_INPUT_SCHEMAS)[K]
  >;
}>;

type PluginActionResultByRuntimeSchemaMap = Readonly<{
  [K in keyof typeof PLUGIN_ACTION_OUTPUT_SCHEMAS]: z.output<
    (typeof PLUGIN_ACTION_OUTPUT_SCHEMAS)[K]
  >;
}>;

type PublicActionInputByRuntimeSchemaMap = Readonly<{
  [K in keyof typeof PUBLIC_ACTION_INPUT_SCHEMAS]: z.input<
    (typeof PUBLIC_ACTION_INPUT_SCHEMAS)[K]
  >;
}>;

type PublicActionResultByRuntimeSchemaMap = Readonly<{
  [K in keyof typeof PUBLIC_ACTION_OUTPUT_SCHEMAS]: z.output<
    (typeof PUBLIC_ACTION_OUTPUT_SCHEMAS)[K]
  >;
}>;


describe('ActionSpec-generated plugin action types', () => {
  it('publishes both Session-list continuation families to plugins and the public SDK', () => {
    expectTypeOf<PluginActionResultById['session.list']>().toMatchTypeOf<{
      attentionNextCursor?: string | null;
      attentionHasNext?: boolean;
      queryVersion?: 1;
    }>();
    expectTypeOf<PublicActionResultById['session.list']>().toMatchTypeOf<{
      attentionNextCursor?: string | null;
      attentionHasNext?: boolean;
      queryVersion?: 1;
    }>();
    expectTypeOf<Extract<PluginActionResultById['session.list'], { view: 'awareness' }>>()
      .toEqualTypeOf<Extract<PublicActionResultById['session.list'], { view: 'awareness' }>>();
    expectTypeOf<keyof Extract<PluginActionResultById['session.list'], { view: 'awareness' }>>()
      .toEqualTypeOf<
        'view' | 'projectionVersion' | 'sessions' | 'nextCursor' | 'hasNext'
        | 'attentionNextCursor' | 'attentionHasNext'
      >();
  });

  it('keeps external Action discovery result DTOs closed', () => {
    expectTypeOf<ActionDiscoverySummary['id']>().toEqualTypeOf<string>();
    expectTypeOf<ActionDiscoveryDefinition['kindVersion']>().toEqualTypeOf<1>();
  });

  it('preserves distinct literal-id input and result types', () => {
    expectTypeOf<PluginActionInputById['memory.search']>().toMatchTypeOf<{
      machineId: string;
      query: {
        v: 1;
        query: string;
        scope: { type: 'global' } | { type: 'session'; sessionId: string };
        mode: 'hints' | 'deep' | 'auto';
      };
    }>();
    expectTypeOf<PluginActionInputById['memory.get_window']>().toMatchTypeOf<{
      machineId: string;
      sessionId: string;
      seqFrom: number;
      seqTo: number;
    }>();
    expectTypeOf<PluginActionResultById['memory.search']>().toMatchTypeOf<
      | { v: 1; ok: true; hits: readonly unknown[] }
      | { v: 1; ok: false; errorCode: string; error: string }
    >();
    expectTypeOf<PluginActionResultById['memory.get_window']>().toMatchTypeOf<{
      v: 1;
      snippets: readonly unknown[];
      citations: readonly unknown[];
    }>();
    expectTypeOf<PluginActionInputById['session.user_action.answer']>().toMatchTypeOf<{
      requestId: string;
      decision?: 'approve' | 'reject' | 'request_changes';
      answers?: readonly { question: string; values?: readonly string[]; answer?: string }[];
    }>();

    expectTypeOf<PluginActionInputById['browser.navigate']>().toEqualTypeOf<BrowserNavigateCommandV1>();
    expectTypeOf<PluginActionResultById['browser.navigate']>().toEqualTypeOf<BrowserCommandDispatchResultV1>();
    expectTypeOf<PluginActionInputById['browser.control.takeControl']>()
      .toEqualTypeOf<z.input<typeof BrowserTakeControlCommandV1Schema>>();
    expectTypeOf<PluginActionInputById['browser.control.handBack']>()
      .toEqualTypeOf<z.input<typeof BrowserHandBackCommandV1Schema>>();
    expectTypeOf<PluginActionResultById['browser.control.takeControl']>()
      .toEqualTypeOf<BrowserCommandDispatchResultV1>();
    expectTypeOf<PluginActionResultById['browser.control.handBack']>()
      .toEqualTypeOf<BrowserCommandDispatchResultV1>();
    expectTypeOf<PluginActionInputById['computer.target.select']>()
      .toEqualTypeOf<z.input<typeof ComputerTargetSelectRequestV1Schema>>();
    expectTypeOf<PublicActionInputById['computer.target.select']>()
      .toEqualTypeOf<PluginActionInputById['computer.target.select']>();
    expectTypeOf<PluginActionInputById['approval.request.decide']['computerTarget']>()
      .toEqualTypeOf<ComputerTargetV1 | undefined>();
    expectTypeOf<PluginActionResultById['execution.run.start']>().toEqualTypeOf<ExecutionRunStartResponse>();
    expectTypeOf<PluginActionResultById['execution.run.list']>().toEqualTypeOf<ExecutionRunListResponse>();
    expectTypeOf<PluginActionResultById['execution.run.get']>().toEqualTypeOf<ExecutionRunGetResponse>();
    expectTypeOf<PluginActionResultById['execution.run.send']>().toEqualTypeOf<ExecutionRunSendResponse>();
    expectTypeOf<PluginActionResultById['execution.run.stop']>().toEqualTypeOf<ExecutionRunStopResponse>();
    expectTypeOf<PluginActionResultById['execution.run.wait']>().toEqualTypeOf<ExecutionRunWaitResult>();
    expectTypeOf<IsAny<Parameters<ActionExecutorDeps['executionRunWait']>[1]>>()
      .toEqualTypeOf<false>();
    expectTypeOf<Parameters<ActionExecutorDeps['executionRunWait']>[1]>()
      .toEqualTypeOf<Omit<PublicActionInputById['execution.run.wait'], 'sessionId'>>();
    expectTypeOf<Extract<ExecutionRunWaitResult, { ok: true; status: 'succeeded' }>['result']>()
      .toEqualTypeOf<ExecutionRunGetResponse>();
    expectTypeOf<ExecutionRunStartResponse['wait']>().toEqualTypeOf<ExecutionRunWaitResult | undefined>();
    expectTypeOf<PluginActionInputById['session.transcript.get']>()
      .toEqualTypeOf<SessionTranscriptGetExternalShareableInputV1>();
    expectTypeOf<PluginActionResultById['session.transcript.get']>()
      .toEqualTypeOf<SessionTranscriptGetExternalShareableResultV1>();
    expectTypeOf<PluginActionResultById['session.message.send']>()
      .toEqualTypeOf<SessionMessageSendResultV1>();
    type ExternalSessionOperationResult =
      PluginActionResultById['sessions.external.operation.status.get'];
    expectTypeOf<PluginActionResultById['sessions.external.materialize.start']>()
      .toEqualTypeOf<ExternalSessionMaterializeActionResultV1>();
    expectTypeOf<PluginActionResultById['sessions.external.operation.cancel']>()
      .toEqualTypeOf<ExternalSessionOperationResult>();
    expectTypeOf<PluginActionResultById['sessions.external.operation.resume']>()
      .toEqualTypeOf<ExternalSessionOperationResult>();
    expectTypeOf<PluginActionResultById['sessions.external.operation.retry']>()
      .toEqualTypeOf<ExternalSessionOperationResult>();
    expectTypeOf<PluginActionResultById['sessions.external.operation.discard']>()
      .toEqualTypeOf<ExternalSessionOperationResult>();

    const publicOperationResult = {
      ok: true,
      operation: {
        sessionId: 'session-1',
        operationId: 'operation-1',
        revision: 4,
      },
      presentation: {
        v: 1,
        operationId: 'operation-1',
        revision: 4,
        kind: 'materialize',
        status: 'running',
        phase: 'validating',
      },
    } as const satisfies ExternalSessionOperationResult;

    const privateTimeline = {
      ...publicOperationResult,
      presentation: {
        ...publicOperationResult.presentation,
        // @ts-expect-error complete operation timelines are exact-owner data.
        timeline: ['validating'],
      },
    } satisfies ExternalSessionOperationResult;
    const privatePriorStorage = {
      ...publicOperationResult,
      presentation: {
        ...publicOperationResult.presentation,
        // @ts-expect-error prior storage is exact-owner recovery data.
        priorStableStorage: { state: 'machine_only' },
      },
    } satisfies ExternalSessionOperationResult;
    const privateCurrentStorage = {
      ...publicOperationResult,
      presentation: {
        ...publicOperationResult.presentation,
        // @ts-expect-error current storage is exact-owner recovery data.
        currentStorageState: 'machine_only',
      },
    } satisfies ExternalSessionOperationResult;
    const privateCheckpoint = {
      ...publicOperationResult,
      presentation: {
        ...publicOperationResult.presentation,
        // @ts-expect-error checkpoints are exact-owner recovery data.
        checkpoint: { sourcePagesRead: 1 },
      },
    } satisfies ExternalSessionOperationResult;
    const privateFence = {
      ...publicOperationResult,
      presentation: {
        ...publicOperationResult.presentation,
        // @ts-expect-error storage fences are exact-owner recovery data.
        fence: { kind: 'none' },
      },
    } satisfies ExternalSessionOperationResult;
    const privatePublication = {
      ...publicOperationResult,
      presentation: {
        ...publicOperationResult.presentation,
        // @ts-expect-error publication state is exact-owner recovery data.
        publication: { materializationPublicationId: 'publication-1' },
      },
    } satisfies ExternalSessionOperationResult;
    const privateRetryState = {
      ...publicOperationResult,
      presentation: {
        ...publicOperationResult.presentation,
        // @ts-expect-error retry state is exact-owner recovery data.
        retryTargetPhase: 'validating',
      },
    } satisfies ExternalSessionOperationResult;
    const privateCompleteProgress = {
      ...publicOperationResult,
      // @ts-expect-error complete progress is not a plugin Action result.
      progress: { operationId: 'operation-1' },
    } satisfies ExternalSessionOperationResult;
    const privateMachine = {
      ...publicOperationResult,
      operation: {
        ...publicOperationResult.operation,
        // @ts-expect-error machine identity is host-private authority.
        machineId: 'machine-1',
      },
    } satisfies ExternalSessionOperationResult;
    const privateSource = {
      ...publicOperationResult,
      operation: {
        ...publicOperationResult.operation,
        // @ts-expect-error resolved source authority is host-private.
        source: { sourceId: 'private-source' },
      },
    } satisfies ExternalSessionOperationResult;
    const privateGeneration = {
      ...publicOperationResult,
      operation: {
        ...publicOperationResult.operation,
        // @ts-expect-error generation identity is host-private authority.
        generation: 'generation-1',
      },
    } satisfies ExternalSessionOperationResult;
    const privateClaim = {
      ...publicOperationResult,
      // @ts-expect-error operation claims are host-private authority.
      operationClaim: { operationClaimId: 'claim-1' },
    } satisfies ExternalSessionOperationResult;
    const privatePath = {
      ...publicOperationResult,
      // @ts-expect-error custody and staging paths are host-private.
      privateStagingPath: '/private/staging/session-1',
    } satisfies ExternalSessionOperationResult;
    const privateOperationRows = {
      ...publicOperationResult,
      // @ts-expect-error durable operation rows are host-private.
      operationRows: [{ operationId: 'operation-1' }],
    } satisfies ExternalSessionOperationResult;
    expectTypeOf([
      privateTimeline,
      privatePriorStorage,
      privateCurrentStorage,
      privateCheckpoint,
      privateFence,
      privatePublication,
      privateRetryState,
      privateCompleteProgress,
      privateMachine,
      privateSource,
      privateGeneration,
      privateClaim,
      privatePath,
      privateOperationRows,
    ]).toBeArray();
    const executionRunStartInput: PluginActionInputById['execution.run.start'] = {
      intent: 'voice_agent',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    };
    expectTypeOf(executionRunStartInput.intent).toEqualTypeOf<
      PluginActionInputById['execution.run.start']['intent']
    >();

    const usageLimitCheckInput: PluginActionInputById['session.usageLimit.checkNow'] = {
      sessionId: 'session-1',
      provider: 'codex',
      operation: 'check_now',
    };
    expectTypeOf(usageLimitCheckInput.sessionId).toEqualTypeOf<string>();

    // @ts-expect-error execution.run.start retains the canonical required intent.
    const invalidExecutionRunStartInput: PluginActionInputById['execution.run.start'] = {
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    };
    expectTypeOf(invalidExecutionRunStartInput).toMatchTypeOf<
      PluginActionInputById['execution.run.start']
    >();

    const navigateInput: PluginActionInputById['browser.navigate'] = {
      kind: 'navigate',
      commandId: 'command-1',
      browserSessionId: 'browser-session-1',
      viewId: 'view-1',
      url: 'https://example.com',
    };
    expectTypeOf(navigateInput).toEqualTypeOf<BrowserNavigateCommandV1>();

    // @ts-expect-error browser.navigate must retain its required canonical URL input.
    const invalidNavigateInput: PluginActionInputById['browser.navigate'] = {
      kind: 'navigate',
      commandId: 'command-1',
      browserSessionId: 'browser-session-1',
      viewId: 'view-1',
    };
    expectTypeOf(invalidNavigateInput).toEqualTypeOf<BrowserNavigateCommandV1>();
  });

  it('keeps plugin Session sends on the closed canonical admission result', () => {
    const schema = getActionSpec('session.message.send').surfaceBindings?.plugin?.outputSchema;
    const accepted = {
      status: 'accepted',
      localId: 'plugin-input-v1:accepted',
    };

    expect(schema?.safeParse(accepted).success).toBe(true);
    expect(schema?.safeParse({ ...accepted, status: 'not-an-admission-result' }).success).toBe(false);
    expect(schema?.safeParse({ ...accepted, unexpected: true }).success).toBe(false);
    expect(schema).toBe(SessionMessageSendResultV1Schema);
    expect(schema?.safeParse({
      status: 'failed',
      localId: 'plugin-input-v1:failed',
      code: 'session_input_turn_failed',
    }).success).toBe(true);
  });

  it('keeps public Session sends on the same closed canonical admission result', () => {
    const input: PublicActionInputById['session.message.send'] = {
      sessionId: 'session-1',
      message: 'Continue',
      localId: 'caller-local-id',
    };
    expect(PUBLIC_ACTION_INPUT_SCHEMAS['session.message.send'].parse(input)).toEqual(input);
    const invalidInput: PublicActionInputById['session.message.send'] = {
      sessionId: 'session-1',
      message: 'Continue',
      // @ts-expect-error plugin idempotency is host-derived and not public PAT input.
      idempotencyKey: 'plugin-input-id',
    };
    expect(PUBLIC_ACTION_INPUT_SCHEMAS['session.message.send'].safeParse(invalidInput).success)
      .toBe(false);
    const schema = getActionSpec('session.message.send').surfaceBindings?.api?.outputSchema;
    expect(schema).toBe(SessionMessageSendResultV1Schema);
    expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['session.message.send']).toBe(
      SessionMessageSendResultV1Schema,
    );
    expectTypeOf<PublicActionResultById['session.message.send']>()
      .toEqualTypeOf<SessionMessageSendResultV1>();
  });

  it('keeps client-placed Actions discoverable while excluding genuinely internal Actions', () => {
    expectTypeOf<Extract<PluginInvocableActionId, 'devices.simulator.input.orientation'>>()
      .toEqualTypeOf<never>();
    expectTypeOf<Extract<PluginInvocableActionId, 'ui.current_context.read'>>()
      .toEqualTypeOf<'ui.current_context.read'>();
    expectTypeOf<Extract<PluginInvocableActionId, 'voice_agent.start'>>()
      .toEqualTypeOf<'voice_agent.start'>();
  });

  it('keeps creator-local Runner Actions account-placed, internal, and exact in the canonical type map', () => {
    for (const actionId of EPHEMERAL_RUNNER_ACTION_IDS_V1) {
      expect(getActionSpec(actionId)).toMatchObject({
        executionPlacement: 'account',
        surfaces: { ui: true, api: false, plugin: false },
      });
      expect(RuntimeActionIdV1Schema.safeParse(actionId).success).toBe(false);
    }

    type RunnerActionSpec = Extract<
      CanonicalActionSpecDefinition,
      Readonly<{ id: EphemeralRunnerActionIdV1 }>
    >;
    type RunnerActionInputSchemas = {
      [K in EphemeralRunnerActionIdV1]: z.input<
        Extract<RunnerActionSpec, Readonly<{ id: K }>>['inputSchema']
      >;
    };
    type RunnerActionOutputSchemas = {
      [K in EphemeralRunnerActionIdV1]: z.output<
        Extract<RunnerActionSpec, Readonly<{ id: K }>>['outputSchema']
      >;
    };
    type ExpectedRunnerActionInputs = {
      [K in EphemeralRunnerActionIdV1]: z.input<(typeof EphemeralRunnerActionInputSchemasV1)[K]>;
    };
    type ExpectedRunnerActionOutputs = {
      [K in EphemeralRunnerActionIdV1]: z.output<(typeof EphemeralRunnerActionOutputSchemasV1)[K]>;
    };

    expectTypeOf<RunnerActionInputSchemas>()
      .toEqualTypeOf<ExpectedRunnerActionInputs>();
    expectTypeOf<RunnerActionOutputSchemas>()
      .toEqualTypeOf<ExpectedRunnerActionOutputs>();
    expectTypeOf<Extract<PluginInvocableActionId, EphemeralRunnerActionIdV1>>()
      .toEqualTypeOf<never>();
  });

  it('keeps workflow Actions public, trusted-plugin invocable, and exact in the canonical type map', () => {
    const readActionIds = new Set<WorkflowActionIdV1>([
      'workflow.validate',
      'workflow.run.list',
      'workflow.run.summaries',
      'workflow.run.get',
      'workflow.run.wait',
      'workflow.run.invocations.list',
      'workflow.run.invocations.get',
      'workflow.definition.list',
      'workflow.definition.get',
      'workflow.definition.import',
      'workflow.definition.export',
      'workflow.trigger.list',
      'session.trigger.list',
    ]);
    const directMcpActionIds = new Set<WorkflowActionIdV1>([
      'workflow.run.start',
      'workflow.run.get',
      'workflow.run.wait',
      'workflow.run.cancel',
    ]);
    const dangerActionIds = new Set<WorkflowActionIdV1>([
      'workflow.run.delete',
      'workflow.definition.delete',
      'workflow.trigger.add',
      'workflow.trigger.update',
      'workflow.trigger.remove',
      'session.trigger.remove',
    ]);

    for (const actionId of WORKFLOW_ACTION_IDS_V1) {
      const spec = getActionSpec(actionId);
      expect(spec, actionId).toMatchObject({
        executionPlacement: actionId === 'workflow.run.start' ? 'machine' : 'account',
        requiredAuthority: actionId === 'workflow.run.invocations.complete_review' ? 'present_user' : 'account_automation',
        safety: dangerActionIds.has(actionId) ? 'danger' : 'safe',
        sideEffectClass: dangerActionIds.has(actionId)
          ? 'danger'
          : readActionIds.has(actionId)
            ? 'read'
            : 'write',
        approval: readActionIds.has(actionId)
          ? { result: 'required' }
          : { result: 'optional', flow: 'deferred' },
        surfaces: {
          ui: true,
          voice: actionId.startsWith('workflow.trigger.') || actionId.startsWith('session.trigger.'),
          agent: true,
          mcp: true,
          cli: true,
          rpc: true,
          api: actionId !== 'workflow.run.invocations.complete_review',
          plugin: true,
        },
      });
      expect(spec.bindings?.mcpToolName).toBe(actionId.replaceAll('.', '_'));
      expect(spec.bindings?.rpcMethod).toBe(actionId);
      // Direct MCP projection stays limited to the four interactive tools;
      // every other Workflow operation is discoverable-only on MCP so generic
      // `action_execute` remains its only generic transport projection.
      expect(spec.toolExposure, actionId).toEqual(
        directMcpActionIds.has(actionId) ? undefined : { mcp: 'discoverable_only' },
      );
    }

    type ExpectedWorkflowActionInputs = Readonly<{
      [K in WorkflowActionIdV1]: z.input<(typeof WorkflowActionInputSchemasV1)[K]>;
    }>;
    type ExpectedWorkflowActionOutputs = Readonly<{
      [K in WorkflowActionIdV1]: z.output<(typeof WorkflowActionOutputSchemasV1)[K]>;
    }>;

    expectTypeOf<Pick<PluginActionInputById, WorkflowActionIdV1>>()
      .toEqualTypeOf<ExpectedWorkflowActionInputs>();
    expectTypeOf<Pick<PluginActionResultById, WorkflowActionIdV1>>()
      .toEqualTypeOf<ExpectedWorkflowActionOutputs>();
    expectTypeOf<Extract<PluginInvocableActionId, WorkflowActionIdV1>>()
      .toEqualTypeOf<WorkflowActionIdV1>();
  });

  it('does not degrade any generated plugin row to unknown', () => {
    expectTypeOf<UnknownPluginInputIds>().toEqualTypeOf<never>();
    expectTypeOf<UnknownPluginResultIds>().toEqualTypeOf<never>();
  });

  it('projects exact API schemas only for public Actions', () => {
    expect(PublicActionIdSchema.parse('session.spawn_new')).toBe('session.spawn_new');
    expect(PublicActionIdSchema.safeParse('sessions.subagents.list').success).toBe(true);
    expect(PublicActionIdSchema.safeParse('sessions.subagents.upsert').success).toBe(false);
    expect(PublicActionIdSchema.safeParse('sessions.external.materialize.start').success).toBe(false);
    expect(PublicActionIdSchema.safeParse('plugins.permissions.grants.revoke').success).toBe(false);
    expect(PublicActionIdSchema.safeParse('projects.list').success).toBe(true);
    expect(PublicActionIdSchema.safeParse('ui.current_context.read').success).toBe(true);
    expect(PublicActionIdSchema.safeParse('devices.simulator.input.orientation').success).toBe(false);
    expect(PublicActionIdSchema.safeParse('approval.request.decide').success).toBe(true);
    expect(PublicActionIdSchema.safeParse('plugins.install').success).toBe(false);
    expect(SignedRootActionIdSchema.safeParse('approval.request.decide').success).toBe(true);
    expect(SignedRootActionIdSchema.safeParse('plugins.install').success).toBe(true);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'session.spawn_new')).toBe(true);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'sessions.subagents.list')).toBe(true);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'sessions.subagents.upsert')).toBe(false);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'sessions.external.materialize.start')).toBe(false);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'plugins.permissions.grants.revoke')).toBe(false);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'devices.simulator.input.orientation')).toBe(false);

    expectTypeOf<Extract<PublicActionId, 'session.spawn_new'>>().toEqualTypeOf<'session.spawn_new'>();
    expectTypeOf<Extract<PublicActionId, 'sessions.subagents.list'>>()
      .toEqualTypeOf<'sessions.subagents.list'>();
    expectTypeOf<Extract<PublicActionId, 'projects.list'>>().toEqualTypeOf<'projects.list'>();
    expectTypeOf<Extract<PublicActionId, 'ui.current_context.read'>>()
      .toEqualTypeOf<'ui.current_context.read'>();
    expectTypeOf<Extract<PublicActionId, 'sessions.subagents.upsert'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<PublicActionId, 'sessions.external.materialize.start'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<PublicActionId, 'plugins.permissions.grants.revoke'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<PublicActionId, 'devices.simulator.input.orientation'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<PublicActionId, 'approval.request.decide'>>().toEqualTypeOf<'approval.request.decide'>();
    expectTypeOf<Extract<PublicActionId, 'plugins.install'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<PublicActionId, 'identity.providers.create'>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<PublicActionId, 'identity.providers.list'>>()
      .toEqualTypeOf<'identity.providers.list'>();
    expectTypeOf<Extract<SignedRootActionId, 'approval.request.decide'>>()
      .toEqualTypeOf<'approval.request.decide'>();
    expectTypeOf<Extract<SignedRootActionId, 'plugins.install'>>()
      .toEqualTypeOf<'plugins.install'>();
    expectTypeOf<UnknownPublicInputIds>().toEqualTypeOf<never>();
    expectTypeOf<UnknownPublicResultIds>().toEqualTypeOf<never>();
    expectTypeOf<keyof typeof PUBLIC_ACTION_INPUT_SCHEMAS>().toEqualTypeOf<PublicActionId>();
    expectTypeOf<keyof typeof PUBLIC_ACTION_OUTPUT_SCHEMAS>().toEqualTypeOf<PublicActionId>();
    expectTypeOf<PublicActionInputByRuntimeSchemaMap>().toEqualTypeOf<PublicActionInputById>();
    expectTypeOf<PublicActionResultByRuntimeSchemaMap>().toEqualTypeOf<PublicActionResultById>();

    const apiSpawnInput: PublicActionInputById['session.spawn_new'] = {
      directory: { kind: 'path', path: '/workspace/project' },
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
    };
    expect(PUBLIC_ACTION_INPUT_SCHEMAS['session.spawn_new'].safeParse(apiSpawnInput).success).toBe(true);
    expect(PUBLIC_ACTION_INPUT_SCHEMAS['session.spawn_new'].safeParse({
      ...apiSpawnInput,
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    }).success).toBe(false);
    // @ts-expect-error API callers cannot supply host-owned execution placement.
    const callerSuppliedTarget: PublicActionInputById['session.spawn_new'] = {
      ...apiSpawnInput,
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    };
    // @ts-expect-error CLI and other canonical Action callers still supply executionTarget.
    const canonicalInputWithoutTarget: SessionSpawnNewInputV2 = apiSpawnInput;
    void callerSuppliedTarget;
    void canonicalInputWithoutTarget;

    // @ts-expect-error only public API Actions have a generated input schema.
    const unavailableSchema = PUBLIC_ACTION_INPUT_SCHEMAS['sessions.external.materialize.start'];
    expectTypeOf(unavailableSchema).toEqualTypeOf<never>();
  });

  it('keeps client-placed Actions in public runtime and type projections', () => {
    expect(PublicActionIdSchema.safeParse('ui.current_context.read').success).toBe(true);
    expect(PublicActionIdSchema.safeParse('ui.current_context.command.invoke').success).toBe(true);
    expect(PublicActionIdSchema.safeParse('voice_agent.start').success).toBe(true);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'ui.current_context.read')).toBe(true);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'ui.current_context.command.invoke')).toBe(true);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'voice_agent.start')).toBe(true);
    expectTypeOf<Extract<PublicActionId, 'ui.current_context.read'>>()
      .toEqualTypeOf<'ui.current_context.read'>();
    expectTypeOf<Extract<PublicActionId, 'ui.current_context.command.invoke'>>()
      .toEqualTypeOf<'ui.current_context.command.invoke'>();
    expectTypeOf<Extract<PublicActionId, 'voice_agent.start'>>().toEqualTypeOf<'voice_agent.start'>();
  });

  it('keeps role Actions loadable and their author maps exact', () => {
    expectTypeOf<PluginActionInputById['session.role.set']>().toEqualTypeOf<{ sessionId: string; roleId: string }>();
    expectTypeOf<PluginActionInputById['roles.create']>().toEqualTypeOf<z.input<typeof RoleActionInputSchemasV1['roles.create']>>();
    expectTypeOf<PluginActionResultById['roles.create']>().toEqualTypeOf<z.output<typeof RoleActionOutputSchemasV1['roles.create']>>();
    for (const actionId of ROLE_ACTION_IDS_V1) {
      const spec = getActionSpec(actionId);
      expect(spec.executionPlacement).toBe(actionId.startsWith('roles.') ? 'account' : 'session');
      expect(spec.approval.result).toBe('required');
      expect(PLUGIN_ACTION_INPUT_SCHEMAS[actionId].safeParse({ unexpected: true }).success).toBe(false);
      expect(PLUGIN_ACTION_OUTPUT_SCHEMAS[actionId]).toBeDefined();
    }
  });

  it('retains every exact action schema in its single runtime projection map', () => {
    expectTypeOf<keyof typeof PLUGIN_ACTION_INPUT_SCHEMAS>()
      .toEqualTypeOf<PluginInvocableActionId>();
    expectTypeOf<keyof typeof PLUGIN_ACTION_OUTPUT_SCHEMAS>()
      .toEqualTypeOf<PluginInvocableActionId>();
    expectTypeOf<PluginActionInputByRuntimeSchemaMap>()
      .toEqualTypeOf<PluginActionInputById>();
    expectTypeOf<PluginActionResultByRuntimeSchemaMap>()
      .toEqualTypeOf<PluginActionResultById>();

    // @ts-expect-error host-only Action ids never enter the Plugin schema map.
    const unavailableSchema = PLUGIN_ACTION_INPUT_SCHEMAS['session.history.get'];
    expectTypeOf(unavailableSchema).toEqualTypeOf<never>();

    // @ts-expect-error the projected memory.search schema keeps its required query field.
    const invalidInput: z.input<typeof PLUGIN_ACTION_INPUT_SCHEMAS['memory.search']> = {
      machineId: 'machine-1',
    };
    expectTypeOf(invalidInput).toEqualTypeOf<PluginActionInputById['memory.search']>();
  });

  it('rejects an invalid literal-id input at compile time', () => {
    // @ts-expect-error memory.search requires the canonical nested query object.
    const invalid: PluginActionInputById['memory.search'] = { machineId: 'machine-1' };
    expectTypeOf(invalid).toMatchTypeOf<PluginActionInputById['memory.search']>();

    const request: PluginActionInputById['plugins.permissions.grants.request'] = {
      capability: 'network',
      targetScope: { kind: 'account' },
      subject: { kind: 'general' },
      reason: 'Use the declared optional network capability',
    };
    // @ts-expect-error plugin identity is host-bound and absent from the author input schema.
    request.pluginId = 'spoofed.plugin';
    type CredentialSubject = Extract<
      PluginActionInputById['plugins.permissions.grants.request']['subject'],
      { kind: 'credential_access_disclosure' }
    >;
    expectTypeOf<CredentialSubject['contribution']>().toEqualTypeOf<{ localId: string }>();
  });
});
