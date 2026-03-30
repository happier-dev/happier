type UnknownRecord = Record<string, unknown>;

export type OpenCodeFileDiff = Readonly<{
  filePath: string;
  oldText: string;
  newText: string;
}>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function extractDirectFileDiff(value: unknown): OpenCodeFileDiff | null {
  const record = asRecord(value);
  if (!record) return null;

  const file = readString(record.file) ?? readString(record.path) ?? readString(record.filePath);
  const before = readString(record.before) ?? readString(record.oldText);
  const after = readString(record.after) ?? readString(record.newText);
  if (!file || before == null || after == null) return null;
  const trimmedFile = file.trim();
  if (!trimmedFile) return null;
  return {
    filePath: trimmedFile,
    oldText: before,
    newText: after,
  };
}

export function extractOpenCodeFileDiff(raw: unknown): OpenCodeFileDiff | null {
  const record = asRecord(raw);
  if (!record) return null;

  const direct = extractDirectFileDiff(record);
  if (direct) return direct;

  const metadata = asRecord(record.metadata);
  const metadataFileDiff = extractDirectFileDiff(metadata?.filediff);
  if (metadataFileDiff) return metadataFileDiff;

  const output = asRecord(record.output);
  const outputDirect = extractDirectFileDiff(output);
  if (outputDirect) return outputDirect;

  const nestedMetadataFileDiff = extractDirectFileDiff(asRecord(output?.metadata)?.filediff);
  if (nestedMetadataFileDiff) return nestedMetadataFileDiff;

  return null;
}
