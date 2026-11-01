type JsonlReadBudget = Readonly<{
  maxBytes: number;
  maxItems: number;
  chunkBytes?: number;
  maxOversizeLineBytes?: number;
}>;

export function resolveJsonlReadBudget(params: JsonlReadBudget) {
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  return {
    maxBytes,
    maxItems: Math.max(1, Math.trunc(params.maxItems)),
    chunkBytes: Math.max(1024, Math.trunc(params.chunkBytes ?? 64 * 1024)),
    maxOversizeLineBytes: Math.max(maxBytes, Math.trunc(params.maxOversizeLineBytes ?? 8 * 1024 * 1024)),
  };
}

export class JsonlRecordTooLargeError extends Error {
  readonly code = 'JSONL_RECORD_TOO_LARGE';

  constructor(readonly maxLineBytes: number, readonly direction: 'backward' | 'forward', readonly offsetBytes: number) {
    super(`JSONL record cannot complete within the ${maxLineBytes}-byte read allowance at ${direction} offset ${offsetBytes}. Increase the read allowance to read the record intact.`);
    this.name = 'JsonlRecordTooLargeError';
  }
}

/** A bounded read must never advertise an unchanged continuation for an unread record. */
export function assertJsonlReadProgress(params: Readonly<{
  consumedBytes: number;
  remainingSourceBytes: number;
  pendingLineBytes: number;
  maxLineBytes: number;
  direction: 'backward' | 'forward';
  offsetBytes: number;
}>): void {
  if (params.consumedBytes === 0 && params.remainingSourceBytes > 0 && params.pendingLineBytes >= params.maxLineBytes) {
    throw new JsonlRecordTooLargeError(params.maxLineBytes, params.direction, params.offsetBytes);
  }
}
