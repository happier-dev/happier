import {
    normalizeSessionAttachmentUploadPath,
    readStructuredInputMentionSourcesV1,
    sanitizeHappierStructuredInputV1,
    type HappierStructuredInputV1,
} from '@happier-dev/plugin-sdk/sessions';

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

/**
 * The host verifies uploaded attachment bytes (digest and size) before a structured input envelope
 * can reach a plugin runtime: `sessionUserMessageSend` resolves the trusted upload paths at
 * admission, and the session queue re-reads the envelope through the canonical meta reader. A
 * plugin runtime cannot reach that verifier, so the envelope's own declared upload paths are the
 * trust basis here. Sanitization still enforces the upload-path shape and the upload provenance
 * stamp, so a crafted envelope cannot promote an arbitrary local file to an image item.
 */
function readHostVerifiedLocalImagePaths(envelope: MetadataRecord): ReadonlySet<string> {
    const paths = new Set<string>();
    for (const entry of [
        ...asRecordArray(envelope.imageInputs),
        ...asRecordArray(envelope.attachments),
    ]) {
        const uploadPath = normalizeSessionAttachmentUploadPath(entry.path ?? entry.localPath);
        if (uploadPath) paths.add(uploadPath);
    }
    return paths;
}

function readStructuredInput(value: unknown): HappierStructuredInputV1 | null {
    const envelope = asRecord(value);
    if (!envelope) return null;
    try {
        return sanitizeHappierStructuredInputV1(envelope, {
            allowedLocalImagePaths: readHostVerifiedLocalImagePaths(envelope),
        });
    } catch {
        // `AgentSessionInput.structuredInput` also carries execution-run intent payloads
        // (see the review plugins' `request.input.structuredInput` readers), which are not Happier
        // structured input. A payload that is not a structured input envelope contributes no turn
        // items instead of failing the turn.
        return null;
    }
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
    structuredInput?: unknown;
}>): CodexAppServerTurnInputItem[] {
    const structuredInput = readStructuredInput(params.structuredInput);
    // D-4: `mentions[]` is the authoritative reference enumeration when present, so a
    // dual-written envelope can never produce a second turn item for the same reference.
    // The host resolver reconstructs provider context into the per-kind arrays before
    // dispatch (D-3/INV-9); an unresolved `mentions[]` contributes no native item here.
    const mentionSources = readStructuredInputMentionSourcesV1(structuredInput);
    const input: CodexAppServerTurnInputItem[] = [{ type: 'text', text: params.text }];

    for (const mention of asRecordArray(mentionSources.vendorPluginMentions)) {
        const mentionPath = readString(mention.vendorPluginRef ?? mention.mentionPath ?? mention.path);
        if (!mentionPath) continue;
        input.push({
            type: 'mention',
            name: readString(mention.label ?? mention.displayName ?? mention.name) ?? mentionPath,
            path: mentionPath,
        });
    }

    for (const skill of asRecordArray(mentionSources.skillMentions)) {
        const path = readString(skill.path);
        const name = readString(skill.name ?? skill.displayName);
        if (!path || !name) continue;
        input.push({ type: 'skill', name, path });
    }

    input.push(...readImageInputs(structuredInput));
    return input;
}
