import type { HappierReplayDialogItem } from './types';
import { decryptTranscriptReplayCore } from './decryptTranscriptReplayCore';

type RawTranscriptRow = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

export function decryptTranscriptTextItems(params: Readonly<{
  rows: readonly RawTranscriptRow[];
  encryptionKey?: Uint8Array;
  encryptionVariant?: 'dataKey';
  maxTextChars?: number;
  maxDialogItems?: number;
}>): HappierReplayDialogItem[] {
  return decryptTranscriptReplayCore(params).dialog;
}
