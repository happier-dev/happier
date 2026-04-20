import type { DirectSessionActivitySample, DirectSessionTranscriptPage, DirectSessionTranscriptReadAfter } from '@/session/directSessions/providerOps';

export type ClaudeJsonlSessionStorePageOlderParams = Readonly<{
    cursor?: string;
    maxBytes: number;
    maxItems: number;
}>;

export type ClaudeJsonlSessionStoreReadAfterParams = Readonly<{
    cursor: string;
    maxBytes: number;
    maxItems: number;
}>;

export type ClaudeJsonlSessionStoreActivity = DirectSessionActivitySample;
export type ClaudeJsonlSessionStorePageResult = DirectSessionTranscriptPage;
export type ClaudeJsonlSessionStoreReadAfterResult = DirectSessionTranscriptReadAfter;
