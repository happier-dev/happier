import { readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
import * as privacyKit from 'privacy-kit';
import { prismaRuntime } from './prisma';

export interface StoredSessionMessageContent {
    readonly content: PrismaJson.SessionMessageStoredContent;
    readonly contentBytes?: Uint8Array<ArrayBuffer> | null;
}

/** Only SessionMessage's physical representation changes; its wire envelope stays unchanged. */
export function encodeSessionMessageContentForStorage(content: PrismaJson.SessionMessageContent): Readonly<{
    content: PrismaJson.SessionMessageStoredContent;
    contentBytes: Uint8Array<ArrayBuffer> | null;
}> {
    if (content.t === 'plain') return { content, contentBytes: null };
    // Preserve historical opaque strings rather than repairing a noncanonical spelling.
    if (readCanonicalPaddedBase64DecodedLength(content.c) === null) return { content, contentBytes: null };
    return { content: null, contentBytes: privacyKit.decodeBase64(content.c) };
}

/**
 * The required `content` column stores JSON null beside raw bytes. The generated
 * Json type cannot name Prisma's JsonNull sentinel, so this is the one write boundary.
 */
export function toPrismaSessionMessageStoredContent(content: PrismaJson.SessionMessageStoredContent): PrismaJson.SessionMessageStoredContent {
    return (content ?? prismaRuntime.JsonNull) as PrismaJson.SessionMessageStoredContent;
}

export function decodeSessionMessageContentFromStorage(row: StoredSessionMessageContent): PrismaJson.SessionMessageContent {
    if (row.contentBytes != null) return { t: 'encrypted', c: privacyKit.encodeBase64(row.contentBytes) };
    if (row.content === null) throw new Error('Stored SessionMessage content is unavailable');
    return row.content;
}

type DecodedSessionMessage<T extends StoredSessionMessageContent> = Omit<T, 'content' | 'contentBytes'> & {
    content: PrismaJson.SessionMessageContent;
};

export function decodeStoredSessionMessage<T extends StoredSessionMessageContent>(row: T): DecodedSessionMessage<T>;
export function decodeStoredSessionMessage<T extends StoredSessionMessageContent>(row: T | null): DecodedSessionMessage<T> | null;
export function decodeStoredSessionMessage<T extends StoredSessionMessageContent>(row: T | null): DecodedSessionMessage<T> | null {
    if (row === null) return null;
    const { content, contentBytes, ...message } = row;
    return { ...message, content: decodeSessionMessageContentFromStorage(row) };
}

export function decodeStoredSessionMessages<T extends StoredSessionMessageContent>(rows: readonly T[]): DecodedSessionMessage<T>[] {
    return rows.map(row => decodeStoredSessionMessage(row));
}

/** Narrow SQL projections must recognize byte-backed rows without fetching their body. */
export function sessionMessageContentEnvelopeTypeSql(contentBytesColumn: string, legacyEnvelopeType: string): string {
    return 'CASE WHEN ' + contentBytesColumn + " IS NOT NULL THEN 'encrypted' ELSE " + legacyEnvelopeType + ' END';
}
