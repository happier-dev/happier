import type { ExecutionRunListRequest, ExecutionRunPublicState } from '@happier-dev/protocol';

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
  get(runId: string): ExecutionRunState | null;
  getRunningCount(): number;
  getStructuredMeta(runId: string): { kind: string; payload: unknown } | null;
  getLatestToolResult(runId: string): unknown | null;
  waitForTerminal(runId: string): Promise<void>;
  getPublic(runId: string): ExecutionRunPublicState | null;
  listPublic(): readonly ExecutionRunPublicState[];
  listPublicForRequest(request: ExecutionRunListRequest): readonly ExecutionRunPublicState[];
  getDepthByRunId(runId: string): number | null;
  getDepthByCallId(callId: string): number | null;
  start(params: ExecutionRunManagerStartParams): Promise<ExecutionRunStartResult>;
  send(
    runId: string,
    params: Readonly<{ message: string; resume?: boolean; delivery?: unknown }>,
  ): Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  ensure(runId: string, params: Readonly<{ resume?: boolean }>): Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  ensureOrStart(params: Readonly<{
    runId?: string | null;
    start?: ExecutionRunManagerStartParams;
    resume?: boolean;
  }>): Promise<
    | { ok: true; runId: string; created: boolean }
    | { ok: false; errorCode?: string; error: string }
  >;
  startTurnStream(
    runId: string,
    params: Readonly<{
      message: string;
      displayMessage?: string;
      resume?: boolean;
      userTranscript?: ExecutionRunUserTranscriptDirective;
    }>,
  ): Promise<{ ok: true; streamId: string } | { ok: false; errorCode: string; error: string }>;
  readTurnStream(
    runId: string,
    params: Readonly<{ streamId: string; cursor: number; maxEvents?: number }>,
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
  dispose?(): Promise<void>;
  respondToPermissionRequest(
    runId: string,
    params: Readonly<{
      requestId: string;
      approved: boolean;
      responseTarget?: ExecutionRunParentSessionPermissionResponseTarget | null;
    }>,
  ): Promise<ExecutionRunPermissionResponseBridgeResult>;
  applyAction(runId: string, params: ExecutionRunActionParams): Promise<ExecutionRunActionResult>;
}
