import type { FileBackedTranscriptSessionStoreFactory, FileBackedTranscriptSessionStoreKey } from '@/api/session/fileBackedTranscripts/store';

import { createClaudeJsonlSessionStore } from './createClaudeJsonlSessionStore';

export function createClaudeJsonlSessionStoreFactory(): FileBackedTranscriptSessionStoreFactory {
    return async (key: FileBackedTranscriptSessionStoreKey) => createClaudeJsonlSessionStore(key);
}
