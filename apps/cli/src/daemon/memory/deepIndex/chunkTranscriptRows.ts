export type DeepIndexInputRow = Readonly<{
  seq: number;
  createdAtMs: number;
  role: 'user' | 'agent';
  text: string;
}>;

export type DeepIndexChunk = Readonly<{
  seqFrom: number;
  seqTo: number;
  createdAtFromMs: number;
  createdAtToMs: number;
  text: string;
}>;

export function chunkTranscriptRows(params: Readonly<{
  rows: ReadonlyArray<DeepIndexInputRow>;
  settings: Readonly<{
    maxChunkChars: number;
    maxChunkMessages: number;
    minChunkMessages: number;
  }>;
}>): DeepIndexChunk[] {
  const maxChunkChars = Math.max(1, Math.trunc(params.settings.maxChunkChars));
  const maxChunkMessages = Math.max(1, Math.trunc(params.settings.maxChunkMessages));
  const minChunkMessages = Math.max(1, Math.trunc(params.settings.minChunkMessages));

  const rows = params.rows
    .filter((r) => typeof r.text === 'string' && r.text.trim().length > 0)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  if (rows.length === 0) return [];

  const chunks: DeepIndexChunk[] = [];
  let buffer: DeepIndexInputRow[] = [];
  let bufferChars = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const seqFrom = buffer[0]!.seq;
    const seqTo = buffer[buffer.length - 1]!.seq;
    const createdAtFromMs = buffer[0]!.createdAtMs;
    const createdAtToMs = buffer[buffer.length - 1]!.createdAtMs;
    const lines = buffer.map((r) => `${r.role === 'user' ? 'User' : 'Assistant'}: ${r.text.trim()}`);
    const text = lines.join('\n');
    if (buffer.length < minChunkMessages && chunks.length > 0) {
      const prev = chunks[chunks.length - 1]!;
      chunks[chunks.length - 1] = {
        seqFrom: prev.seqFrom,
        seqTo,
        createdAtFromMs: prev.createdAtFromMs,
        createdAtToMs,
        text: prev.text.length > 0 ? `${prev.text}\n${text}` : text,
      };
    } else {
      chunks.push({ seqFrom, seqTo, createdAtFromMs, createdAtToMs, text });
    }
    buffer = [];
    bufferChars = 0;
  };

  for (const row of rows) {
    const line = `${row.role === 'user' ? 'User' : 'Assistant'}: ${row.text.trim()}`;
    const nextChars = bufferChars + (buffer.length > 0 ? 1 : 0) + line.length;
    const wouldExceedChars = buffer.length > 0 && nextChars > maxChunkChars;
    const wouldExceedMessages = buffer.length >= maxChunkMessages;
    if (wouldExceedChars || wouldExceedMessages) {
      flush();
    }
    buffer.push(row);
    bufferChars = bufferChars + (buffer.length > 1 ? 1 : 0) + line.length;
  }
  flush();

  return chunks;
}
