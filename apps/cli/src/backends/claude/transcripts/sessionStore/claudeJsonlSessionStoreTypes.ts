import type { ExternalSessionActivitySample, ExternalSessionTranscriptPage, ExternalSessionTranscriptReadAfter } from '@/session/external/providerOps';

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

export type ClaudeJsonlSessionStoreActivity = ExternalSessionActivitySample;
export type ClaudeJsonlSessionStorePageResult = ExternalSessionTranscriptPage;
export type ClaudeJsonlSessionStoreReadAfterResult = ExternalSessionTranscriptReadAfter;
