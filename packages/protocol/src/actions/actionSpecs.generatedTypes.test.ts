import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type {
  PluginActionInputById,
  PluginActionResultById,
  PluginInvocableActionId,
  PublicActionId,
  PublicActionInputById,
  PublicActionResultById,
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
} from './actionSpecs.js';
import type {
  BrowserCommandDispatchResultV1,
} from '../browser/control/v1.js';
import { BrowserNavigateCommandV1Schema } from '../browser/control/v1.js';
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
  SessionInputAdmissionResultV1Schema,
  type SessionInputAdmissionResultV1,
} from '../sessions/messages/sessionInputAdmission.js';
import type { SessionSpawnNewInputV2 } from '../sessions/creation/sessionSpawnNewInputV2.js';

type BrowserNavigateCommandV1 = z.infer<typeof BrowserNavigateCommandV1Schema>;

type IsUnknown<T> = unknown extends T
  ? ([keyof T] extends [never] ? true : false)
  : false;

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
    expectTypeOf<PluginActionResultById['execution.run.start']>().toEqualTypeOf<ExecutionRunStartResponse>();
    expectTypeOf<PluginActionResultById['execution.run.list']>().toEqualTypeOf<ExecutionRunListResponse>();
    expectTypeOf<PluginActionResultById['execution.run.get']>().toEqualTypeOf<ExecutionRunGetResponse>();
    expectTypeOf<PluginActionResultById['execution.run.send']>().toEqualTypeOf<ExecutionRunSendResponse>();
    expectTypeOf<PluginActionResultById['execution.run.stop']>().toEqualTypeOf<ExecutionRunStopResponse>();
    expectTypeOf<PluginActionResultById['execution.run.wait']>().toEqualTypeOf<ExecutionRunWaitResult>();
    expectTypeOf<ExecutionRunStartResponse['wait']>().toEqualTypeOf<ExecutionRunWaitResult | undefined>();
    expectTypeOf<PluginActionInputById['session.transcript.get']>()
      .toEqualTypeOf<SessionTranscriptGetExternalShareableInputV1>();
    expectTypeOf<PluginActionResultById['session.transcript.get']>()
      .toEqualTypeOf<SessionTranscriptGetExternalShareableResultV1>();
    expectTypeOf<PluginActionResultById['session.message.send']>()
      .toEqualTypeOf<SessionInputAdmissionResultV1>();
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
    expect(schema).toBe(SessionInputAdmissionResultV1Schema);
  });

  it('excludes runtime action ids without a real canonical executor', () => {
    expectTypeOf<Extract<PluginInvocableActionId, 'devices.simulator.input.orientation'>>()
      .toEqualTypeOf<never>();
    expectTypeOf<Extract<PluginInvocableActionId, 'ui.current_context.read'>>()
      .toEqualTypeOf<never>();
    expectTypeOf<Extract<PluginInvocableActionId, 'voice_agent.start'>>()
      .toEqualTypeOf<'voice_agent.start'>();
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
    expectTypeOf<UnknownPublicInputIds>().toEqualTypeOf<never>();
    expectTypeOf<UnknownPublicResultIds>().toEqualTypeOf<never>();
    expectTypeOf<keyof typeof PUBLIC_ACTION_INPUT_SCHEMAS>().toEqualTypeOf<PublicActionId>();
    expectTypeOf<keyof typeof PUBLIC_ACTION_OUTPUT_SCHEMAS>().toEqualTypeOf<PublicActionId>();
    expectTypeOf<PublicActionInputByRuntimeSchemaMap>().toEqualTypeOf<PublicActionInputById>();
    expectTypeOf<PublicActionResultByRuntimeSchemaMap>().toEqualTypeOf<PublicActionResultById>();

    const apiSpawnInput: PublicActionInputById['session.spawn_new'] = {
      directory: '/workspace/project',
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

  it('excludes client-placed Actions from public runtime and type projections', () => {
    expect(PublicActionIdSchema.safeParse('ui.current_context.read').success).toBe(false);
    expect(PublicActionIdSchema.safeParse('ui.current_context.command.invoke').success).toBe(false);
    expect(PublicActionIdSchema.safeParse('voice_agent.start').success).toBe(true);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'ui.current_context.read')).toBe(false);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'ui.current_context.command.invoke')).toBe(false);
    expect(Object.hasOwn(PUBLIC_ACTION_INPUT_SCHEMAS, 'voice_agent.start')).toBe(true);
    expectTypeOf<Extract<PublicActionId, 'ui.current_context.read'>>()
      .toEqualTypeOf<never>();
    expectTypeOf<Extract<PublicActionId, 'ui.current_context.command.invoke'>>()
      .toEqualTypeOf<never>();
    expectTypeOf<Extract<PublicActionId, 'voice_agent.start'>>().toEqualTypeOf<'voice_agent.start'>();
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
