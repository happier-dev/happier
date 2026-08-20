import type { SessionEncryptionContext } from '../transport/encryption/sessionEncryptionContext';

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
  encryptionVariant?: SessionEncryptionContext['encryptionVariant'];
  maxTextChars?: number;
  maxDialogItems?: number;
}>): Readonly<{
  dialog: HappierReplayDialogItem[];
  latestSynopsisText: string | null;
  /** Examined rows the decoder could not read; see `decryptTranscriptReplayCore`. */
  unreadableRowCount: number;
}> {
  return decryptTranscriptReplayCore(params);
}
