import { z } from 'zod';
import { PERMISSION_INTENTS } from '@happier-dev/agents';
import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { BackendTargetRefSchema } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { ExecutionRunClassSchema, ExecutionRunIntentSchema, ExecutionRunIoModeSchema, ExecutionRunRetentionPolicySchema } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { ExecutionRunDisplaySchema, ExecutionRunLaunchOriginSchema, ExecutionRunResumeHandleSchema, ExecutionRunVoiceAgentIntentInputV1Schema } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunStatusSchema, ExecutionRunInputTurnV1Schema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { PortableRuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { TeamCredentialProviderModelSelectionV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { ExecutionRunState } from './executionRunTypes';
import { RequesterWorkAttributionV1Schema } from '@/daemon/lifecycle/requesterWorkAttribution';

/** Private lifecycle custody, independent of the daemon's disposable visibility marker. */
const RetainedRunStateSchema = z.object({
  runId: z.string().min(1), callId: z.string().min(1), sidechainId: z.string().min(1),
  originWorkflowRunId: z.string().min(1).optional(),
  sessionId: z.string().min(1).nullable(), depth: z.number().int().nonnegative(),
  intent: ExecutionRunIntentSchema, roleId: z.string().optional(), launchProfileId: z.string().optional(),
  profileId: z.string().nullable().optional(), profileSourceCustody: PluginSourceCustodyV1Schema.nullable().optional(),
  backendTarget: BackendTargetRefSchema, backendId: z.string().min(1), instructions: z.string(),
  intentInput: z.unknown().optional(), display: ExecutionRunDisplaySchema.optional(),
  permissionMode: z.string().min(1), workspaceWrites: z.enum(['allow', 'deny']).optional(),
  retentionPolicy: ExecutionRunRetentionPolicySchema, runClass: ExecutionRunClassSchema, ioMode: ExecutionRunIoModeSchema,
  notifyParentOnCompletion: z.boolean().optional(), turnCount: z.number().int().nonnegative().optional(),
  effectiveEngine: z.object({ agentId: z.string().min(1), modelId: z.string().optional() }).strict().optional(),
  launch: z.object({
    selectionSource: z.enum(['explicit', 'inherited', 'independent', 'retained']).optional(),
    cwd: z.string().optional(), mcpSelection: SessionMcpSelectionV1Schema.optional(), acpSessionModeId: z.string().optional(),
    runtimeDescriptorV1: PortableRuntimeDescriptorV1Schema.optional(), launchOrigin: ExecutionRunLaunchOriginSchema.optional(),
    modelId: z.string().optional(), modelSelection: ProviderBoundModelRefSchema.optional(),
    teamCredentialModel: TeamCredentialProviderModelSelectionV1Schema.optional(),
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
    connectedServicesSelection: ConnectedServiceBindingsV2Schema.nullable().optional(),
    secretReferenceOverlay: SecretReferenceOverlayV1Schema.optional(),
  }).strict().optional(),
  status: ExecutionRunStatusSchema, startedAtMs: z.number().int().nonnegative(), finishedAtMs: z.number().int().nonnegative().optional(),
  error: z.object({ code: z.string().min(1), message: z.string().optional() }).strict().optional(),
  summary: z.string().optional(), structuredMeta: z.object({ kind: z.string(), payload: z.unknown() }).strict()
    .transform((value) => ({ kind: value.kind, payload: value.payload })).optional(),
  latestToolResult: z.unknown().optional(),
  inputTurns: z.object({ occurrenceId: z.string().min(1), current: ExecutionRunInputTurnV1Schema.optional(), last: ExecutionRunInputTurnV1Schema.optional() }).strict().optional(),
  resumeHandle: ExecutionRunResumeHandleSchema.nullable().optional(),
  voiceAgentConfig: z.object({
    profileId: z.string().nullable().optional(), chatModelId: z.string(), commitModelId: z.string(),
    chatModelSelection: ProviderBoundModelRefSchema.optional(), commitModelSelection: ProviderBoundModelRefSchema.optional(),
    commitConnectedServices: ConnectedServiceBindingsV2Schema.nullable().optional(),
    commitIsolation: z.boolean(), permissionIntent: z.enum(PERMISSION_INTENTS), idleTtlSeconds: z.number(),
    initialContext: z.string(), initialContextMode: z.enum(['bootstrap', 'first_turn']), verbosity: z.enum(['short', 'balanced']),
    voicePolicy: ExecutionRunVoiceAgentIntentInputV1Schema.shape.voicePolicy,
    bootstrapTimeoutMs: z.number().optional(), disabledActionIds: z.array(z.string()),
    transcript: z.object({ persistenceMode: z.enum(['ephemeral', 'persistent']), epoch: z.number().int().nonnegative() }).strict(),
  }).strict().optional(),
}).strict();

export const RetainedExecutionRunRecordSchema = z.object({
  ownerPid: z.number().int().positive(), ownerProcessStartTimeMs: z.number().int().nonnegative().optional(),
  requesterWorkAttributionV1: RequesterWorkAttributionV1Schema.optional(),
  state: RetainedRunStateSchema,
  /** Stable identity for redelivery if recovery is interrupted after the loss commit. */
  terminalEventId: z.string().min(1).optional(),
}).strict();
export type RetainedExecutionRunRecord = z.infer<typeof RetainedExecutionRunRecordSchema>;

export function projectRetainedExecutionRunState(run: ExecutionRunState): RetainedExecutionRunRecord['state'] {
  // Materialized auth, transient registrations, Account settings and turn authority
  // are deliberately not restart inputs. Resume re-resolves current material.
  const { runtimeSettings: _settings, requesterWorkAttributionV1: _attribution, launch, ...state } = run;
  const { connectedServicesRegistration: _registration, connectedServicesSelectionAgent: _agent, ...selection } = launch ?? {};
  return RetainedRunStateSchema.parse({ ...state, ...(launch ? { launch: selection } : {}) });
}

export function projectExecutionRunHostLoss(record: RetainedExecutionRunRecord, nowMs: number): RetainedExecutionRunRecord {
  const run = record.state;
  if (run.status !== 'running') return record;
  const summary = 'Execution host lost; output may be partial. Resume this run if recovery is available.';
  const current = run.inputTurns?.current;
  return {
    ...record,
    // Replays of this committed loss share custody; a later resumed host's
    // loss is a different observation even before it admits another input.
    terminalEventId: `host-loss:${run.runId}:${record.ownerProcessStartTimeMs ?? record.ownerPid}:${run.inputTurns?.occurrenceId ?? run.startedAtMs}`,
    state: {
      ...run, status: 'failed', finishedAtMs: nowMs, summary,
      error: { code: 'execution_run_host_lost', message: summary },
      // A prior successful result is not the result of the interrupted turn.
      latestToolResult: { status: 'failed', runId: run.runId, callId: run.callId, sidechainId: run.sidechainId, errorCode: 'execution_run_host_lost', summary },
      ...(current?.state === 'active' ? { inputTurns: { ...run.inputTurns!, current: { ...current, state: 'failed', result: undefined } } } : {}),
    },
  };
}
