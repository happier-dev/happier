import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { createCoalescedScheduler, sleepWithSignal } from '@happier-dev/plugin-sdk/async';
import { buildTriageEntryRouteSegmentV1, TriageReadAttentionResultV1Schema, type TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { publishTriageAttentionV1 } from '@happier-dev/triage-sources/runtime';
import { indexTriageAdmittedSourcesV1, type TriageAdmittedSourceV1 } from '../actions/listEntries.js';
import { CORPUS_SOURCE_INSTANCES_COLLECTION } from '../corpus/collections/definitions.js';
import { CORPUS_SOURCE_INSTANCES_INDEX_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { readActiveConfiguredSourceRows } from '../corpus/configuration/readConfiguredSourceRows.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';

type Operation = NonNullable<TriageAdmittedSourceV1['operations']['readAttention']>;
type Feed = {
  revision: number;
  occurrenceId: string | undefined;
  controller: AbortController;
  running?: Promise<void>;
  cursor?: { v: 1; token: string };
};

async function followFeed(context: BackgroundServiceContext, instance: TriageConfiguredSourceInstanceV1, operation: Operation, feed: Feed) {
  const signal = feed.controller.signal;
  while (!signal.aborted) {
    const result = TriageReadAttentionResultV1Schema.parse(await context.services.actions.executeAdmittedTargetedOperation(operation, {
      v: 1, instance, ...(feed.cursor === undefined ? {} : { cursor: feed.cursor }),
    }, { signal }));
    signal.throwIfAborted();
    if (result.kind === 'failed') {
      context.services.logger.warn('Triage attention source unavailable', { sourceInstanceId: instance.instance.sourceInstanceId, code: result.failure.code });
      // Without source retry evidence, rejoin at the next lifecycle invalidation.
      if (result.failure.retryNotBeforeMs === undefined) return;
      const delay = result.failure.retryNotBeforeMs - Date.now();
      if (delay > 0) await sleepWithSignal(delay, signal);
      continue;
    }
    for (const item of result.items) {
      signal.throwIfAborted();
      const entryRef = { source: instance.instance.source, ...item.localRef };
      await publishTriageAttentionV1({ services: context.services, signal }, {
        entryRef, reason: item.reason, notice: {
          clientRequestId: globalThis.crypto.randomUUID(), categoryId: 'source-attention',
          title: item.title, type: item.type, resolved: item.resolved,
          page: { pageId: 'triage', subPath: buildTriageEntryRouteSegmentV1(entryRef) },
        },
      });
    }
    feed.cursor = result.cursor;
    if (result.nextPage) continue;
    if (result.pollIntervalMs === undefined) return;
    await sleepWithSignal(result.pollIntervalMs, signal);
  }
}

/** The SDK owns adoption/lifetime. Only sources with a finite feed role join this loop. */
export async function runTriageAttention(context: BackgroundServiceContext): Promise<void> {
  const rows = requireTriageAccountStorage(context).collection(CORPUS_SOURCE_INSTANCES_COLLECTION);
  const feeds = new Map<string, Feed>();
  const stop = () => { for (const feed of feeds.values()) feed.controller.abort(); };
  const observation = context.services.targetedContributions.observeForSelf(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => reconcile.trigger() });
  const reconcile = createCoalescedScheduler({
    onError: () => { if (!context.signal.aborted) context.services.logger.warn('Triage attention source discovery failed'); },
    drain: async () => {
      const [configured, admitted] = await Promise.all([
        readActiveConfiguredSourceRows(rows, { signal: context.signal }), observation.readCurrent({ signal: context.signal }),
      ]);
      const sources = indexTriageAdmittedSourcesV1(admitted.contributions);
      const current = new Set<string>();
      for (const record of configured.records) {
        const contribution = sources.get(record.value.sourceQualifiedId);
        const operation = contribution?.operations.readAttention;
        if (!operation) continue;
        const id = record.value.configured.instance.sourceInstanceId;
        current.add(id);
        const occurrenceId = contribution.contributor.occurrenceId;
        const existing = feeds.get(id);
        const unchanged = existing?.revision === record.revision && existing.occurrenceId === occurrenceId;
        if (unchanged && existing.running) continue;
        if (existing) { existing.controller.abort(); await existing.running; }
        context.signal.throwIfAborted();
        const controller = new AbortController();
        const feed: Feed = { revision: record.revision, occurrenceId, controller,
          cursor: unchanged ? existing.cursor : undefined };
        feed.running = followFeed(context, record.value.configured, operation, feed).catch(() => {
          if (!controller.signal.aborted) context.services.logger.warn('Triage attention feed stopped', { sourceInstanceId: id });
        }).finally(() => { feed.running = undefined; });
        feeds.set(id, feed);
      }
      for (const [id, feed] of feeds) if (!current.has(id)) {
        feed.controller.abort(); await feed.running; feeds.delete(id);
      }
    },
  });
  const configuration = rows.watch({ index: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
    prefix: [CORPUS_SOURCE_INSTANCE_LIFECYCLE.active], order: 'asc' }, () => reconcile.trigger());
  context.signal.addEventListener('abort', stop, { once: true });
  try {
    await reconcile.flush();
    if (!context.signal.aborted) await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
  } finally {
    stop(); const draining = reconcile.flush({ ifRunning: 'join' }); reconcile.dispose(); observation.dispose(); configuration.dispose();
    context.signal.removeEventListener('abort', stop);
    await draining.catch(() => {});
    await Promise.all([...feeds.values()].map(feed => feed.running));
  }
}
