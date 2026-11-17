import { z } from 'zod/mini';
import { PERMISSION_INTENTS } from '@happier-dev/agents';
import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { BackendTargetRefSchema } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { ExecutionRunClassSchema, ExecutionRunIntentSchema, ExecutionRunIoModeSchema, ExecutionRunRetentionPolicySchema } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { ExecutionRunDisplaySchema, ExecutionRunLaunchOriginSchema, ExecutionRunResumeHandleSchema, ExecutionRunVoiceAgentIntentInputV1Schema } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunStatusSchema, ExecutionRunInputTurnV1Schema, ExecutionRunErrorSchema, ExecutionRunPermissionAttentionSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { PortableRuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { SessionCapabilitySelectionV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { TeamCredentialProviderModelSelectionV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { ExecutionRunState } from './executionRunTypes';
import { RequesterWorkAttributionV1Schema } from '@/daemon/lifecycle/requesterWorkAttribution';
import { AgentSessionToolPolicyShapeV1 } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { FollowPolicyV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { ApprovalProfileIdV1Schema } from '@happier-dev/protocol/actions/approvalProfiles';

/** Private lifecycle custody, independent of the daemon's disposable visibility marker. */
const RetainedRunStateSchema = z.strictObject({
  runId: z.string().check(z.minLength(1)), callId: z.string().check(z.minLength(1)), sidechainId: z.string().check(z.minLength(1)),
  originWorkflowRunId: z.optional(z.string().check(z.minLength(1))),
  sessionId: z.nullable(z.string().check(z.minLength(1))), depth: z.number().check(z.int(), z.nonnegative()),
  intent: ExecutionRunIntentSchema, roleId: z.optional(z.string()), launchProfileId: z.optional(z.string()),
  profileId: z.optional(z.nullable(z.string())), profileSourceCustody: z.optional(z.nullable(PluginSourceCustodyV1Schema)),
  backendTarget: BackendTargetRefSchema, backendId: z.string().check(z.minLength(1)), instructions: z.string(),
  intentInput: z.optional(z.unknown()), display: z.optional(ExecutionRunDisplaySchema),
  permissionMode: z.string().check(z.minLength(1)), workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
  approvalProfileId: z.optional(z.nullable(ApprovalProfileIdV1Schema)),
  retentionPolicy: ExecutionRunRetentionPolicySchema, runClass: ExecutionRunClassSchema, ioMode: ExecutionRunIoModeSchema,
  notifyParentOnCompletion: z.optional(z.boolean()), turnCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  runReportPolicy: z.optional(FollowPolicyV1Schema),
  effectiveEngine: z.optional(z.strictObject({ agentId: z.string().check(z.minLength(1)), modelId: z.optional(z.string()) })),
  launch: z.optional(z.strictObject({
    ...AgentSessionToolPolicyShapeV1,
    selectionSource: z.optional(z.enum(['explicit', 'inherited', 'independent', 'retained'])),
    cwd: z.optional(z.string()), capabilitySelection: z.optional(SessionCapabilitySelectionV1Schema), acpSessionModeId: z.optional(z.string()),
    runtimeDescriptorV1: z.optional(PortableRuntimeDescriptorV1Schema), launchOrigin: z.optional(ExecutionRunLaunchOriginSchema),
    modelId: z.optional(z.string()), modelSelection: z.optional(ProviderBoundModelRefSchema),
    teamCredentialModel: z.optional(TeamCredentialProviderModelSelectionV1Schema),
    sessionConfigOptionOverrides: z.optional(AcpConfigOptionOverridesV1Schema),
    connectedServicesSelection: z.optional(z.nullable(ConnectedServiceBindingsV2Schema)),
    secretReferenceOverlay: z.optional(SecretReferenceOverlayV1Schema),
  })),
  status: ExecutionRunStatusSchema, startedAtMs: z.number().check(z.int(), z.nonnegative()), finishedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  terminalOccurrenceId: z.optional(z.string().check(z.minLength(1))),
  attention: z.optional(ExecutionRunPermissionAttentionSchema),
  error: z.optional(z.strictObject(ExecutionRunErrorSchema.shape)),
  summary: z.optional(z.string()), structuredMeta: z.optional(z.pipe(z.strictObject({ kind: z.string(), payload: z.unknown() }), z.transform((value) => ({ kind: value.kind, payload: value.payload })))),
  latestToolResult: z.optional(z.unknown()),
  inputTurns: z.optional(z.strictObject({ occurrenceId: z.string().check(z.minLength(1)), current: z.optional(ExecutionRunInputTurnV1Schema), last: z.optional(ExecutionRunInputTurnV1Schema) })),
  resumeHandle: z.optional(z.nullable(ExecutionRunResumeHandleSchema)),
  voiceAgentConfig: z.optional(z.strictObject({
    profileId: z.optional(z.nullable(z.string())), chatModelId: z.string(), commitModelId: z.string(),
    chatModelSelection: z.optional(ProviderBoundModelRefSchema), commitModelSelection: z.optional(ProviderBoundModelRefSchema),
    chatTeamCredentialModel: z.optional(TeamCredentialProviderModelSelectionV1Schema),
    commitTeamCredentialModel: z.optional(TeamCredentialProviderModelSelectionV1Schema),
    commitConnectedServices: z.optional(z.nullable(ConnectedServiceBindingsV2Schema)),
    commitIsolation: z.boolean(), permissionIntent: z.enum(PERMISSION_INTENTS), idleTtlSeconds: z.number(),
    initialContext: z.string(), initialContextMode: z.enum(['bootstrap', 'first_turn']), verbosity: z.enum(['short', 'balanced']),
    voicePolicy: ExecutionRunVoiceAgentIntentInputV1Schema.shape.voicePolicy,
    bootstrapTimeoutMs: z.optional(z.number()), disabledActionIds: z.array(z.string()),
    transcript: z.strictObject({ persistenceMode: z.enum(['ephemeral', 'persistent']), epoch: z.number().check(z.int(), z.nonnegative()) }),
  })),
});

export const RetainedExecutionRunRecordSchema = z.strictObject({
  ownerPid: z.number().check(z.int(), z.positive()), ownerProcessStartTimeMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  requesterWorkAttributionV1: z.optional(RequesterWorkAttributionV1Schema),
  /** Original signed admission for requester hints after host loss; sealed with the private record. */
  executionAuthorizationToken: z.optional(z.string().check(z.minLength(1))),
  state: RetainedRunStateSchema,
  /** Stable identity for redelivery if recovery is interrupted after the loss commit. */
  terminalEventId: z.optional(z.string().check(z.minLength(1))),
});
export type RetainedExecutionRunRecord = z.infer<typeof RetainedExecutionRunRecordSchema>;

export function projectRetainedExecutionRunState(run: ExecutionRunState): RetainedExecutionRunRecord['state'] {
  // Materialized auth, transient registrations, Account settings and turn authority
  // are deliberately not restart inputs. Resume re-resolves current material.
  const { runtimeSettings: _settings, requesterWorkAttributionV1: _attribution, projectSetup: _setup,
    executionAuthorization: _authorization, scmComparisonOperations: _comparisonOperations,
    actionInvocation: _invocation, launch, ...state } = run;
  const { connectedServicesRegistration: _registration, connectedServicesSelectionAgent: _agent, ...selection } = launch ?? {};
  return RetainedRunStateSchema.parse({ ...state, ...(launch ? { launch: selection } : {}) });
}

export function projectExecutionRunHostLoss(record: RetainedExecutionRunRecord, nowMs: number): RetainedExecutionRunRecord {
  const run = record.state;
  if (run.status !== 'running') return record;
  const summary = 'Execution host lost; output may be partial. Resume this run if recovery is available.';
  const current = run.inputTurns?.current;
  const terminalOccurrenceId = `host-loss:${run.runId}:${record.ownerProcessStartTimeMs ?? record.ownerPid}:${run.inputTurns?.occurrenceId ?? run.startedAtMs}`;
  return {
    ...record,
    // Replays of this committed loss share custody; a later resumed host's
    // loss is a different observation even before it admits another input.
    terminalEventId: terminalOccurrenceId,
    state: {
      ...run, status: 'failed', finishedAtMs: nowMs, summary, terminalOccurrenceId,
      error: { code: 'execution_run_host_lost', message: summary },
      // A prior successful result is not the result of the interrupted turn.
      latestToolResult: { status: 'failed', runId: run.runId, callId: run.callId, sidechainId: run.sidechainId, errorCode: 'execution_run_host_lost', summary },
      ...(current?.state === 'active' ? { inputTurns: { ...run.inputTurns!, current: { ...current, state: 'failed', result: undefined } } } : {}),
    },
  };
}
