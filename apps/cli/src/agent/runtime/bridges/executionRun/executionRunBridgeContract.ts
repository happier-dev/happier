import type {
  ExecutionRunListRequest,
  ExecutionRunInputTurnV1,
  ExecutionRunPublicState,
  ExecutionRunResultContractV1,
  SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';

export type ExecutionRunObservedInputTurn = Readonly<{
  occurrenceId: string;
  turn: ExecutionRunInputTurnV1;
}>;

export type ExecutionRunHistoryDeleteResult =
  | Readonly<{ success: true }>
  | Readonly<{ ok: false; errorCode: 'session_absent' | 'session_active'; error: string }>;

import type {
  ExecutionRunActionParams,
  ExecutionRunActionResult,
  ExecutionRunManagerStartParams,
  ExecutionRunStartResult,
  ExecutionRunState,
} from './executionRunTypes';
import type { ExecutionRunUserTranscriptDirective } from '@happier-dev/protocol';
import type { AgentStartupFailureDetails } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { ExecutionRunParentSessionPermissionResponseTarget } from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import type { RuntimePermissionResponseOutcome } from './executionRunHostRuntime';
import type { ExecutionRunPermissionRequestStore } from './executionRunPermissionResponseTarget';
import type { RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import type { ExecutionRunPermissionRespondInputSchema } from '@happier-dev/protocol/actions/specs/executionRuns';

type WithoutRunId<Input> = Input extends unknown ? Omit<Input, 'runId'> : never;
export type ExecutionRunPermissionCompletionInput = WithoutRunId<ReturnType<typeof ExecutionRunPermissionRespondInputSchema.parse>>;

export type ExecutionRunPermissionResponseBridgeResult =
  | Readonly<{ ok: true; delivery: RuntimePermissionResponseOutcome }>
  | Readonly<{
      ok: false;
      errorCode?: string;
      error?: string;
      delivery?: RuntimePermissionResponseOutcome;
    }>;

/**
 * Canonical live execution-run host-bridge surface. This is the concrete owner that superseded
 * the plan-only `AgentExecutionRunRuntimeBridge` noun.
 */
export interface ExecutionRunHostBridgeContract {
  waitForOutput(runId: string, observation: import('@happier-dev/protocol/reviews/reviewNarration').ExecutionRunOutputObservation, signal?: AbortSignal): Promise<void>;
  recoverRetainedRuns(): Promise<void>;
  get(runId: string): ExecutionRunState | null;
  getForRequest(runId: string, scopeSessionId: string | null, requester: RequesterWorkAttributionV1 | undefined): Promise<ExecutionRunState | null>;
  deleteForRequest(runId: string, requester: RequesterWorkAttributionV1 | undefined): Promise<ExecutionRunHistoryDeleteResult>;
  hasAttachedRun(runId: string): boolean;
  projectPublicState(run: ExecutionRunState): ExecutionRunPublicState;
  getRunningCount(): number;
  getStructuredMeta(runId: string): { kind: string; payload: unknown } | null;
  getLatestToolResult(runId: string): unknown | null;
  waitForTerminal(runId: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<void>;
  waitForRunStateChange(runId: string, signal?: AbortSignal): Promise<void>;
  waitForInputTurn(
    runId: string,
    localInputId: string,
    signal?: AbortSignal,
  ): Promise<ExecutionRunObservedInputTurn | null>;
  rebindWorkflowInputPermissionRequestStore(runId: string, params: Readonly<{
    workflowRunId: string;
    localInputId: string;
    store: ExecutionRunPermissionRequestStore;
  }>): boolean;
  getPublic(runId: string): ExecutionRunPublicState | null;
  listPublic(): readonly ExecutionRunPublicState[];
  listPublicForRequest(
    request: ExecutionRunListRequest,
    scopeSessionId: string | null,
    requester?: RequesterWorkAttributionV1,
  ): readonly ExecutionRunPublicState[] | null;
  getDepthByRunId(runId: string): number | null;
  getDepthByCallId(callId: string, scopeSessionId?: string | null): number | null;
  start(params: ExecutionRunManagerStartParams): Promise<ExecutionRunStartResult>;
  send(
    runId: string,
    params: Readonly<{
      message: string;
      resume?: boolean;
      delivery?: unknown;
      localInputId?: string;
      resultContract?: ExecutionRunResultContractV1;
      structuredInput?: import('@happier-dev/protocol').HappierStructuredInputV1;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
      effectiveCallerPermissionMode?: string;
      signal?: AbortSignal;
      /** Host-private exact-input interaction target; never an RPC field. */
      permissionRequestStore?: ExecutionRunPermissionRequestStore;
    }>,
  ): Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  ensure(
    runId: string,
    params: Readonly<{ actionInvocation?: ExecutionRunState['actionInvocation']; resume?: boolean; signal?: AbortSignal; causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1 }>,
  ): Promise<{ ok: boolean; actionInvocation?: ExecutionRunState['actionInvocation']; errorCode?: string; error?: string; details?: AgentStartupFailureDetails }>;
  ensureOrStart(params: Readonly<{
    runId?: string | null;
    start?: ExecutionRunManagerStartParams;
    resume?: boolean;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  }>): Promise<
    | { ok: true; runId: string; created: false }
    | (ExecutionRunStartResult & { ok: true; created: true })
    | { ok: false; errorCode?: string; error: string; details?: AgentStartupFailureDetails }
  >;
  startTurnStream(
    runId: string,
    params: Readonly<{
      message: string;
      displayMessage?: string;
      speechSegmentTargetChars?: number;
      resume?: boolean;
      userTranscript?: ExecutionRunUserTranscriptDirective;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    }>,
  ): Promise<{ ok: true; streamId: string } | { ok: false; errorCode: string; error: string }>;
  readTurnStream(
    runId: string,
    params: Readonly<{ streamId: string; cursor: number; maxEvents?: number; waitForEvents?: boolean; signal?: AbortSignal }>,
  ): Promise<
    | ({ ok: true } & Omit<import('@/agent/voice/agent/voiceAgentTypes').VoiceAgentTurnStreamReadResult, 'terminalEvent'>)
    | { ok: false; errorCode: string; error: string }
  >;
  cancelTurnStream(
    runId: string,
    params: Readonly<{ streamId: string }>,
  ): Promise<{ ok: true } | { ok: false; errorCode: string; error: string }>;
  commitUserTranscript?(
    runId: string,
    params: Readonly<{ text: string; displayText?: string; localId: string }>,
  ): Promise<{ ok: true } | { ok: false; errorCode: string; error: string }>;
  stop(runId: string): Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  cancelCurrentTurn(runId: string, params: Readonly<{ occurrenceId: string; turnId: string }>): Promise<import('@happier-dev/protocol').ExecutionRunCancelTurnResponse>;
  dispose?(): Promise<void>;
  respondToPermissionRequest(
    runId: string,
    params: Readonly<{
      requestId: string;
      approved: boolean;
      response?: import('@/agent/permissions/BasePermissionHandler').PermissionResult;
      responseTarget?: ExecutionRunParentSessionPermissionResponseTarget | null;
    }>,
  ): Promise<ExecutionRunPermissionResponseBridgeResult>;
  completePermissionRequest(
    runId: string,
    params: ExecutionRunPermissionCompletionInput,
  ): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>>;
  applyAction(
    runId: string,
    params: ExecutionRunActionParams,
    opts?: Readonly<{
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
      effectiveCallerPermissionMode?: string;
      projectLaunchContext?: import('@/agent/runtime/registry/engineRegistryTypes').ExecutionRunProjectLaunchContext;
      agentStartContext?: import('@happier-dev/protocol/account/settings/admitAgentStartV1').AgentStartContextV1;
      resolveAccountSettingsSnapshot?: import('@/settings/accountSettings/activeAccountSettingsSnapshot').AccountSettingsSnapshotResolver;
    }>,
  ): Promise<ExecutionRunActionResult>;
}

/** Ingress can project an admitted record, but cannot read the host's unscoped store. */
export type ExecutionRunRequestBridgeContract<T extends ExecutionRunHostBridgeContract = ExecutionRunHostBridgeContract> = Omit<T,
  'get' | 'getPublic' | 'listPublic' | 'getStructuredMeta' | 'getLatestToolResult' | 'getDepthByRunId' | 'getDepthByCallId'>;
