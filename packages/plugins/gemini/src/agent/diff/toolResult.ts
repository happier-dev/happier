export type GeminiToolResultTextDiffSignal = Readonly<{
  kind: 'text';
  filePath: string;
  oldText: string;
  newText: string;
  description?: string;
}>;

export type GeminiToolResultUnifiedDiffSignal = Readonly<{
  kind: 'unified';
  filePath: string;
  unifiedDiff: string;
  description?: string;
}>;

export type GeminiToolResultDiffSignal =
  | GeminiToolResultTextDiffSignal
  | GeminiToolResultUnifiedDiffSignal;

function firstNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readDescription(value: unknown): string | undefined {
  return firstNonEmptyString(value) ?? undefined;
}

function collectTextDiffSignalsFromArray(value: unknown): GeminiToolResultTextDiffSignal[] {
  if (!Array.isArray(value)) return [];

  const signals: GeminiToolResultTextDiffSignal[] = [];
  for (const item of value) {
    const record = readRecord(item);
    if (!record || record.type !== 'diff') continue;

    const filePath = firstNonEmptyString(record.path);
    const oldText = typeof record.oldText === 'string' ? record.oldText : null;
    const newText = typeof record.newText === 'string' ? record.newText : null;
    if (!filePath || oldText == null || newText == null) continue;

    const description = readDescription(record.description);
    signals.push({
      kind: 'text',
      filePath,
      oldText,
      newText,
      ...(description ? { description } : {}),
    });
  }
  return signals;
}

function collectDirectUnifiedDiffSignal(record: Readonly<Record<string, unknown>>): GeminiToolResultUnifiedDiffSignal | null {
  const unifiedDiff = firstNonEmptyString(record.diff)
    ?? firstNonEmptyString(record.unified_diff)
    ?? firstNonEmptyString(record.patch);
  const filePath = firstNonEmptyString(record.path) ?? firstNonEmptyString(record.file);
  if (!unifiedDiff || !filePath) return null;
  const description = readDescription(record.description);
  return {
    kind: 'unified',
    filePath,
    unifiedDiff,
    ...(description ? { description } : {}),
  };
}

function collectChangeUnifiedDiffSignals(record: Readonly<Record<string, unknown>>): GeminiToolResultUnifiedDiffSignal[] {
  const changes = readRecord(record.changes);
  if (!changes) return [];

  const signals: GeminiToolResultUnifiedDiffSignal[] = [];
  for (const [filePath, change] of Object.entries(changes)) {
    const trimmedFilePath = firstNonEmptyString(filePath);
    const changeRecord = readRecord(change);
    if (!trimmedFilePath || !changeRecord) continue;
    const unifiedDiff = firstNonEmptyString(changeRecord.diff)
      ?? firstNonEmptyString(changeRecord.unified_diff)
      ?? firstNonEmptyString(changeRecord.patch);
    if (!unifiedDiff) continue;
    const description = readDescription(changeRecord.description);
    signals.push({
      kind: 'unified',
      filePath: trimmedFilePath,
      unifiedDiff,
      ...(description ? { description } : {}),
    });
  }
  return signals;
}

export function collectGeminiToolResultDiffSignals(result: unknown): GeminiToolResultDiffSignal[] {
  const signals: GeminiToolResultDiffSignal[] = [];
  signals.push(...collectTextDiffSignalsFromArray(result));

  const record = readRecord(result);
  if (!record) return signals;

  signals.push(...collectTextDiffSignalsFromArray(record.output));
  signals.push(...collectTextDiffSignalsFromArray(record.result));

  const directUnified = collectDirectUnifiedDiffSignal(record);
  if (directUnified) {
    signals.push(directUnified);
  } else {
    signals.push(...collectChangeUnifiedDiffSignals(record));
  }
  return signals;
}
