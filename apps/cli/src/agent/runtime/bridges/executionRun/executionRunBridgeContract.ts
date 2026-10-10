import type {
  ExecutionRunListRequest,
  ExecutionRunInputTurnV1,
  ExecutionRunPublicState,
  ExecutionRunResultContractV1,
  SessionInputCausalPermissionAuthorityV1,
  StructuredQuestionAnswersV1,
} from '@happier-dev/protocol';

export type ExecutionRunObservedInputTurn = Readonly<{
  occurrenceId: string;
  turn: ExecutionRunInputTurnV1;
}>;

import type {
  ExecutionRunActionParams,
  ExecutionRunActionResult,
  ExecutionRunManagerStartParams,
  ExecutionRunStartResult,
  ExecutionRunState,
} from './executionRunTypes';
import type { ExecutionRunUserTranscriptDirective } from '@happier-dev/protocol';
import type { ExecutionRunParentSessionPermissionResponseTarget } from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import type { RuntimePermissionResponseOutcome } from './executionRunHostRuntime';
import type { ExecutionRunPermissionRequestStore } from './executionRunPermissionResponseTarget';

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
  waitForOutput(runId: string, observation: import('@happier-dev/protocol').ReviewWalkthroughObservation, signal?: AbortSignal): Promise<void>;
  recoverRetainedRuns(): Promise<void>;
  get(runId: string): ExecutionRunState | null;
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
  getPublic(runId: string): ExecutionRunPublicState | null;
  listPublic(): readonly ExecutionRunPublicState[];
  listPublicForRequest(
    request: ExecutionRunListRequest,
    scopeSessionId?: string | null,
  ): readonly ExecutionRunPublicState[];
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
      signal?: AbortSignal;
      /** Host-private exact-input interaction target; never an RPC field. */
      permissionRequestStore?: ExecutionRunPermissionRequestStore;
    }>,
  ): Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  ensure(
    runId: string,
    params: Readonly<{ resume?: boolean; causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1 }>,
  ): Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  ensureOrStart(params: Readonly<{
    runId?: string | null;
    start?: ExecutionRunManagerStartParams;
    resume?: boolean;
    causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  }>): Promise<
    | { ok: true; runId: string; created: false }
    | (ExecutionRunStartResult & { ok: true; created: true })
    | { ok: false; errorCode?: string; error: string }
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
    | { ok: true; streamId: string; events: any[]; nextCursor: number; done: boolean }
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
      responseTarget?: ExecutionRunParentSessionPermissionResponseTarget | null;
    }>,
  ): Promise<ExecutionRunPermissionResponseBridgeResult>;
  completePermissionRequest(
    runId: string,
    params:
      | Readonly<{ requestId: string; approved: boolean }>
      | Readonly<{ requestId: string; answers: StructuredQuestionAnswersV1 }>,
  ): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>>;
  applyAction(
    runId: string,
    params: ExecutionRunActionParams,
    opts?: Readonly<{
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
      effectiveCallerPermissionMode?: string;
    }>,
  ): Promise<ExecutionRunActionResult>;
}
