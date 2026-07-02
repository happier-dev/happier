export function isLegacyUnclassifiedTranscriptRow(row: Readonly<{ messageRole?: unknown }>): boolean {
  return row.messageRole === null || row.messageRole === undefined;
}
