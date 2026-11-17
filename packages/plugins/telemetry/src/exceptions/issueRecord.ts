import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import type { CaptureExceptionGroup } from '../store/capture.js';
import { exceptionApplicationOriginSchema } from './contracts.js';

const millis = () => defineProtocolNumber({ integer: true, minimum: 0 });
const status = defineProtocolUnion([
  defineProtocolLiteral('open'),
  defineProtocolLiteral('resolved'),
  defineProtocolLiteral('ignored'),
]);
const resolutionSchema = defineProtocolObject(
  {
    atMs: millis(),
    /** The fixed release the person named, when they named one. */
    version: defineProtocolString().optional(),
    /** Releases already seen when resolving; their late traffic never reopens the issue. */
    priorVersions: defineProtocolArray(defineProtocolString()),
  },
  { policy: 'closed' },
);

/**
 * One native issue: Account data (D30), private on E2EE Accounts. Only the
 * Environment id, which the server already knows, is server-readable.
 * Occurrences and stacks never enter this record; they stay on the collector.
 */
export const TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1 = defineAccountCollection(
  {
    id: 'exception-issues',
    schemaVersion: 1,
    schema: defineProtocolObject(
      {
        id: defineProtocolString(),
        environmentId: defineProtocolString(),
        fingerprint: defineProtocolString(),
        applicationOrigin: exceptionApplicationOriginSchema.optional(),
        title: defineProtocolString(),
        serviceName: defineProtocolString().optional(),
        type: defineProtocolString().optional(),
        topFrame: defineProtocolString().optional(),
        status,
        regressed: defineProtocolLiteral(true).optional(),
        count: millis(),
        firstSeenAtMs: millis(),
        lastSeenAtMs: millis(),
        asOfMs: millis(),
        lastServiceVersion: defineProtocolString().optional(),
        resolution: resolutionSchema.optional(),
        createdAtMs: millis(),
        updatedAtMs: millis(),
      },
      { policy: 'closed' },
    ),
    rowIdField: 'id',
    serverReadable: ['environmentId', 'id'],
    identityFields: ['id'],
    indexes: [
      {
        id: 'by-environment',
        fields: [
          { field: 'environmentId', direction: 'asc' },
          { field: 'id', direction: 'asc' },
        ],
      },
    ],
  },
);
export type ExceptionIssueRecord = ReturnType<
  typeof TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1.schema.parse
>;
export type ExceptionIssueTransitionAction =
  | 'resolve'
  | 'reopen'
  | 'ignore'
  | 'unignore';
/** Only these reach Automations/attention; count and last-seen changes never do. */
export type ExceptionIssuePhase = 'open' | 'resolved';

function title(group: Pick<CaptureExceptionGroup, 'type' | 'message'>): string {
  const message = group.message?.trim();
  return group.type && message
    ? `${group.type}: ${message}`
    : (group.type ?? (message || 'Exception'));
}

function summary(group: CaptureExceptionGroup, now: number) {
  return {
    title: title(group),
    ...(group.applicationOrigin ? { applicationOrigin: group.applicationOrigin } : {}),
    count: group.count,
    firstSeenAtMs: group.firstAt,
    lastSeenAtMs: group.lastAt,
    asOfMs: now,
    ...(group.serviceName ? { serviceName: group.serviceName } : {}),
    ...(group.type ? { type: group.type } : {}),
    ...(group.topFrame ? { topFrame: group.topFrame } : {}),
    ...(group.lastServiceVersion
      ? { lastServiceVersion: group.lastServiceVersion }
      : {}),
  };
}

export function openExceptionIssue(
  input: Readonly<{
    id: string;
    environmentId: string;
    group: CaptureExceptionGroup;
    now: number;
  }>,
): ExceptionIssueRecord {
  return {
    id: input.id,
    environmentId: input.environmentId,
    fingerprint: input.group.fingerprint,
    status: 'open',
    ...summary(input.group, input.now),
    createdAtMs: input.now,
    updatedAtMs: input.now,
  };
}

/** Demand refresh: counts with their as-of time, lifecycle untouched. */
export function refreshExceptionIssue(
  record: ExceptionIssueRecord,
  group: CaptureExceptionGroup,
  now: number,
): ExceptionIssueRecord {
  const {
    serviceName: _s,
    type: _t,
    topFrame: _f,
    lastServiceVersion: _v,
    ...lifecycle
  } = record;
  return { ...lifecycle, ...summary(group, now), updatedAtMs: now };
}

/**
 * A resolved issue regresses only on a qualifying recurrence: after the
 * resolution, from a release not already seen before it. Unknown release counts
 * as a recurrence with unknown release. Ignored issues stay ignored.
 */
export function isQualifyingRecurrence(
  record: ExceptionIssueRecord,
  occurrence: Readonly<{ at: number; serviceVersion?: string | null }>,
): boolean {
  if (
    record.status !== 'resolved' ||
    !record.resolution ||
    occurrence.at <= record.resolution.atMs
  )
    return false;
  return (
    occurrence.serviceVersion == null ||
    !record.resolution.priorVersions.includes(occurrence.serviceVersion)
  );
}

export function regressExceptionIssue(
  record: ExceptionIssueRecord,
  group: CaptureExceptionGroup,
  now: number,
): ExceptionIssueRecord {
  const { resolution: _resolution, ...rest } = refreshExceptionIssue(
    record,
    group,
    now,
  );
  return { ...rest, status: 'open', regressed: true };
}

export function transitionExceptionIssue(
  record: ExceptionIssueRecord,
  action: ExceptionIssueTransitionAction,
  input: Readonly<{
    now: number;
    version?: string;
    priorVersions: readonly string[];
  }>,
): { record: ExceptionIssueRecord; phase?: ExceptionIssuePhase } | null {
  const { resolution: _resolution, regressed: _regressed, ...rest } = record;
  switch (action) {
    case 'resolve':
      if (record.status === 'resolved') return null;
      return {
        phase: 'resolved',
        record: {
          ...rest,
          status: 'resolved',
          updatedAtMs: input.now,
          resolution: {
            atMs: input.now,
            ...(input.version ? { version: input.version } : {}),
            priorVersions: [...new Set(input.priorVersions)].filter(
              (version) => version !== input.version,
            ),
          },
        },
      };
    case 'reopen':
      if (record.status !== 'resolved') return null;
      return {
        phase: 'open',
        record: { ...rest, status: 'open', updatedAtMs: input.now },
      };
    case 'ignore':
      if (record.status === 'ignored') return null;
      return { record: { ...rest, status: 'ignored', updatedAtMs: input.now } };
    case 'unignore':
      if (record.status !== 'ignored') return null;
      return { record: { ...rest, status: 'open', updatedAtMs: input.now } };
  }
}
