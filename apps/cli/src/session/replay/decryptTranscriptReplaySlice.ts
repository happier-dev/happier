import type { HappierReplayDialogItem } from './types';
import { decryptTranscriptReplayCore } from './decryptTranscriptReplayCore';

type RawTranscriptRow = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

export function decryptTranscriptReplaySlice(params: Readonly<{
  rows: readonly RawTranscriptRow[];
  encryptionKey?: Uint8Array;
  encryptionVariant?: 'dataKey';
  maxTextChars?: number;
  maxDialogItems?: number;
}>): Readonly<{ dialog: HappierReplayDialogItem[]; latestSynopsisText: string | null }> {
  return decryptTranscriptReplayCore(params);
}
