const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_KEY_PATTERN = /(?:^|(?:created|updated|emitted|observed|started|finished|changed|active|meaningfulActivity))At(?:Ms)?$|timestampMs$/;

export type NormalizedRuntimeModeParitySnapshot =
  | null
  | boolean
  | number
  | string
  | readonly NormalizedRuntimeModeParitySnapshot[]
  | { readonly [key: string]: NormalizedRuntimeModeParitySnapshot };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeValue(value: unknown, key?: string): NormalizedRuntimeModeParitySnapshot {
  if (typeof value === 'number') {
    return key && TIMESTAMP_KEY_PATTERN.test(key) ? 0 : value;
  }

  if (typeof value === 'string') {
    return UUID_PATTERN.test(value) ? '<uuid>' : value;
  }

  if (typeof value === 'boolean' || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeValue(entry))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }

  if (!isRecord(value)) {
    return String(value);
  }

  const normalizedEntries = Object.entries(value)
    .filter(([entryKey]) => entryKey !== 'hostRecoveryNoise')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryKey, entryValue]) => [entryKey, normalizeValue(entryValue, entryKey)] as const);
  return Object.fromEntries(normalizedEntries);
}

export function normalizeRuntimeModeParitySnapshot(value: unknown): NormalizedRuntimeModeParitySnapshot {
  return normalizeValue(value);
}

export type RuntimeModeParityDiff = Readonly<{
  expected: NormalizedRuntimeModeParitySnapshot;
  actual: NormalizedRuntimeModeParitySnapshot;
}>;

export function diffRuntimeModeParitySnapshots(params: Readonly<{
  expected: unknown;
  actual: unknown;
}>): readonly RuntimeModeParityDiff[] {
  const expected = normalizeRuntimeModeParitySnapshot(params.expected);
  const actual = normalizeRuntimeModeParitySnapshot(params.actual);
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return [];
  }
  return [{ expected, actual }];
}
