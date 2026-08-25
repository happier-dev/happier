import type { Metadata } from '@/api/types';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { mergeSessionWorkStateMetadataV1 } from '@/session/workState/sessionWorkStateMetadata';
import { logger } from '@/ui/logger';

import type { Session } from '../session';
import type { RawJSONLines } from '../types';
import { createClaudeRawMessageTurnDiffBridge } from '../utils/createClaudeRawMessageTurnDiffBridge';
import { buildClaudeJsonlMessageKey } from '../utils/claudeJsonlMessageKey';
import { readClaudeJsonlTimestampMs } from '../utils/claudeJsonlTimestamp';
import { isClaudeInternalTranscriptMessage } from '../utils/isClaudeInternalTranscriptMessage';
import { buildClaudeTodoWriteWorkState, createClaudeTaskToolWorkStateTracker } from '../workState/claudeWorkState';
import { createClaudeGoalWorkStateSource } from '../workState/claudeGoalSource';
import {
  CLAUDE_GOAL_WORK_STATE_ITEM_ID,
  CLAUDE_GOAL_WORK_STATE_SOURCE_FAMILY,
} from '../workState/claudeGoalStatus';
import type { ClaudeWorkflowActivitySource } from '../workflows/claudeWorkflowActivitySource';
import { filterWorkflowOwnedWorkStateItems } from '../workflows/claudeWorkflowOwnedWorkState';
import { mapClaudeRateLimitEventToUsageDetails, type NormalizedProviderUsageLimitDetailsV1 } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';
import { surfaceClaudeRateLimitRuntimeIssue } from '../connectedServices/surfaceClaudeRuntimeIssues';
import {
  buildClaudeCompactBoundaryEventIdentity,
  buildClaudeCompactionCompletedEvent,
  buildClaudeCompactionLifecycleId,
  buildClaudeCompactionStartedEvent,
} from '../contextCompactionEvents';
import { applyClaudeEffectiveModelUpdate } from '../sessionModels/effectiveModelUpdate';
import { readClaudeMainChainAssistantModelId } from '../sessionModels/readClaudeMainChainAssistantModelId';

type ClaudeLocalWorkStateSnapshot = ReturnType<typeof buildClaudeTodoWriteWorkState>
  & Readonly<{ ownedSourceFamilies?: readonly string[] }>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The CLAUDE transcript session id for this session, read from the metadata snapshot (set from the
 * Claude `system.session_id`). This — NOT the Happier `session.sessionId` — is what `goal_status`
 * attachments are matched against. May be null early (before the snapshot populates); the goal
 * source then self-learns it from the observed transcript records.
 */
function readClaudeSessionIdFromSession(session: Session): string | null {
  return readString(session.client.getMetadataSnapshot?.()?.claudeSessionId);
}

/**
 * Read the last-published Claude goal work-state item from the session metadata snapshot (G-3/E
 * restart continuity). Returns the `goal:claude` item (with its `status`/`tokensUsed`/`timeUsedSeconds`
 * as persisted) or null when there is no work-state / goal item yet. Best-effort + shape-tolerant: the
 * goal source validates the fields it needs.
 */
function readLastPublishedClaudeGoalItem(
  session: Session,
): Readonly<{ status?: unknown; tokensUsed?: unknown; timeUsedSeconds?: unknown; updatedAt?: unknown }> | null {
  const snapshot = readRecord(session.client.getMetadataSnapshot?.());
  const workState = readRecord(snapshot?.sessionWorkStateV1);
  const items = workState && Array.isArray(workState.items) ? workState.items : null;
  if (!items) return null;
  for (const candidate of items) {
    const item = readRecord(candidate);
    if (item && item.id === CLAUDE_GOAL_WORK_STATE_ITEM_ID) return item;
  }
  return null;
}

type CompactCommandMarkerKind = 'local-command' | 'plain';

function readCompactCommandMarkerKind(message: RawJSONLines): CompactCommandMarkerKind | null {
  const record = message as Record<string, unknown>;
  const nested = readRecord(record.message);
  const content = nested?.content;
  const texts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((entry) => {
        const entryRecord = readRecord(entry);
        const text = readString(entryRecord?.text ?? entryRecord?.content ?? entry);
        return text ? [text] : [];
      })
      : [];
  if (texts.some((text) => text.includes('<command-name>/compact</command-name>'))) return 'local-command';
  if (texts.some((text) => text.trim() === '/compact')) return 'plain';
  return null;
}

function readSystemSubtype(message: RawJSONLines): string | null {
  return message.type === 'system' ? readString((message as Record<string, unknown>).subtype) : null;
}

export function createClaudeSessionTranscriptProjector(params: Readonly<{
  session: Session;
  logPrefix: string;
  /**
   * Centralized Claude Dynamic Workflow ACTIVITY source (CWF2/CWF3/CWF4), wired by the launcher with
   * the session credentials + stored-content encryption it needs for durable `activity/workflow_run.v1`
   * records. The projector feeds it the SAME raw transcript channel that drives the goal source
   * (`observeRaw`), and applies its CWF4 owned-id filter at the work-state merge chokepoint so
   * workflow agents do not ALSO render as top-level task/todo rows. Optional: when absent (e.g. no
   * credentials yet) the goal/work-state path is unchanged.
   */
  workflowActivitySource?: ClaudeWorkflowActivitySource | null;
}>): Readonly<{
  observe(message: RawJSONLines): Promise<void>;
  observeCommitted(message: RawJSONLines): Promise<void>;
  observeRaw(
    value: unknown,
    observation?: Readonly<{ historicalReplay?: boolean }>,
  ): void;
  /**
   * Remove the published Claude goal work-state item (used by the active-session clear effector,
   * since Claude's `/goal clear` emits no `goal_status`). Idempotent.
   */
  clearGoalWorkState(): void;
  /**
   * Record a goal-control SET intent (used by the active-session set effector) so re-setting the same
   * objective after a clear is accepted instead of suppressed as a stale post-clear replay (G2).
   */
  recordGoalSetIntent(): void;
  /** Drain pending workflow-activity writes immediately (turn end / stream close / finalize). No-op without a source. */
  flushWorkflowActivity(): Promise<void>;
  /**
   * The ONE teardown observation for every shutdown-sensitive source this projector owns. Call it
   * from an OBSERVED death (a launcher's graceful teardown) immediately BEFORE
   * `flushWorkflowActivity()`, so the resolved state is what gets drained.
   *
   * - G-6 goal: an active/unmet Claude goal is republished with `statusReason:'interrupted'`
   *   (status stays active — the goal may resume).
   * - RULING-14 workflow activity: every non-terminal run/agent resolves, because the process that
   *   owned them is going away. Without this a run and its agents stay painted live forever.
   *
   * Both sources resolve from ONE call on purpose. They were two calls, one launcher wired only the
   * goal half, and workflow runs on the local + unified-terminal launchers stayed "Working" forever.
   * Happier execution runs are NOT swept: they are owned by the CLI session process, not the
   * provider process, genuinely outlive this teardown, and are not in these sources at all.
   */
  finalizeInterruptedWorkOnShutdown(): void;
  reset(): void;
}> {
  const workflowActivitySource = params.workflowActivitySource ?? null;
  let sendVisibleMessage = (message: RawJSONLines): void => {
    params.session.client.sendClaudeSessionMessage(message);
  };
  const turnDiffBridge = createClaudeRawMessageTurnDiffBridge({
    getSessionId: () => params.session.sessionId ?? params.session.client.sessionId ?? 'unknown',
    sendMessage: (message) => {
      sendVisibleMessage(message);
    },
  });
  const publishWorkStateSnapshot = (snapshot: ClaudeLocalWorkStateSnapshot): void => {
    // CWF4 coherence: a canonical Workflow run's agents live in the durable `activity/workflow_run.v1`
    // record + workflow UI surfaces. Drop any work-state rows the workflow normalizer marked
    // workflow-owned BEFORE the merge, so they do not ALSO render as top-level task/todo rows. The
    // pure filter preserves the snapshot's extra fields (e.g. `ownedSourceFamilies`) and is a no-op
    // when no source is wired or it owns nothing.
    const filtered = (workflowActivitySource
      ? filterWorkflowOwnedWorkStateItems(snapshot, workflowActivitySource.getWorkflowOwnedAgentToolUseIds())
      : snapshot) as ClaudeLocalWorkStateSnapshot;
    // The Claude goal item id (`goal:claude`) is NOT namespaced under its source family, so
    // source-family ownership alone cannot REMOVE it on an empty (clear) snapshot. Declare the goal
    // item id explicitly so a clear (empty goal snapshot) actually drops the existing goal item.
    const ownedItemIds = (filtered.ownedSourceFamilies ?? []).includes(CLAUDE_GOAL_WORK_STATE_SOURCE_FAMILY)
      ? [CLAUDE_GOAL_WORK_STATE_ITEM_ID]
      : undefined;
    updateMetadataBestEffort(
      params.session.client,
      (metadata) => mergeSessionWorkStateMetadataV1({
        metadata,
        nextOwned: filtered,
        ownedSourceFamilies: filtered.ownedSourceFamilies,
        ...(ownedItemIds ? { ownedItemIds } : {}),
      }) as unknown as Metadata,
      params.logPrefix,
      'claude_terminal_work_state',
    );
  };
  const taskToolWorkStateTracker = createClaudeTaskToolWorkStateTracker({
    backendId: 'claude',
    agentId: 'claude',
  });
  // Centralized Claude native `/goal` source (plan H6/H7). The `goal_status`
  // attachment and the system/init `slash_commands` records are control
  // bookkeeping the session scanner DROPS before the post-strip `onMessage`
  // channel (`isClaudeInternalTranscriptMessage` → true for `type:'attachment'`
  // and side-channels `system` rows — the F2 "keep attachments out of the visible
  // transcript" gate). They survive ONLY on the scanner's RAW channel, so the
  // goal source is fed from `observeRaw` (the raw transcript value), NOT from
  // `observe` — which would never see a goal_status anyway. Every Claude launcher
  // wires the raw transcript channel into `observeRaw`, so there is ONE goal-source
  // implementation observing ONE channel, not per-launcher routing.
  const goalWorkStateSource = createClaudeGoalWorkStateSource({
    backendId: 'claude',
    agentId: 'claude',
    publishWorkStateSnapshot: (snapshot) => publishWorkStateSnapshot(snapshot),
    // The CLAUDE transcript session id (NOT the Happier `session.sessionId`) — the goal source
    // matches `goal_status` attachments against it. Null until known; the source then self-learns it
    // from the observed transcript records.
    getCurrentClaudeSessionId: () => readClaudeSessionIdFromSession(params.session),
    logPrefix: params.logPrefix,
  });
  // G-3/E restart continuity: seed the live-usage accumulator from the last-published Claude goal
  // item in metadata (written by folds during the prior run) so a restart continues the running total
  // instead of restarting mid-run usage from zero. The floor survives the transcript replay's
  // re-observation of the same active goal_status.
  goalWorkStateSource.reseedActiveGoalUsageFromPublishedItem(
    readLastPublishedClaudeGoalItem(params.session),
  );
  const maybeProjectWorkState = (message: RawJSONLines): void => {
    const updatedAt = Date.now();
    const messageRecord = readRecord((message as Record<string, unknown>).message);
    const content = Array.isArray(messageRecord?.content) ? messageRecord.content : [];
    for (const blockValue of content) {
      const block = readRecord(blockValue);
      if (block?.type !== 'tool_use' || block.name !== 'TodoWrite') continue;
      const snapshot = buildClaudeTodoWriteWorkState({
        backendId: 'claude',
        updatedAt,
        input: block.input,
      });
      publishWorkStateSnapshot(snapshot);
    }
    const taskSnapshot = taskToolWorkStateTracker.applyMessage(message, updatedAt);
    if (taskSnapshot) {
      publishWorkStateSnapshot(taskSnapshot);
    }
  };
  const surfaceRateLimit = (details: NormalizedProviderUsageLimitDetailsV1): void => {
    void surfaceClaudeRateLimitRuntimeIssue(params.session, details, params.logPrefix).catch((error) => {
      logger.debug(`${params.logPrefix}: failed to surface Claude rate-limit runtime issue`, error);
    });
  };
  // Terminal-hosted Claude (unified/local) has no SDK system-message stream, so the transcript is
  // the only place the EFFECTIVE model id is visible. Mirroring the SDK launcher's
  // `runtime_model_update` adoption keeps session models metadata (and therefore UI context-window
  // resolution) correct for terminal sessions.
  const maybeAdoptEffectiveModel = (message: RawJSONLines): void => {
    const modelId = readClaudeMainChainAssistantModelId(message);
    if (!modelId) return;
    applyClaudeEffectiveModelUpdate({
      client: params.session.client,
      modelId,
      source: 'transcript',
      logPrefix: params.logPrefix,
    });
  };
  let compactionSequence = 0;
  let activeCompactionLifecycleId: string | null = null;
  let suppressNextLocalCommandCompactStart = false;
  const nextCompactionLifecycleId = (): string => buildClaudeCompactionLifecycleId({
    sessionId: params.session.sessionId ?? params.session.client.sessionId,
    sequence: ++compactionSequence,
  });
  const maybeEmitCompactionEvents = (message: RawJSONLines): void => {
    if (readSystemSubtype(message) === 'compact_boundary') {
      const messageRecord = message as Record<string, unknown>;
      const providerSessionId = readString(messageRecord.session_id);
      const providerEventId = buildClaudeCompactBoundaryEventIdentity({
        providerSessionId,
        uuid: readString(messageRecord.uuid),
        timestamp: readString(messageRecord.timestamp),
      });
      const lifecycleId = activeCompactionLifecycleId ?? providerEventId ?? nextCompactionLifecycleId();
      activeCompactionLifecycleId = null;
      suppressNextLocalCommandCompactStart = true;
      params.session.client.sendSessionEvent(buildClaudeCompactionCompletedEvent({
        lifecycleId,
        source: 'provider-event',
        ...(providerEventId ? { providerEventId } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
      }));
      return;
    }

    const compactCommandMarkerKind = readCompactCommandMarkerKind(message);
    if (!compactCommandMarkerKind) return;
    if (compactCommandMarkerKind === 'local-command' && suppressNextLocalCommandCompactStart) {
      suppressNextLocalCommandCompactStart = false;
      return;
    }
    suppressNextLocalCommandCompactStart = false;
    if (activeCompactionLifecycleId !== null) return;
    activeCompactionLifecycleId = nextCompactionLifecycleId();
    params.session.client.sendSessionEvent(buildClaudeCompactionStartedEvent({
      lifecycleId: activeCompactionLifecycleId,
    }));
  };

  const observeWithVisibleSender = (
    message: RawJSONLines,
    sender: (visibleMessage: RawJSONLines) => void,
    options?: Readonly<{ historicalReplay?: boolean }>,
  ): void => {
      const previousSender = sendVisibleMessage;
      sendVisibleMessage = sender;
      try {
      if (options?.historicalReplay !== true) {
        maybeAdoptEffectiveModel(message);
        maybeProjectWorkState(message);
        maybeEmitCompactionEvents(message);
        const rateLimitDetails = mapClaudeRateLimitEventToUsageDetails(message);
        if (rateLimitDetails) surfaceRateLimit(rateLimitDetails);
      }
      if (isClaudeInternalTranscriptMessage(message)) {
        return;
      }
      const bridged = turnDiffBridge.observe(message);
      if (bridged) {
        sendVisibleMessage(bridged);
        turnDiffBridge.flushAfterForwardIfNeeded();
      }
      } finally {
        sendVisibleMessage = previousSender;
      }
  };

  return {
    async observe(message) {
      const commits: Promise<void>[] = [];
      observeWithVisibleSender(message, (visibleMessage) => {
        const commit = params.session.client.sendClaudeSessionMessageCommittedExact;
        if (!commit) {
          throw new Error('Claude live transcript ordering requires exact committed custody');
        }
        commits.push(commit.call(params.session.client, visibleMessage));
      });
      await Promise.all(commits);
    },
    async observeCommitted(message) {
      if (!buildClaudeJsonlMessageKey(message)) {
        logger.debug(`${params.logPrefix}: skipped historical Claude transcript row without trustworthy provider identity`, {
          type: message.type,
        });
        return;
      }
      const sourceTimestampMs = readClaudeJsonlTimestampMs(message);
      if (sourceTimestampMs === null) {
        logger.debug(`${params.logPrefix}: skipped historical Claude transcript row without trustworthy source chronology`, {
          type: message.type,
          uuid: readString((message as Record<string, unknown>).uuid),
        });
        return;
      }
      const commits: Promise<unknown>[] = [];
      observeWithVisibleSender(message, (visibleMessage) => {
        const commit = params.session.client.sendClaudeSessionMessageCommitted;
        if (!commit) {
          throw new Error('Claude transcript committed-custody transport is unavailable');
        }
        const visibleTimestampMs = readClaudeJsonlTimestampMs(visibleMessage) ?? sourceTimestampMs;
        commits.push(commit.call(params.session.client, visibleMessage, {
          createdAt: visibleTimestampMs,
          updatedAt: visibleTimestampMs,
          provenance: { kind: 'non_dependent', source: 'history' },
        }).then((result) => {
          if (!result.persisted) {
            throw new Error('Claude historical transcript observation did not reach durable custody');
          }
        }));
      }, { historicalReplay: true });
      await Promise.all(commits);
    },
    // Raw transcript channel (plan H7): the scanner forwards every parsed JSONL
    // value here BEFORE its visible-transcript filtering, so `attachment`
    // (`goal_status`) and `system` (`slash_commands`) records — dropped from
    // `observe` — reach the goal source. `routeClaudeAttachment` + the source
    // already tolerate raw objects. This NEVER emits to the visible transcript.
    observeRaw(value, observation) {
      goalWorkStateSource.observeTranscriptMessage(value);
      // The Claude workflow ACTIVITY source rides the SAME raw transcript channel as the goal source
      // (workflow `task_started`/`task_progress`/`task_completed` rows). One wiring, one channel.
      workflowActivitySource?.observeTranscriptMessage(value, observation);
    },
    clearGoalWorkState() {
      goalWorkStateSource.clearGoalWorkState();
    },
    recordGoalSetIntent() {
      goalWorkStateSource.recordGoalSetIntent();
    },
    finalizeInterruptedWorkOnShutdown() {
      goalWorkStateSource.finalizeInterruptedGoalOnShutdown();
      if (!workflowActivitySource) return;
      try {
        workflowActivitySource.finalizeInterruptedActivityOnShutdown();
      } catch (error) {
        logger.debug(`${params.logPrefix}: failed to resolve interrupted Claude workflow activity (non-fatal)`, error);
      }
    },
    async flushWorkflowActivity() {
      if (!workflowActivitySource) return;
      try {
        await workflowActivitySource.flush();
      } catch (error) {
        logger.debug(`${params.logPrefix}: failed to flush Claude workflow activity (non-fatal)`, error);
      }
    },
    reset() {
      turnDiffBridge.reset();
      // Stop scheduling pending workflow-activity writes on session teardown/reset.
      workflowActivitySource?.dispose();
    },
  };
}
