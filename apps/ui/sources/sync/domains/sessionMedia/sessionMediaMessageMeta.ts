import { AttachmentsMessageMetaV1Schema, type AttachmentsMessageMetaV1 } from '@/sync/domains/attachments/attachmentsMessageMeta';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';
import {
    SessionMediaItemV1Schema,
    SessionMediaMessageMetaEnvelopeV1Schema,
} from '@happier-dev/protocol';

type HappierMetaEnvelope = Readonly<{
    kind: string;
    payload?: unknown;
}>;

export type SessionMediaInlineImageSummary = Readonly<{
    id?: string;
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    width?: number;
    height?: number;
    sha256?: string;
    description?: string;
    category?: 'attachment' | 'generated' | 'tool-artifact';
    role?: 'input' | 'output';
}>;

export type SessionMediaUnavailableSummary = Readonly<{
    id: string;
    category: 'attachment' | 'generated' | 'tool-artifact';
    code: string;
}>;

export type ParsedSessionMediaMessageMeta = Readonly<{
    inlineImages: readonly SessionMediaInlineImageSummary[];
    unavailableMedia: readonly SessionMediaUnavailableSummary[];
    legacyAttachments: AttachmentsMessageMetaV1 | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEnvelope(meta: unknown, key: 'happier' | 'happierMedia' | 'happierAttachments'): HappierMetaEnvelope | null {
    if (!isRecord(meta)) return null;
    const envelope = meta[key];
    if (!isRecord(envelope)) return null;
    return typeof envelope.kind === 'string' ? envelope as HappierMetaEnvelope : null;
}

function normalizeSessionMediaItem(value: unknown): SessionMediaInlineImageSummary | null {
    const parsed = SessionMediaItemV1Schema.safeParse(value);
    if (!parsed.success) return null;
    const item = parsed.data;

    return {
        id: item.id,
        name: item.name,
        path: item.path,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
        ...(item.sha256 ? { sha256: item.sha256 } : {}),
        ...(item.description ? { description: item.description } : {}),
        category: item.category,
        role: item.role,
    };
}

export function selectToolResultSessionMediaMeta(
    message: Readonly<{ meta?: MessageMeta; content: readonly Readonly<{ type: string }>[] }>,
    toolCallId: string,
): MessageMeta | undefined {
    // Only a bundled result needs splitting. A single result already owns its
    // metadata, including ACP sidechains whose display call id is namespaced.
    if (!message.meta || message.content.filter(part => part.type === 'tool-result').length < 2) return message.meta;
    let selected = message.meta;
    let toolCallIdHash: string | undefined;
    for (const key of ['happier', 'happierMedia'] as const) {
        const parsed = SessionMediaMessageMetaEnvelopeV1Schema.safeParse(readEnvelope(message.meta, key));
        if (!parsed.success) continue;
        const payload = parsed.data.payload;
        const media = payload.media.filter(item => !item.origin.toolCallId || item.origin.toolCallId === toolCallId);
        const unavailable = payload.unavailable?.filter(item => {
            if (!item.origin.toolCallIdHash) return true;
            toolCallIdHash ??= bytesToHex(sha256(utf8ToBytes(toolCallId)));
            return item.origin.toolCallIdHash === toolCallIdHash;
        });
        selected = { ...selected, [key]: { ...parsed.data, payload: {
            ...payload, media, ...(unavailable ? { unavailable } : {}),
        } } };
    }
    return selected;
}

function parseSessionMediaEnvelope(envelope: HappierMetaEnvelope | null): Readonly<{
    inlineImages: readonly SessionMediaInlineImageSummary[];
    unavailableMedia: readonly SessionMediaUnavailableSummary[];
}> {
    if (envelope === null) return { inlineImages: [], unavailableMedia: [] };
    const parsed = SessionMediaMessageMetaEnvelopeV1Schema.safeParse(envelope);
    if (!parsed.success) return { inlineImages: [], unavailableMedia: [] };
    return {
        inlineImages: parsed.data.payload.media.flatMap((item) => {
            const normalized = normalizeSessionMediaItem(item);
            return normalized ? [normalized] : [];
        }),
        unavailableMedia: (parsed.data.payload.unavailable ?? []).map((item) => ({
            id: item.id,
            category: item.category,
            code: item.code,
        })),
    };
}

export function normalizeAttachmentMetaToSessionMedia(
    attachments: AttachmentsMessageMetaV1['attachments'],
): readonly SessionMediaInlineImageSummary[] {
    return attachments.map((attachment) => ({
        name: attachment.name,
        path: attachment.path,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        sizeBytes: attachment.sizeBytes,
        ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
        category: 'attachment',
        role: 'input',
    }));
}

function parseLegacyAttachmentsMeta(meta: unknown): AttachmentsMessageMetaV1 | null {
    const primaryEnvelope = readEnvelope(meta, 'happier');
    const envelope = primaryEnvelope?.kind === 'attachments.v1'
        ? primaryEnvelope
        : readEnvelope(meta, 'happierAttachments');
    if (envelope?.kind !== 'attachments.v1') return null;
    const parsed = AttachmentsMessageMetaV1Schema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.attachments.length === 0) return null;
    return parsed.data;
}

export function parseSessionMediaMessageMeta(meta: unknown): ParsedSessionMediaMessageMeta {
    const primaryMedia = parseSessionMediaEnvelope(readEnvelope(meta, 'happier'));
    const secondaryMedia = parseSessionMediaEnvelope(readEnvelope(meta, 'happierMedia'));
    const legacyAttachments = parseLegacyAttachmentsMeta(meta);
    const legacyMedia = legacyAttachments ? normalizeAttachmentMetaToSessionMedia(legacyAttachments.attachments) : [];

    return {
        inlineImages: [...primaryMedia.inlineImages, ...secondaryMedia.inlineImages, ...legacyMedia],
        unavailableMedia: [...primaryMedia.unavailableMedia, ...secondaryMedia.unavailableMedia],
        legacyAttachments,
    };
}

export function hasSessionMediaRenderItems(meta: unknown): boolean {
    const parsed = parseSessionMediaMessageMeta(meta);
    return parsed.inlineImages.length > 0 || parsed.unavailableMedia.length > 0;
}
