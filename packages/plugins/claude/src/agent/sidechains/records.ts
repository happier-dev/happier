import type { RawJSONLines } from '../transcripts/rawJsonLines.js';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isClaudePromptRootSidechainUserMessage(record: RawJSONLines): boolean {
    if (record.type !== 'user') return false;
    const row = record as RawJSONLines & { isSidechain?: unknown };
    if (row.isSidechain !== true) return false;
    const message = isRecord(row.message) ? row.message : null;
    if (!message || message.role !== 'user') return false;
    return typeof message.content === 'string';
}

export function markClaudeRecordAsSidechain(record: RawJSONLines, sidechainId: string): RawJSONLines {
    const mutableRecord = record as RawJSONLines & { isSidechain?: boolean; sidechainId?: string };
    mutableRecord.isSidechain = true;
    mutableRecord.sidechainId = sidechainId;
    return mutableRecord;
}
