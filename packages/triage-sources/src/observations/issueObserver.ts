import { computeCanonicalDomainSeparatedDigest, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginCheckpointedEventSourceAdapterV1, PluginCheckpointedEventSourceCatalogV1 } from '@happier-dev/plugin-sdk/background-services';
import { PluginEventAutomationHistoryGapResetActionInputV1Schema,
  type PluginEventAutomationHistoryGapResetActionResultV1, type PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import {
  buildTriageEntryRouteSegmentV1, TriageScanResultV1Schema,
  type TriageEntryRefV1, type TriageScanInputV1, type TriageScanResultV1,
  type TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';
import {
  deriveTriageConfiguredSourceInstanceDigestV1, readCurrentTriageConfiguredSourceInstanceV1,
} from '../authorization/configuredSourceCurrentness.js';
import {
  TriageIssueEventSourceConfigV1Schema, TriageIssueTransitionV1Schema,
  TRIAGE_ISSUE_DEFAULT_CHECK_PERIOD_MS_V1,
  TRIAGE_ISSUE_EVENT_LOCAL_ID_V1,
  type TriageIssueEventSourceConfigV1, type TriageIssueTransitionV1,
} from './issueSource.js';
import {
  TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1, issueCheckpointRowId, readIssueCheckpoints, writeIssueCheckpoints,
  type IssueCheckpoint, type IssueCheckpointPut,
} from './issueCheckpoint.js';
type Present = Extract<TriageSourceScanObservationV1, { kind: 'present' }>;
type CheckpointedPresent = Present & Readonly<{
  sourceUpdatedAtMs: number;
  snapshot: Present['snapshot'] & Readonly<{ state: Present['snapshot']['state'] & Readonly<{ presentation: 'active' | 'resolved' }> }>;
}>;
type Change = Readonly<{
  key: string; expectedVersion: number | 'absent'; value: IssueCheckpoint;
  transition?: TriageIssueTransitionV1; occurrenceId?: string; entryRef: TriageEntryRefV1; present: Present;
}>;
type Candidate = Readonly<{ changes: readonly Change[] }>;

function isCheckpointedPresent(present: Present): present is CheckpointedPresent {
  return (present.snapshot.state.presentation === 'active' || present.snapshot.state.presentation === 'resolved')
    && present.sourceUpdatedAtMs !== undefined && present.sourceUpdatedAtMs >= 0;
}

/** Both sources keep their own finite client, credential, pagination and row projection. */
export type TriageIssueObserverProviderV1 = Readonly<{
  pluginId: string; sourceLocalId: string; displayName: string; scanLimit: number;
  scan(input: TriageScanInputV1, context: PluginInvocationContext): Promise<TriageScanResultV1>;
}>;

function fingerprint(present: Present): string {
  return computeCanonicalDomainSeparatedDigest('happier.triage.issue.v1', [
    present.localRef.kindId, present.localRef.collisionScope, present.localRef.entryId,
  ]);
}

/** Full current snapshots have no retained history gap to reset. This Action still
 * re-admits the exact host-filled selector and current configured principal. */
export function createTriageIssueHistoryGapResetV1(
  provider: Pick<TriageIssueObserverProviderV1, 'pluginId' | 'sourceLocalId'>,
  readCatalog: (context: PluginInvocationContext) => Promise<PluginCheckpointedEventSourceCatalogV1 | null>,
): (raw: unknown, context: PluginInvocationContext) => Promise<PluginEventAutomationHistoryGapResetActionResultV1> {
  return async (raw, context) => {
    const selector = PluginEventAutomationHistoryGapResetActionInputV1Schema.parse(raw);
    const catalog = await readCatalog(context);
    const matches = catalog?.definitions.filter(definition =>
      definition.automationId === selector.automationId && definition.triggerId === selector.triggerId
      && definition.triggerRevision === selector.triggerRevision && definition.sourceSelectorId === selector.sourceSelectorId
      && definition.eventRef.pluginId === provider.pluginId && definition.eventRef.localId === TRIAGE_ISSUE_EVENT_LOCAL_ID_V1) ?? [];
    const definition = matches.length === 1 ? matches[0] : undefined;
    const source = TriageIssueEventSourceConfigV1Schema.safeParse(definition?.sourceConfig);
    if (!catalog || !definition || !source.success || definition.sourceContractVersion !== 1
      || source.data.instance.instance.source.pluginId !== provider.pluginId
      || source.data.instance.instance.source.localId !== provider.sourceLocalId
      || source.data.instance.instance.sourceInstanceId !== definition.sourceInstanceId) return { kind: 'stale' };
    const current = await sourceIsCurrent({ context, source: source.data,
      isCurrent: async () => !context.signal.aborted });
    return { kind: current ? 'noHistoryGap' : 'stale' };
  };
}

function signature(present: Present): string {
  // Observation clocks do not publish content. The remaining facts already passed the
  // source's bounded row projector; retaining the digest does not retain vendor bags.
  return computeCanonicalDomainSeparatedDigest('happier.triage.issue-state.v1', [JSON.stringify({
    localRef: present.localRef, locator: present.locator, sourceUpdatedAtMs: present.sourceUpdatedAtMs,
    snapshot: { ...present.snapshot, facts: present.snapshot.facts.filter(fact => fact.value.kind !== 'timestamp') },
  })]);
}

async function sourceIsCurrent(input: Readonly<{
  context: PluginInvocationContext; source: TriageIssueEventSourceConfigV1; isCurrent(): Promise<boolean>;
}>): Promise<boolean> {
  if (!await input.isCurrent()) return false;
  const current = await readCurrentTriageConfiguredSourceInstanceV1({
    context: input.context,
    sourceInstanceId: input.source.instance.instance.sourceInstanceId,
    instance: input.source.instance,
    instanceDigest: deriveTriageConfiguredSourceInstanceDigestV1(input.source.instance),
  });
  return current.kind === 'current' && await input.isCurrent();
}

/** One finite scan + candidate. Admission safety, adoption and all wakes stay in the SDK. */
export function createTriageIssueEventSourceAdapterV1(provider: TriageIssueObserverProviderV1): PluginCheckpointedEventSourceAdapterV1<TriageIssueEventSourceConfigV1, Candidate> {
  return {
    decode(definition) {
      if (definition.eventRef.pluginId !== provider.pluginId
        || definition.eventRef.localId !== TRIAGE_ISSUE_EVENT_LOCAL_ID_V1
        || definition.sourceContractVersion !== 1) return null;
      const parsed = TriageIssueEventSourceConfigV1Schema.safeParse(definition.sourceConfig);
      return parsed.success && parsed.data.instance.instance.source.pluginId === provider.pluginId
        && parsed.data.instance.instance.source.localId === provider.sourceLocalId
        && parsed.data.instance.instance.sourceInstanceId === definition.sourceInstanceId
        ? parsed.data : null;
    },
    async observe(input) {
      const { context, source } = input;
      const next = () => Date.now() + source.checkPeriodMs;
      if (!await sourceIsCurrent(input)) return { observations: [], complete: false, nextEligibleAt: null };
      const storage = context.services.storage.account;
      if (!storage) throw new PluginError({ code: 'triage_issue_checkpoint_unavailable', message: 'Account checkpoint storage is unavailable.' });
      const presentByFingerprint = new Map<string, Present>();
      let scanInput: TriageScanInputV1 = {
        v: 1, instance: source.instance, page: { kind: 'initial', limit: provider.scanLimit },
      };
      const seen = new Set<string>();
      for (;;) {
        context.signal.throwIfAborted();
        const result: TriageScanResultV1 = TriageScanResultV1Schema.parse(await provider.scan(scanInput, context));
        context.signal.throwIfAborted();
        if (result.kind === 'failed') {
          const failure = result.failure;
          const unavailable = ['authentication', 'permission', 'unsupportedContract'].includes(failure.class);
          return { observations: [], complete: false,
            nextEligibleAt: unavailable ? null : Math.max(next(), failure.retryNotBeforeMs ?? 0),
            status: failure.class === 'authentication' || failure.class === 'permission'
              ? { state: 'attention', code: 'credentialRevoked' }
              : failure.class === 'unsupportedContract'
                ? { state: 'attention', code: 'sourceContractIncompatible' }
                : { state: 'backingOff', code: failure.class === 'rateLimit' ? 'rateLimited' : 'admissionUnavailable' },
          };
        }
        for (const row of result.observations) if (row.kind === 'present') presentByFingerprint.set(fingerprint(row), row);
        if (result.kind === 'complete') {
          if (result.evidence.kind !== 'walkFinished') return { observations: [], complete: false, nextEligibleAt: next() };
          break;
        }
        if (seen.has(result.continuation.token)) throw new PluginError({ code: 'triage_issue_scan_not_advancing', message: 'The issue scan did not advance.' });
        seen.add(result.continuation.token);
        scanInput = { v: 1, instance: source.instance, page: { kind: 'continuation', continuation: result.continuation } };
      }
      context.signal.throwIfAborted();
      const observationReceivedAt = Date.now();
      const collection = storage.collection(TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1);
      const eligible = [...presentByFingerprint].filter((entry): entry is [string, CheckpointedPresent] => isCheckpointedPresent(entry[1]));
      const checkpointIds = eligible.map(([issueFingerprint]) =>
        issueCheckpointRowId(input.definition.sourceInstanceId, issueFingerprint));
      const retainedRows = await readIssueCheckpoints(collection, input.definition.sourceInstanceId, checkpointIds, context.signal);
      const changes: Change[] = [];
      const pendingWrites: IssueCheckpointPut[] = [];
      const observations: PluginEventObservationV1[] = [];
      for (const [issueFingerprint, present] of eligible) {
        const state = present.snapshot.state.presentation;
        const key = issueCheckpointRowId(input.definition.sourceInstanceId, issueFingerprint);
        const retained = retainedRows.get(key);
        const record = retained?.value.checkpoint ?? null;
        const previous: IssueCheckpoint | null = record && 'signature' in record
          ? { v: record.v, signature: record.signature, ordinal: record.ordinal, state: record.state } : null;
        const previousPending = record?.pending;
        const currentSignature = signature(present);
        if (previousPending === undefined && previous?.signature === currentSignature) continue;
        let pending = previousPending?.signature === currentSignature ? previousPending : undefined;
        const ordinal = pending ? pending.ordinal : (previousPending?.ordinal ?? previous?.ordinal ?? -1) + 1;
        const entryRef = { source: source.instance.instance.source, ...present.localRef };
        const value = { v: 1 as const, state, signature: currentSignature, ordinal };
        // A resolved item first discovered in an ordinary scan is a baseline, not recovery.
        if (previousPending === undefined && state === 'resolved' && (previous === null || previous.state !== 'active')) {
          changes.push({ key, expectedVersion: retained?.revision ?? 'absent', value, entryRef, present });
          continue;
        }
        const phase = pending ? pending.phase : state === 'resolved' ? 'resolved'
          : (previousPending?.state ?? previous?.state) === 'active' ? 'updated' : 'open';
        const transition = TriageIssueTransitionV1Schema.parse({
          phase, sourceInstanceId: input.definition.sourceInstanceId, issueFingerprint,
          issueRef: buildTriageEntryRouteSegmentV1(entryRef), providerUpdatedAt: present.sourceUpdatedAtMs,
          evidence: { v: 1, items: [{ source: { kind: 'alert', label: provider.displayName,
            ...(present.locator.webUrl === undefined ? {} : { url: present.locator.webUrl }) },
          author: { kind: 'unknown' }, text: present.snapshot.title }] },
        });
        const occurrenceId = `${input.definition.sourceInstanceId}:${issueFingerprint}:${ordinal}:${currentSignature}`;
        const observedDelta: 0 | 1 = pending === undefined ? 1 : 0;
        const expectedVersion = retained?.revision ?? 'absent';
        if (pending === undefined) {
          pending = { signature: currentSignature, ordinal, state, phase, occurredAt: observationReceivedAt };
          pendingWrites.push({ kind: 'put', expectedRevision: expectedVersion, value: {
            id: key, sourceInstanceId: input.definition.sourceInstanceId,
            checkpoint: { ...(previous ?? { v: 1 as const }), pending },
          } });
        }
        observations.push({ eventRef: input.definition.eventRef, sourceInstanceId: input.definition.sourceInstanceId,
          sourceContractVersion: 1, occurrenceId, occurredAt: pending.occurredAt,
          observationReceivedAt, observedDelta, payload: projectNativeJsonValueForTransport(transition) });
        changes.push({ key, expectedVersion, value, transition, occurrenceId, entryRef, present });
      }
      // Capture the immutable observation clock for the whole changed set before
      // admission. A conflict follows the existing runner's re-observation; its
      // winning pending time is reused rather than replaced by retry time.
      const pendingRevisions = await writeIssueCheckpoints(collection, pendingWrites, context.signal);
      const checkpointChanges = changes.map(change => pendingRevisions.has(change.key)
        ? { ...change, expectedVersion: pendingRevisions.get(change.key)! } : change);
      return { observations, ...(checkpointChanges.length === 0 ? {} : { checkpoint: { changes: checkpointChanges } }), complete: true, nextEligibleAt: next() };
    },
    async save(input) {
      if (!await sourceIsCurrent(input)) return;
      const storage = input.context.services.storage.account;
      if (!storage) throw new PluginError({ code: 'triage_issue_checkpoint_unavailable', message: 'Account checkpoint storage is unavailable.' });
      for (const change of input.checkpoint.changes) {
        input.context.signal.throwIfAborted();
        if (change.transition && change.occurrenceId) {
          await publishTriageIssueTransitionV1(input.context, {
            providerDisplayName: provider.displayName, sourceInstanceId: input.definition.sourceInstanceId,
            transition: change.transition, occurrenceId: change.occurrenceId, entryRef: change.entryRef,
            title: change.present.snapshot.title,
            ...(change.present.locator.webUrl === undefined ? {} : { webUrl: change.present.locator.webUrl }),
          });
        }
        input.context.signal.throwIfAborted();
      }
      await writeIssueCheckpoints(storage.collection(TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1),
        input.checkpoint.changes.map(change => ({ kind: 'put', expectedRevision: change.expectedVersion,
          value: { id: change.key, sourceInstanceId: input.definition.sourceInstanceId, checkpoint: change.value } })),
        input.context.signal);
    },
    retryAt({ now, definition }) {
      const config = TriageIssueEventSourceConfigV1Schema.safeParse(definition?.sourceConfig);
      return now + (config.success ? config.data.checkPeriodMs : TRIAGE_ISSUE_DEFAULT_CHECK_PERIOD_MS_V1);
    },
  };
}

import { publishTriageIssueTransitionV1 } from './issueTransition.js';
