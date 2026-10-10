import { z } from 'zod';
import { isAgentStateRequestCoveredByCompletedRequests, resolveAgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { projectSessionAwarenessV1 } from '@happier-dev/protocol/sessions/awareness/projectV1';
import { resolveAgentRequestKind } from '@happier-dev/protocol/activity/agentRequestSummary';
import { readSessionTerminalControlServiceabilityStateV1 } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { resolveAwarenessCurrentnessV1 } from '@happier-dev/protocol/sessions/awareness/runtime';
import { SessionWorkflowActivityHeadlineV1Schema } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';
import type { AccountEncryptionCurrentnessResponse, ProjectSessionAwarenessV1Input, SessionAwarenessProjectionV1 } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import {
  readSessionPresentationContent,
  readSessionPresentationContentFromMaterial,
  type SessionPresentationContent,
  type SessionTransportEncryptionMaterial,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';

/**
 * The CLI/daemon boundary normalizer for Session awareness.
 *
 * It only NORMALIZES: it asks the incumbent encryption owner what it could actually read, and
 * shapes the V2 row into the projector's typed input. Every semantic decision — working vs
 * background, stale vs offline, ready, locked — stays in the Protocol projector so the CLI, the
 * UI and the server cannot drift.
 *
 * It classifies no content state of its own. `readSessionPresentationContent` returns the
 * metadata AND the typed content evidence together, so there is exactly one place that decides
 * whether an envelope was opened, is still undelivered, needs repair, or was never looked at.
 */

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

const AgentStatePendingEvidenceSchema = z.object({
  requests: z.record(z.string(), z.object({
    tool: z.string().trim().min(1),
    kind: z.unknown().optional(),
  }).passthrough()),
  completedRequests: z.record(z.string(), z.unknown()).nullish(),
}).passthrough();

const requestCoverageOptions = resolveAgentStateRequestCoverageOptions({ kind: 'localPermissionBridge' });

/**
 * The whole Account currentness response travels together on purpose: the mode and the recipient
 * readiness are one Account's facts, and splitting them into separate arguments would let a
 * caller pair the mode of one Account with the readiness of another.
 */
export type CliSessionAwarenessParams = Readonly<{
  credentials: StoredCredentials;
  accountEncryption: AccountEncryptionCurrentnessResponse;
  row: RawSessionListRow;
  nowMs: number;
  agentState?: Readonly<{ value: unknown; observedAtMs: number }>;
}>;

export function buildCliSessionAwarenessInputV1(
  params: CliSessionAwarenessParams,
): ProjectSessionAwarenessV1Input {
  const presentation = readSessionPresentationContent({
    credentials: params.credentials,
    accountEncryptionMode: params.accountEncryption.mode,
    recipientEnvelopeReadiness: params.accountEncryption.recipientEnvelopeReadiness,
    rawSession: params.row,
  });
  return buildCliSessionAwarenessInputFromPresentationV1(params, presentation);
}

function buildCliSessionAwarenessInputFromPresentationV1(
  params: Pick<CliSessionAwarenessParams, 'row' | 'nowMs' | 'agentState'>,
  presentation: SessionPresentationContent,
): ProjectSessionAwarenessV1Input {
  const row = params.row;
  const metadata = presentation.metadata;
  const summary = metadata?.summary && typeof metadata.summary === 'object' && !Array.isArray(metadata.summary)
    ? metadata.summary as Readonly<Record<string, unknown>>
    : null;
  const fork = metadata?.forkV1 && typeof metadata.forkV1 === 'object' && !Array.isArray(metadata.forkV1)
    ? metadata.forkV1 as Readonly<Record<string, unknown>>
    : null;
  const terminal = metadata?.terminal && typeof metadata.terminal === 'object' && !Array.isArray(metadata.terminal)
    ? metadata.terminal as Readonly<Record<string, unknown>>
    : null;
  // The daemon writes control serviceability into the owner metadata this boundary just decrypted,
  // so the CLI forwards the same evidence the UI does; absent or unreadable evidence stays unknown.
  const controlServiceability = readSessionTerminalControlServiceabilityStateV1(terminal?.controlServiceabilityV1);
  const forkParentSessionId = fork?.v === 1 ? readText(fork.parentSessionId) : null;
  const path = readText(metadata?.path);
  const machineId = readText(metadata?.machineId);
  const workflow = SessionWorkflowActivityHeadlineV1Schema.safeParse(metadata?.sessionWorkflowActivityHeadlineV1);

  // V2 active/activeAt are the persisted Session publisher-presence facts also read by
  // the stalled owner. The shared projector still decides freshness, work and readiness.
  const active = readBoolean(row.active);
  const presence = active === null ? 'unknown' : active ? 'online' : 'offline';

  const hasPendingProjection = row.pendingPermissionRequestCount !== undefined
    && row.pendingUserActionRequestCount !== undefined;

  const parsedAgentState = AgentStatePendingEvidenceSchema.safeParse(params.agentState?.value);
  const useAgentState = parsedAgentState.success && params.agentState
    && ((row.pendingPermissionRequestCount === undefined && row.pendingUserActionRequestCount === undefined)
      || params.agentState.observedAtMs > (readNumber(row.pendingRequestObservedAt) ?? 0));
  const requestKinds = useAgentState ? Object.entries(parsedAgentState.data.requests)
    .filter(([requestId, request]) => !isAgentStateRequestCoveredByCompletedRequests({
      requestId, request, completedRequests: parsedAgentState.data.completedRequests, options: requestCoverageOptions,
    }))
    .map(([, request]) => resolveAgentRequestKind({ toolName: request.tool, requestKind: request.kind })) : null;

  const lifecycle = {
    archivedAtMs: readNumber(row.archivedAt),
    // `undefined` (the producer projected no turn status at all) and an explicit `null` are
    // different facts here: the first is absent lifecycle evidence, the second is observed.
    latestTurnStatus: row.latestTurnStatus,
    latestTurnStatusObservedAtMs: readNumber(row.latestTurnStatusObservedAt),
    latestReadyEventSeq: readNumber(row.latestReadyEventSeq),
    latestReadyEventAtMs: readNumber(row.latestReadyEventAt),
    meaningfulActivityAtMs: readNumber(row.meaningfulActivityAt),
  } as const;
  const runtime = {
    presence,
    active,
    lastObservedAtMs: readNumber(row.activeAt),
    thinking: readBoolean(row.thinking),
    thinkingAtMs: readNumber(row.thinkingAt),
    activityState: row.runtimeActivityState ?? null,
    activityActiveCount: readNumber(row.runtimeActivityActiveCount),
    controlServiceability: controlServiceability === 'unknown' ? null : controlServiceability,
  } as const;

  return {
    nowMs: params.nowMs,
    sessionId: row.id.trim(),
    origin: row.origin,
    ...(row.reportsTo !== undefined ? { reportsTo: row.reportsTo } : {}),
    ...(row.reports !== undefined ? { reports: row.reports } : {}),
    ...(row.pendingReviewRuns !== undefined ? { pendingReviewRuns: row.pendingReviewRuns } : {}),
    title: readText(summary?.text) ?? readText(metadata?.name),
    lifecycle,
    runtime,
    pending: {
      hasPendingPermissionRequests: requestKinds ? requestKinds.includes('permission') : (readNumber(row.pendingPermissionRequestCount) ?? 0) > 0,
      hasPendingUserActionRequests: requestKinds ? requestKinds.includes('user_action') : (readNumber(row.pendingUserActionRequestCount) ?? 0) > 0,
      pendingRequestObservedAtMs: useAgentState ? params.agentState?.observedAtMs : readNumber(row.pendingRequestObservedAt),
      queuedInputCount: readNumber(row.pendingCount),
      blockedInputCount: readNumber(row.pendingBlockedCount),
    },
    content: presentation.content,
    ...(forkParentSessionId ? { lineage: { relation: 'fork', sourceSessionId: forkParentSessionId } } : {}),
    work: metadata ? readSessionWorkStateV1FromMetadata(metadata) : null,
    workflowHeadline: workflow.success ? workflow.data : null,
    ...(path || machineId ? { workspace: {
      ...(path ? { path } : {}),
      ...(machineId ? { machineId } : {}),
    } } : {}),
    currentness: resolveAwarenessCurrentnessV1({
      lifecycle,
      runtime,
      // An older producer that projects no pending counts must not read as "nothing pending".
      pending: hasPendingProjection || requestKinds !== null ? 'observed' : 'unavailable',
      // The metadata field is required on the wire, so an empty or unparsable string is
      // admitted and decodes to nothing: the work state is unknown, not absent. Readable
      // metadata carrying no work state stays observed.
      work: metadata ? 'observed' : 'unavailable',
      observedAtMs: readNumber(row.updatedAt),
    }),
  };
}

export function projectCliSessionAwarenessV1(
  params: CliSessionAwarenessParams,
): SessionAwarenessProjectionV1 {
  return projectSessionAwarenessV1(buildCliSessionAwarenessInputV1(params));
}

export function projectCliSessionAwarenessFromMaterialV1(params: Readonly<{
  row: RawSessionListRow;
  material: SessionTransportEncryptionMaterial;
  nowMs: number;
  agentState?: Readonly<{ value: unknown; observedAtMs: number }>;
}>): SessionAwarenessProjectionV1 {
  return projectSessionAwarenessV1(buildCliSessionAwarenessInputFromPresentationV1(
    params,
    readSessionPresentationContentFromMaterial({ rawSession: params.row, material: params.material }),
  ));
}

/** Credential-free projection while an authorized Runner awaits its prepared source key. */
export function projectCliSessionAwarenessUnavailableMaterialV1(params: Readonly<{
  row: RawSessionListRow;
  nowMs: number;
}>): SessionAwarenessProjectionV1 {
  return projectSessionAwarenessV1(buildCliSessionAwarenessInputFromPresentationV1(params, {
    metadata: null,
    content: { mode: 'e2ee', keyState: 'unknown' },
  }));
}
