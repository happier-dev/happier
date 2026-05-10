import type { SessionMetadata } from '@happier-dev/protocol';

import { resolveTimestampedFieldUpdate, type TimestampedFieldStaleBehavior } from '../policies/timestampedFieldUpdate.js';
import type { SessionStateBinding, SessionStateFieldWriteValue, SessionStateStoredValue } from '../_types.js';

type MetadataRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MetadataRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSummary(metadata: SessionMetadata): MetadataRecord | null {
  const summary = metadata.summary;
  return isRecord(summary) ? summary : null;
}

function readSummaryTextValue(metadata: SessionMetadata): SessionStateStoredValue<'display.title'> {
  const summary = readSummary(metadata);
  const text = typeof summary?.text === 'string' ? summary.text : null;
  const updatedAt = typeof summary?.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
    ? summary.updatedAt
    : null;

  return {
    value: text,
    updatedAt,
  };
}

export const summaryTextBinding: SessionStateBinding<'display.title'> = {
  read: readSummaryTextValue,
  write: (metadata, update) => {
    const current = readSummaryTextValue(metadata);
    const rawValue = update.value;
    const structuredValue = typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)
      ? rawValue as Extract<SessionStateFieldWriteValue<'display.title'>, object>
      : null;
    const title = structuredValue
      ? structuredValue.preserveExistingValue === true && current.value !== null
        ? current.value
        : structuredValue.title
      : rawValue;
    const candidate = {
      value: title,
      updatedAt: update.updatedAt ?? structuredValue?.updatedAt ?? Date.now(),
    };
    const staleBehavior: TimestampedFieldStaleBehavior =
      update.staleBehavior ?? structuredValue?.staleBehavior ?? 'drop';

    const resolved = resolveTimestampedFieldUpdate({
      current: current.value === null || current.updatedAt === null
        ? null
        : { value: current.value, updatedAt: current.updatedAt },
      candidate,
      staleBehavior,
    });

    if (!resolved.accepted) return metadata;

    return {
      ...metadata,
      summary: {
        ...(readSummary(metadata) ?? {}),
        text: resolved.value,
        updatedAt: resolved.updatedAt,
      },
    };
  },
};

export function createSummaryTextMetadataUpdater(params: Readonly<{
  title: string;
  updatedAt?: number;
  staleBehavior?: TimestampedFieldStaleBehavior;
}>): <TMetadata extends SessionMetadata>(metadata: TMetadata) => TMetadata {
  const candidate = {
    value: params.title,
    updatedAt: params.updatedAt ?? Date.now(),
  };
  const staleBehavior = params.staleBehavior ?? 'drop';

  return <TMetadata extends SessionMetadata>(metadata: TMetadata): TMetadata => {
    const current = summaryTextBinding.read(metadata);
    const resolved = resolveTimestampedFieldUpdate({
      current: current.value === null || current.updatedAt === null
        ? null
        : { value: current.value, updatedAt: current.updatedAt },
      candidate,
      staleBehavior,
    });

    if (!resolved.accepted) {
      return metadata;
    }

    return summaryTextBinding.write(metadata, {
      value: resolved.value,
      updatedAt: resolved.updatedAt,
    }) as TMetadata;
  };
}
