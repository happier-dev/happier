import {
    readHappierStructuredInputV1FromMeta,
    type HappierStructuredInputV1,
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
    const rawPath = readString(value);
    return rawPath ? rawPath.replace(/[\\]+/g, '/') : null;
}

function collectTrustedLocalImagePaths(
    explicitPaths: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
    const trusted = new Set<string>();
    for (const localPath of explicitPaths ?? []) {
        const normalizedPath = normalizeAttachmentPath(localPath);
        if (normalizedPath) trusted.add(normalizedPath);
    }
    return trusted.size > 0 ? trusted : undefined;
}

function readVendorPluginMentions(structuredInput: HappierStructuredInputV1 | null): MetadataRecord[] {
    return asRecordArray(structuredInput?.vendorPluginMentions);
}

function readSkillMentions(structuredInput: HappierStructuredInputV1 | null): MetadataRecord[] {
    return asRecordArray(structuredInput?.skillMentions);
}

function readImageInputs(structuredInput: HappierStructuredInputV1 | null): CodexAppServerTurnInputItem[] {
    const imageInputs = asRecordArray(structuredInput?.imageInputs);
    const items: CodexAppServerTurnInputItem[] = [];
    for (const imageInput of imageInputs) {
        const kind = readString(imageInput.kind);
        const localPath = kind === 'localImage' ? readString(imageInput.path) : null;
        if (localPath) {
            items.push({ type: 'localImage', path: localPath });
            continue;
        }
        const url = kind === 'image' ? readString(imageInput.url) : null;
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
    const trustedLocalImagePaths = collectTrustedLocalImagePaths(params.trustedLocalImagePaths);
    const structuredInput = metadataRecord
        ? readHappierStructuredInputV1FromMeta(metadataRecord, {
            allowedLocalImagePaths: trustedLocalImagePaths,
        })
        : null;
    const input: CodexAppServerTurnInputItem[] = [{ type: 'text', text: params.text }];

    for (const mention of readVendorPluginMentions(structuredInput)) {
        const mentionPath = readString(mention.vendorPluginRef ?? mention.mentionPath ?? mention.path);
        if (!mentionPath) continue;
        input.push({
            type: 'mention',
            name: readString(mention.label ?? mention.displayName ?? mention.name) ?? mentionPath,
            path: mentionPath,
        });
    }

    for (const skill of readSkillMentions(structuredInput)) {
        const path = readString(skill.path);
        const name = readString(skill.name ?? skill.displayName);
        if (!path || !name) continue;
        input.push({ type: 'skill', name, path });
    }

    input.push(...readImageInputs(structuredInput));
    return input;
}
