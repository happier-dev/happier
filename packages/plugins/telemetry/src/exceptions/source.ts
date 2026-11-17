import {
  isPluginError,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
  projectTriageDisplayTextV1,
  TriageSourceDescriptorV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriageGetInputV1,
  type TriageGetResultV1,
  type TriageScanInputV1,
  type TriageScanResultV1,
  type TriageSourceEntryLocalRefV1,
  type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';
import {
  TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1,
  type ExceptionIssueRecord,
} from './issueRecord.js';
import type { ExceptionDetailDataV1 } from './contracts.js';

export const TELEMETRY_EXCEPTION_SOURCE_V1 = Object.freeze({
  pluginId: 'happier.telemetry',
  localId: 'exceptions',
});
export const TELEMETRY_EXCEPTION_KIND_ID_V1 = 'exception';
const LABEL = 'Happier exceptions';

/** The built-in, credentialless Account-data source (D30): one per Account, no connection row. */
export const TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1 = {
  v: 1,
  binding: { purpose: 'exceptions', source: 'accountData' },
  localInstanceKey: 'happier-exceptions',
  keyStability: 'stable',
  configuration: { v: 1, token: 'happier-exceptions-v1' },
  locator: { v: 1, displayLabel: LABEL },
} as const satisfies TriageSourceInstanceDraftV1;

export const TELEMETRY_EXCEPTION_SOURCE_DESCRIPTOR_V1 =
  TriageSourceDescriptorV1Schema.parse({
    v: 1,
    purpose: 'exceptions',
    displayName: LABEL,
    // Resolve, Reopen and Ignore are the issue's own header actions, routed to the collector's single writer.
    kinds: [
      {
        id: TELEMETRY_EXCEPTION_KIND_ID_V1,
        workflowSubject: 'errorIssue',
        displayName: 'Exception',
        pluralDisplayName: 'Exceptions',
        detailActions: true,
        // The Triage frame draws these tabs (r0.42); Overview carries Triage's own agent step.
        detailTabs: [
          { kind: 'shared', id: 'overview' },
          { kind: 'source', id: 'stack-trace', title: 'Stack trace', titleKey: 'plugins.telemetry.exceptions.tab.stackTrace' },
          { kind: 'source', id: 'occurrences', title: 'Occurrences', titleKey: 'plugins.telemetry.exceptions.tab.occurrences',
            summaryFact: 'events', scrollOwner: 'list' },
        ],
      },
    ],
  });

export function isTelemetryExceptionInstanceV1(
  instance: TriageConfiguredSourceInstanceV1,
): boolean {
  return (
    instance.instance.source.pluginId ===
      TELEMETRY_EXCEPTION_SOURCE_V1.pluginId &&
    instance.instance.source.localId ===
      TELEMETRY_EXCEPTION_SOURCE_V1.localId &&
    'source' in instance.binding &&
    instance.binding.source === 'accountData' &&
    instance.localInstanceKey ===
      TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.localInstanceKey
  );
}

/** Own records are `personal`; a Team-shared record keeps its owner, like shared Happier tasks. */
export function exceptionLocalRefV1(
  rowId: string,
  ownerAccountId?: string,
): TriageSourceEntryLocalRefV1 {
  return {
    kindId: TELEMETRY_EXCEPTION_KIND_ID_V1,
    collisionScope:
      ownerAccountId === undefined ? 'personal' : `account:${ownerAccountId}`,
    entryId: rowId,
  };
}
function ownerOf(ref: TriageSourceEntryLocalRefV1): string | undefined | null {
  if (ref.kindId !== TELEMETRY_EXCEPTION_KIND_ID_V1) return null;
  if (ref.collisionScope === 'personal') return undefined;
  return ref.collisionScope.startsWith('account:') &&
    ref.collisionScope.length > 8
    ? ref.collisionScope.slice(8)
    : null;
}

const UNAVAILABLE = {
  class: 'transient',
  code: 'exceptionIssuesUnavailable',
} as const;
const INVALID = {
  class: 'unsupportedContract',
  code: 'invalidExceptionAddress',
} as const;

type Item = Readonly<{
  rowId: string;
  value: ExceptionIssueRecord;
  ownerAccountId?: string;
  access?: 'view' | 'edit' | 'owner';
}>;

function state(record: ExceptionIssueRecord) {
  return record.status === 'open'
    ? {
        presentation: 'active' as const,
        nativeLabel: record.regressed ? 'Regressed' : 'Open',
      }
    : record.status === 'resolved'
      ? {
          presentation: 'resolved' as const,
          nativeLabel: 'Resolved',
          completionReason: 'completed' as const,
        }
      : {
          presentation: 'closed' as const,
          nativeLabel: 'Ignored',
          completionReason: 'canceled' as const,
        };
}

/** Only Account issue metadata; occurrences and stacks are read on demand from the collector. */
function observation(
  item: Item,
): Extract<TriageGetResultV1, { kind: 'present' }> {
  const record = item.value;
  const title = projectTriageDisplayTextV1(record.title);
  return {
    kind: 'present',
    localRef: exceptionLocalRefV1(item.rowId, item.ownerAccountId),
    locator: {
      v: 1,
      displayPath: title.value || record.fingerprint,
      routingToken: item.rowId,
    },
    snapshot: {
      v: 1,
      title: title.value || 'Exception',
      scopeLabel: LABEL,
      scopeDisplayName: record.serviceName ?? LABEL,
      scopeUnitId: record.environmentId,
      state: state(record),
      createdAtMs: record.createdAtMs,
      ...(record.status === 'resolved' && record.resolution
        ? { completedAtMs: record.resolution.atMs }
        : {}),
      // Counts cover the collector's retained window, so they are approximate totals.
      facts: [
        ...(record.regressed ? [{ id: 'regressed', importance: 'primary' as const,
          value: { kind: 'status' as const, value: 'Regressed', tone: 'warning' as const } }] : []),
        ...(record.topFrame ? [{ id: 'culprit', importance: 'primary' as const, value: { kind: 'text' as const, value: record.topFrame } }] : []),
        { id: 'events', importance: 'secondary' as const,
          value: { kind: 'number' as const, value: record.count, format: 'compact' as const, approximate: true as const } },
        { id: 'last-seen', importance: 'secondary' as const,
          value: { kind: 'timestamp' as const, atMs: record.lastSeenAtMs, format: 'relative' as const } },
        ...(record.lastServiceVersion ? [{ id: 'release', importance: 'secondary' as const,
          value: { kind: 'text' as const, value: record.lastServiceVersion } }] : []),
        { id: 'first-seen', importance: 'supplementary' as const,
          value: { kind: 'timestamp' as const, atMs: record.firstSeenAtMs, format: 'relative' as const } },
      ],
      ...(title.truncated ? { projectionTruncated: true } : {}),
    },
    viewer: { involvement: [], sourceAttention: { level: 'none' } },
    sourceUpdatedAtMs: record.updatedAtMs,
  };
}

/**
 * Source-owned presentation for the detail surface, on the exact read only: what its occurrence and stack reads
 * address (the Environment and fingerprint) and the lifecycle facts its overview states. Never retained.
 */
function detailData(record: Item['value'], shared: boolean): ExceptionDetailDataV1 {
  return {
    v: 1 as const,
    environmentId: record.environmentId,
    // A Team-shared read never carries the owner's fingerprint (the collector address of its occurrences).
    ...(shared ? {} : { fingerprint: record.fingerprint }),
    status: record.status,
    ...(record.regressed ? { regressed: true as const } : {}),
    count: record.count,
    firstSeenAtMs: record.firstSeenAtMs,
    lastSeenAtMs: record.lastSeenAtMs,
    asOfMs: record.asOfMs,
    ...(record.serviceName ? { serviceName: record.serviceName } : {}),
    ...(record.type ? { type: record.type } : {}),
    ...(record.topFrame ? { topFrame: record.topFrame } : {}),
    ...(record.lastServiceVersion ? { lastServiceVersion: record.lastServiceVersion } : {}),
    ...(record.resolution ? { resolution: record.resolution } : {}),
  };
}

function collection(context: PluginInvocationContext) {
  return (
    context.services.storage.account?.collection(
      TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1,
    ) ?? null
  );
}

/** Own records first (newest update first), then records Teams shared with this Account (D34). */
async function readAll(
  context: PluginInvocationContext,
): Promise<Readonly<{ items: readonly Item[]; sharedUnavailable: boolean }> | null> {
  const issues = collection(context);
  if (!issues) return null;
  const items: Item[] = [];
  let cursor: string | undefined;
  do {
    const page = await issues.query(
      { index: 'by-environment', order: 'asc', ...(cursor ? { cursor } : {}) },
      { signal: context.signal },
    );
    items.push(
      ...page.rows.map((row) => ({ rowId: row.rowId, value: row.value })),
    );
    cursor = page.nextCursor;
  } while (cursor);
  items.sort(
    (left, right) =>
      right.value.updatedAtMs - left.value.updatedAtMs ||
      left.rowId.localeCompare(right.rowId),
  );
  const shared: Item[] = [];
  cursor = undefined;
  try {
    do {
      const page = await issues.sharing.sharedWithMe(cursor ? { cursor } : {}, {
        signal: context.signal,
      });
      shared.push(
        ...page.rows.map((row) => ({
          rowId: row.rowId,
          value: row.value,
          ownerAccountId: row.ownerAccountId,
        })),
      );
      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) {
    // Own records stay readable when shared reads are unavailable; coverage says so.
    if (context.signal.aborted) throw error;
    return { items, sharedUnavailable: true };
  }
  shared.sort(
    (left, right) =>
      right.value.updatedAtMs - left.value.updatedAtMs ||
      left.rowId.localeCompare(right.rowId),
  );
  return { items: [...items, ...shared], sharedUnavailable: false };
}

export async function scanTelemetryExceptions(
  input: TriageScanInputV1,
  context: PluginInvocationContext,
): Promise<TriageScanResultV1> {
  if (!isTelemetryExceptionInstanceV1(input.instance))
    return { kind: 'failed', failure: INVALID };
  let read: Awaited<ReturnType<typeof readAll>>;
  try {
    read = await readAll(context);
  } catch (error) {
    if (context.signal.aborted) throw error;
    return {
      kind: 'failed',
      failure: {
        ...UNAVAILABLE,
        ...(isPluginError(error) ? { code: error.code } : {}),
      },
    };
  }
  if (read === null) return { kind: 'failed', failure: UNAVAILABLE };
  const { items, sharedUnavailable } = read;
  let start = 0;
  let limit: number;
  if (input.page.kind === 'initial') limit = input.page.limit;
  else {
    try {
      const cursor: unknown = JSON.parse(input.page.continuation.token);
      if (
        typeof cursor !== 'object' ||
        cursor === null ||
        !('start' in cursor) ||
        !('limit' in cursor) ||
        typeof cursor.start !== 'number' ||
        typeof cursor.limit !== 'number'
      )
        return { kind: 'failed', failure: INVALID };
      start = cursor.start;
      limit = cursor.limit;
    } catch {
      return { kind: 'failed', failure: INVALID };
    }
  }
  const observations = items.slice(start, start + limit).map(observation);
  return start + limit >= items.length
    ? { kind: 'complete', observations, evidence: sharedUnavailable
        ? { kind: 'partial', reason: 'sharedIssuesUnavailable' } : { kind: 'walkFinished' } }
    : {
        kind: 'page',
        observations,
        evidence: { kind: 'partial', reason: 'pageLimit' },
        continuation: {
          v: 1,
          token: JSON.stringify({ start: start + limit, limit }),
        },
      };
}

export async function getTelemetryException(
  input: TriageGetInputV1,
  context: PluginInvocationContext,
): Promise<TriageGetResultV1> {
  const owner = ownerOf(input.localRef);
  if (!isTelemetryExceptionInstanceV1(input.instance) || owner === null)
    return { kind: 'unresolved', localRef: input.localRef, failure: INVALID };
  const issues = collection(context);
  if (!issues)
    return {
      kind: 'unresolved',
      localRef: input.localRef,
      failure: UNAVAILABLE,
    };
  try {
    if (owner === undefined) {
      const row = await issues.get(input.localRef.entryId, {
        signal: context.signal,
      });
      return row === null
        ? { kind: 'absent', localRef: input.localRef }
        : { ...observation({ rowId: row.rowId, value: row.value }), detailData: detailData(row.value, false) };
    }
    const row = await issues.sharing.get(
      { ownerAccountId: owner, rowId: input.localRef.entryId },
      { signal: context.signal },
    );
    return {
      ...observation({ rowId: row.rowId, value: row.value, ownerAccountId: row.ownerAccountId }),
      detailData: detailData(row.value, true),
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    // A revoked or missing grant is absence for this viewer; it never discloses the owner's record.
    if (
      isPluginError(error) &&
      (error.code === 'collection_access_forbidden' ||
        error.code === 'collection_subject_not_found')
    ) {
      return { kind: 'absent', localRef: input.localRef };
    }
    return {
      kind: 'unresolved',
      localRef: input.localRef,
      failure: {
        ...UNAVAILABLE,
        ...(isPluginError(error) ? { code: error.code } : {}),
      },
    };
  }
}
