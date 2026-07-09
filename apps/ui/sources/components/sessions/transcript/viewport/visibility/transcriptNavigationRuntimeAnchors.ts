import { TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';

import type { TranscriptNavigationAnchorCandidate } from './deriveCurrentTranscriptAnchor';
import type { WebTranscriptAnchorRowRect } from './webTranscriptVisibleAnchorFacts';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationRole,
} from '../../navigation/transcriptNavigationTypes';

export type TranscriptNavigationRuntimeAnchorMessage = Readonly<{
    messageId: string;
    routeMessageId: string | null;
    seq: number | null;
    transcriptBlockIndex: number | null;
    role: TranscriptNavigationRole;
}>;

export type TranscriptNavigationRenderedAnchorSource = Readonly<{
    sourceIndex: number;
    messageIds: readonly string[];
    messages: readonly TranscriptNavigationRuntimeAnchorMessage[];
}>;

export type TranscriptNavigationRuntimeAnchor = TranscriptNavigationAnchorCandidate & Readonly<{
    messageIds: readonly string[];
}>;

export type WebTranscriptNavigationAnchorRowSource = Readonly<{
    bottomPx: number;
    testId: string | null;
    topPx: number;
}>;

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.trunc(value);
}

function normalizeRole(role: TranscriptNavigationRole | null | undefined): TranscriptNavigationRole {
    if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role;
    return 'unknown';
}

function dedupeStrings(values: readonly unknown[]): readonly string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const normalized = normalizeString(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

function sourceMatchesEntry(
    source: TranscriptNavigationRenderedAnchorSource,
    entry: TranscriptNavigationEntry,
): boolean {
    const entryRouteMessageId = normalizeString(entry.routeMessageId);
    const entrySeq = normalizeInteger(entry.seq);
    const entryBlockIndex = normalizeInteger(entry.transcriptBlockIndex);
    const entryRole = normalizeRole(entry.role);
    const matchesEntryRowProof = (message: TranscriptNavigationRuntimeAnchorMessage): boolean => {
        if (entrySeq !== null && normalizeInteger(message.seq) !== entrySeq) return false;
        if (entryRole !== 'unknown' && normalizeRole(message.role) !== entryRole) return false;
        const messageBlockIndex = normalizeInteger(message.transcriptBlockIndex);
        return entryBlockIndex === null || messageBlockIndex === entryBlockIndex;
    };

    if (entryRouteMessageId) {
        return source.messages.some((message) => (
            (
                normalizeString(message.routeMessageId) === entryRouteMessageId ||
                normalizeString(message.messageId) === entryRouteMessageId
            ) &&
            matchesEntryRowProof(message)
        ));
    }

    if (entrySeq === null) return false;
    return source.messages.some((message) => {
        if (normalizeInteger(message.seq) !== entrySeq) return false;
        if (entryRole !== 'unknown' && normalizeRole(message.role) !== entryRole) return false;
        const messageBlockIndex = normalizeInteger(message.transcriptBlockIndex);
        return entryBlockIndex === null || messageBlockIndex === entryBlockIndex;
    });
}

export function deriveTranscriptNavigationRuntimeAnchors(params: Readonly<{
    entries: readonly TranscriptNavigationEntry[];
    renderedSources: readonly TranscriptNavigationRenderedAnchorSource[];
}>): TranscriptNavigationRuntimeAnchor[] {
    const anchors: TranscriptNavigationRuntimeAnchor[] = [];
    const seen = new Set<string>();
    for (const entry of params.entries) {
        const id = normalizeString(entry.id);
        if (!id || seen.has(id)) continue;
        const source = params.renderedSources.find((candidate) => (
            normalizeInteger(candidate.sourceIndex) !== null &&
            sourceMatchesEntry(candidate, entry)
        ));
        if (!source) continue;
        anchors.push({
            id,
            kind: entry.kind,
            sourceIndex: normalizeInteger(source.sourceIndex) ?? 0,
            messageIds: dedupeStrings(source.messageIds),
        });
        seen.add(id);
    }
    return anchors;
}

function messageIdFromWebAnchorTestId(testId: string | null): string | null {
    const normalized = normalizeString(testId);
    if (!normalized?.startsWith(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX)) return null;
    return normalizeString(normalized.slice(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX.length));
}

export function deriveWebTranscriptNavigationAnchorRows(params: Readonly<{
    anchors: readonly TranscriptNavigationRuntimeAnchor[];
    rows: readonly WebTranscriptNavigationAnchorRowSource[];
}>): WebTranscriptAnchorRowRect[] {
    const anchorsByMessageId = new Map<string, TranscriptNavigationRuntimeAnchor>();
    for (const anchor of params.anchors) {
        for (const messageId of anchor.messageIds) {
            if (!anchorsByMessageId.has(messageId)) {
                anchorsByMessageId.set(messageId, anchor);
            }
        }
    }

    const out: WebTranscriptAnchorRowRect[] = [];
    const seen = new Set<string>();
    for (const row of params.rows) {
        const messageId = messageIdFromWebAnchorTestId(row.testId);
        if (!messageId) continue;
        const anchor = anchorsByMessageId.get(messageId);
        if (!anchor || seen.has(anchor.id)) continue;
        out.push({
            anchorId: anchor.id,
            bottomPx: row.bottomPx,
            topPx: row.topPx,
        });
        seen.add(anchor.id);
    }
    return out;
}
