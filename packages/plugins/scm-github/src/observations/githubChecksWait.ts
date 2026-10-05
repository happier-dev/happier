import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { GITHUB_CHECKS_SNAPSHOT_SCHEMA } from '../githubAutomationEvents.js';
import { requireGithubAccountStorage } from '../requiredAccountStorage.js';
import { GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION, isGithubAutomationEventCheckpointRowV1 } from './githubAutomationEventCheckpoint.js';
import { githubChecksSourceInstanceId, isGithubChecksEvent, readGithubChecksSnapshot } from './githubChecksSource.js';
import { readCurrentGithubAutomationEventSource } from '../githubAutomationEventActions.js';
import type { GithubChecksConditionSnapshotV1 } from '../triage/checksCondition.js';

export const GITHUB_CHECKS_WAIT_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    sourceId: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    condition: { type: 'string', enum: ['checks_complete', 'checks_passed'] },
    timeoutMs: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  }, required: ['sourceId', 'condition'],
} satisfies PluginJsonSchema;
export const GITHUB_CHECKS_WAIT_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    disposition: { type: 'string', enum: ['matched', 'observation_timeout', 'cancelled', 'target_unavailable', 'permission_denied', 'disconnected'] },
    snapshot: GITHUB_CHECKS_SNAPSHOT_SCHEMA,
  }, required: ['disposition'],
} satisfies PluginJsonSchema;
export type GithubChecksWaitResultV1 = Readonly<{
  disposition: 'matched' | 'observation_timeout' | 'cancelled' | 'target_unavailable' | 'permission_denied' | 'disconnected';
  snapshot?: GithubChecksConditionSnapshotV1;
}>;

export async function waitGithubChecksSource(input: unknown, context: PluginInvocationContext): Promise<GithubChecksWaitResultV1> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const raw = input as Readonly<Record<string, unknown>>;
  if (Object.keys(raw).some((key) => !['sourceId', 'condition', 'timeoutMs'].includes(key))
    || typeof raw.sourceId !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(raw.sourceId)
    || (raw.condition !== 'checks_complete' && raw.condition !== 'checks_passed')
    || (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== 'number' || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 0))) throw invalid();
  if (context.signal.aborted) return { disposition: 'cancelled' };
  const collection = requireGithubAccountStorage(context).collection(GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION);
  const deadline = typeof raw.timeoutMs === 'number' ? Date.now() + raw.timeoutMs : null;
  const observer = new AbortController();
  const observationContext = { ...context, signal: observer.signal };
  let deadlineReached = false;
  let snapshot: GithubChecksConditionSnapshotV1 | undefined;
  let generation = 0;
  let resolveWake: (() => void) | null = null;
  const wake = () => { generation += 1; resolveWake?.(); resolveWake = null; };
  let subscription: ReturnType<typeof collection.watch> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = (disposition: GithubChecksWaitResultV1['disposition']): GithubChecksWaitResultV1 => ({ disposition, ...(snapshot ? { snapshot } : {}) });
  const cancel = () => { observer.abort(context.signal.reason); wake(); };
  const armDeadline = () => {
    if (deadline === null) return;
    // Signed 32-bit timer delay is a platform boundary, not an observation cap.
    timer = setTimeout(() => {
      if (Date.now() < deadline) { armDeadline(); return; }
      deadlineReached = true;
      observer.abort();
      wake();
    }, Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647));
  };
  try {
    context.signal.addEventListener('abort', cancel, { once: true });
    armDeadline();
    while (true) {
      if (context.signal.aborted) return result('cancelled');
      if (deadlineReached) return result('observation_timeout');
      const beforeRead = generation;
      const row = await collection.get(raw.sourceId, { signal: observer.signal });
      if (context.signal.aborted) return result('cancelled');
      if (deadlineReached) return result('observation_timeout');
      if (!row || row.rowId !== raw.sourceId || !isGithubAutomationEventCheckpointRowV1(row.value) || !isGithubChecksEvent(row.value['event-local-id'])) return result('target_unavailable');
      const source = await readCurrentGithubAutomationEventSource({ context: observationContext, selector: {
        automationId: row.value['automation-id'], triggerId: row.value['trigger-id'], sourceSelectorId: row.value['source-selector-id'],
        triggerRevision: row.value.payload.lastEvaluatedTriggerRevision,
      } });
      if (context.signal.aborted) return result('cancelled');
      if (deadlineReached) return result('observation_timeout');
      if (!source || source.definition.eventRef.localId !== row.value['event-local-id']
        || source.definition.sourceInstanceId !== row.value.payload.sourceInstanceId) return result('target_unavailable');
      const cursor = readJsonRecord(row.value.payload.cursor);
      const continuity = readJsonRecord(row.value.payload.continuity);
      if (!cursor || cursor.kind !== 'pullRequestChecks' || cursor.v !== 1
        || !continuity || continuity.endpointKind !== 'pullRequestChecks' || typeof continuity.repositoryId !== 'string') return result('target_unavailable');
      snapshot = readGithubChecksSnapshot(cursor.snapshot) ?? undefined;
      if (!snapshot || row.value.payload.sourceInstanceId !== githubChecksSourceInstanceId(continuity.repositoryId, snapshot)) return result('target_unavailable');
      if (snapshot.failure?.class === 'permission' || snapshot.failure?.class === 'authentication') return result('permission_denied');
      if (snapshot.state === 'superseded' || snapshot.state === 'unknown') return result('target_unavailable');
      if (context.signal.aborted) return result('cancelled');
      if (raw.condition === 'checks_complete' ? snapshot.complete : snapshot.passed) return result('matched');
      if (deadline !== null && Date.now() >= deadline) return result('observation_timeout');
      if (!subscription) {
        subscription = collection.watch({ index: 'by-automation-event-source', order: 'asc',
          prefix: [row.value['trigger-id'], row.value['event-plugin-id'], row.value['event-local-id'], row.value['source-selector-id']],
        }, wake);
        continue; // Arm, then re-read to close the initial registration race.
      }
      if (generation !== beforeRead) continue;
      await new Promise<void>((resolve) => {
        resolveWake = resolve;
        if (context.signal.aborted || deadlineReached || generation !== beforeRead) wake();
      });
    }
  } catch (error) {
    if (context.signal.aborted) return result('cancelled');
    if (deadlineReached) return result('observation_timeout');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    context.signal.removeEventListener('abort', cancel);
    observer.abort();
    await subscription?.dispose();
  }
}
function invalid() {
  return new PluginError({ code: 'github_checks_wait_input_invalid', message: 'Choose an admitted checks source and condition.' });
}

/** A JSON object (not an array): the native compiler does not narrow readonly JSON arrays out through `Array.isArray`. */
function readJsonRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}
