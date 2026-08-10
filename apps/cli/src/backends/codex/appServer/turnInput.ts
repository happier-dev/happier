import {
    readHappierStructuredInputV1FromMeta,
    readStructuredInputMentionSourcesV1,
    type HappierStructuredInputV1Envelope,
} from '@happier-dev/protocol';

type MetadataRecord = Record<string, unknown>;

export type CodexAppServerTurnInputItem =
    | Readonly<{ type: 'text'; text: string }>
    | Readonly<{ type: 'mention'; name: string; path: string }>
    | Readonly<{ type: 'skill'; name: string; path: string }>
    | Readonly<{ type: 'image'; url: string }>
    | Readonly<{ type: 'localImage'; path: string }>;

function asRecord(value: unknown): MetadataRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function asRecordArray(value: unknown): MetadataRecord[] {
    return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is MetadataRecord => Boolean(entry)) : [];
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeAttachmentPath(value: unknown): string | null {
    const path = readString(value);
    return path ? path.replace(/[\\]+/g, '/') : null;
}

function collectTrustedLocalImagePaths(
    metadata: MetadataRecord | null,
    explicitPaths: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
    const trusted = new Set<string>();
    for (const path of explicitPaths ?? []) {
        const normalized = normalizeAttachmentPath(path);
        if (normalized) trusted.add(normalized);
    }

    return trusted.size > 0 ? trusted : undefined;
}

function readAttachmentInputs(envelope: HappierStructuredInputV1Envelope | null): CodexAppServerTurnInputItem[] {
    const attachments = asRecordArray(envelope?.imageInputs).concat(asRecordArray(envelope?.attachments));
    const items: CodexAppServerTurnInputItem[] = [];
    for (const attachment of attachments) {
        const mimeType = readString(attachment.mimeType);
        const kind = readString(attachment.kind);
        if (kind !== 'image' && !mimeType?.toLowerCase().startsWith('image/')) {
            continue;
        }
        const localPath = readString(attachment.localPath ?? attachment.path);
        if (localPath) {
            items.push({ type: 'localImage', path: localPath });
            continue;
        }
        const url = readString(attachment.url);
        if (url) {
            items.push({ type: 'image', url });
        }
    }
    return items;
}

export function buildCodexAppServerTurnInput(params: Readonly<{
    text: string;
    metadata?: unknown;
    trustedLocalImagePaths?: ReadonlySet<string>;
}>): CodexAppServerTurnInputItem[] {
    const metadataRecord = asRecord(params.metadata);
    const trustedLocalImagePaths = collectTrustedLocalImagePaths(metadataRecord, params.trustedLocalImagePaths);
    // The canonical meta reader owns envelope sanitization and the meta-root alias fold
    // (SB-9). It replaces this module's own re-read plus the `.concat()` that had no dedupe.
    const envelope = metadataRecord
        ? readHappierStructuredInputV1FromMeta(metadataRecord, {
            allowedLocalImagePaths: trustedLocalImagePaths,
        })
        : null;
    // D-4: `mentions[]` is the authoritative reference enumeration when present, so a
    // dual-written envelope can never produce a second turn item for the same reference.
    // The host resolver reconstructs provider context into the per-kind arrays before
    // dispatch (D-3/INV-9); an unresolved `mentions[]` contributes no native item here.
    const mentionSources = readStructuredInputMentionSourcesV1(envelope);
    const input: CodexAppServerTurnInputItem[] = [{ type: 'text', text: params.text }];

    for (const mention of mentionSources.vendorPluginMentions) {
        const path = readString(mention.vendorPluginRef ?? mention.mentionPath ?? mention.path);
        if (!path) continue;
        input.push({
            type: 'mention',
            name: readString(mention.label ?? mention.displayName ?? mention.name) ?? path,
            path,
        });
    }

    for (const skill of mentionSources.skillMentions) {
        const path = readString(skill.path);
        const name = readString(skill.name ?? skill.displayName);
        if (!path || !name) continue;
        input.push({ type: 'skill', name, path });
    }

    input.push(...readAttachmentInputs(envelope));
    return input;
}
