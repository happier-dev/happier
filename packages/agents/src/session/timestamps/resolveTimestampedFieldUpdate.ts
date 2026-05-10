export type TimestampedFieldStaleBehavior = 'drop' | 'bump-if-value-changed';

export type TimestampedFieldValue<TValue> = Readonly<{
  value: TValue;
  updatedAt: number;
}>;

export type TimestampedFieldUpdateResult<TValue> =
  | Readonly<{
    accepted: true;
    value: TValue;
    updatedAt: number;
    reason: 'newer' | 'bumped';
  }>
  | Readonly<{
    accepted: false;
    reason: 'stale' | 'unchanged';
  }>;

function normalizeUpdatedAt(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function resolveTimestampedFieldUpdate<TValue>(params: Readonly<{
  current: TimestampedFieldValue<TValue> | null | undefined;
  candidate: TimestampedFieldValue<TValue>;
  staleBehavior: TimestampedFieldStaleBehavior;
  isEqual?: (left: TValue, right: TValue) => boolean;
}>): TimestampedFieldUpdateResult<TValue> {
  const currentUpdatedAt = normalizeUpdatedAt(params.current?.updatedAt ?? 0);
  const candidateUpdatedAt = normalizeUpdatedAt(params.candidate.updatedAt);

  if (candidateUpdatedAt > currentUpdatedAt) {
    return {
      accepted: true,
      value: params.candidate.value,
      updatedAt: candidateUpdatedAt,
      reason: 'newer',
    };
  }

  if (params.staleBehavior === 'drop') {
    return { accepted: false, reason: 'stale' };
  }

  const isEqual = params.isEqual ?? Object.is;
  if (params.current && isEqual(params.current.value, params.candidate.value)) {
    return { accepted: false, reason: 'unchanged' };
  }

  return {
    accepted: true,
    value: params.candidate.value,
    updatedAt: currentUpdatedAt + 1,
    reason: 'bumped',
  };
}
