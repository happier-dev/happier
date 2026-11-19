import * as React from 'react';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { MENTION_KIND_V1, buildMentionRefV1, parseMentionRefV1, readMentionRefOpaqueForKindV1, type MentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { readHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/sessions/userMessageRpc';
import { readStructuredInputMentionSourcesV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { INLINE_REFERENCE_ATTACHMENT_SCHEME_V1, scanInlineReferenceTokensV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { readComposerReferenceMentionV1 } from '@happier-dev/protocol/runtime/input/composerReferenceProviderV1';
import { formatSessionInputMentionMarkerV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import type { MarkdownInlineReference } from '@/components/markdown/markdownInlineReferences';
import { parseHappierMetaEnvelope, readTranscriptAttachmentsMeta } from '../structured/happierMetaEnvelope';
import { parseSessionMediaMessageMeta } from '@/sync/domains/session/media/sessionMediaMessageMeta';
import { resolveSessionMediaInlineRenderableImageMimeType } from '@/components/sessions/media/presentation';
import { parseMarkdownSyntax } from '@/components/markdown/streaming/splitMarkdownIntoBlockSources';

import { extractWorkspaceFileMentions } from '@/components/sessions/linkedFiles/extractWorkspaceFileMentions';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { projectMessageNicknameReferences, type InlineSessionReferenceTarget } from './messageNicknameReferences';

/** One detection for inline chips, legacy rows and the hand-typed file scan (O1). */

export type TranscriptFileReference = Readonly<{
    kind: 'file';
    path: string;
}>;

export type TranscriptSessionReference = Readonly<{
    kind: 'session';
    sessionId: string;
    /** Advisory display text captured when the reference was composed; never identity. */
    label: string | null;
}>;

export type TranscriptStructuredReference = TranscriptFileReference | TranscriptSessionReference;

export type InlineMessageReference = Readonly<{
    ref: string;
    kind: string;
    label: string;
    marker: string;
    /** Mention bindings require this exact authored token; attachment labels remain advisory. */
    token?: string;
    /** Eligible occurrences in this projection's source, excluding Markdown code. */
    tokenStarts?: ReadonlySet<number>;
    glyph: NonNullable<MarkdownInlineReference['glyph']>;
    path?: string;
    sessionId?: string;
    sessionTarget?: InlineSessionReferenceTarget;
    /**
     * The Agent mark a reference leads with when no live Session identity supplies one (a native
     * child's agent is its parent's provider). A `sessionId` target's live Agent wins.
     */
    agentId?: string;
    attachmentId?: string;
    mediaId?: string;
    imageNumber?: number;
}>;

export type MessageStructuredReferences = Readonly<{
    inline: ReadonlyMap<string, InlineMessageReference>;
    row: readonly TranscriptStructuredReference[];
    /** Message image order, keyed by upload id or canonical session-media:<id>. */
    imageNumbers: ReadonlyMap<string, number>;
    /** Display-only source. The committed message and its authored metadata stay intact. */
    markdown?: string;
    hasAuthoredInline?: boolean;
    projectFindRange?: (range: FindTextRange) => FindTextRange;
}>;

type MessageReferenceInput = Readonly<{
    meta: unknown;
    text: string;
    ownSessionId?: string;
    nicknameTargets?: ReadonlyMap<string, InlineSessionReferenceTarget>;
}>;

/** Uploaded file/folder presentation is shared by Session and resource-backed readers. */
export function projectMessageAttachmentReference(attachment: Readonly<{
    id: string;
    name: string;
    kind: 'file' | 'folder';
    path?: string;
    imageNumber?: number;
}>): InlineMessageReference {
    const imageNumber = attachment.imageNumber;
    return {
        ref: buildMentionRefV1(INLINE_REFERENCE_ATTACHMENT_SCHEME_V1, attachment.id),
        kind: 'attachment', attachmentId: attachment.id,
        ...(attachment.path === undefined ? {} : { path: attachment.path }),
        label: imageNumber ? `Image #${imageNumber}` : attachment.name,
        marker: imageNumber ? `[Image #${imageNumber}]` : `[${attachment.kind === 'folder' ? 'Folder' : 'File'}: ${attachment.name}]`,
        glyph: imageNumber ? 'preview' : 'file',
        ...(imageNumber ? { imageNumber } : {}),
    };
}

const NO_REFERENCES: readonly TranscriptStructuredReference[] = Object.freeze([]);
const NO_PROJECTION: MessageStructuredReferences = Object.freeze({ inline: new Map(), row: NO_REFERENCES, imageNumbers: new Map() });
const messageProjections = new WeakMap<object, Readonly<{
    input: MessageReferenceInput;
    projection: MessageStructuredReferences;
}>>();

/** The authored destinations admitted by the same envelope that feeds message references. */
export function readMessageMentionedSessionIds(meta: unknown): readonly string[] {
    const { mentions } = readStructuredInputMentionSourcesV1(readHappierStructuredInputV1FromMeta(meta));
    return mentions.flatMap(mention => {
        if (mention.kind !== MENTION_KIND_V1.session) return [];
        const sessionId = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.session, mention.ref);
        return sessionId === null ? [] : [sessionId];
    });
}

/** Shared authored-token eligibility; code never acquires a live reference. */
export function readEligibleMessageInlineReferenceTokens(text: string): ReturnType<typeof scanInlineReferenceTokensV1> {
    const tokens = scanInlineReferenceTokensV1(text);
    if (tokens.length === 0) return tokens;
    const codeRanges: Array<Readonly<{ start: number; end: number }>> = [];
    parseMarkdownSyntax(text).iterate({ enter(node) {
        if (node.name !== 'InlineCode' && node.name !== 'FencedCode' && node.name !== 'CodeBlock') return;
        codeRanges.push({ start: node.from, end: node.to });
        return false;
    } });
    return tokens.filter(token => !codeRanges.some(range => token.start >= range.start && token.end <= range.end));
}

/** Eligibility stays with the typed projection even when multiple tokens share one destination. */
export function resolveInlineMessageReference(
    inline: MessageStructuredReferences['inline'], ref: string, sourceToken?: string, sourceStart?: number,
): InlineMessageReference | null {
    const reference = inline.get(ref);
    return reference && (sourceToken === undefined || reference.token === undefined || reference.token === sourceToken)
        && (sourceStart === undefined || reference.tokenStarts === undefined || reference.tokenStarts.has(sourceStart))
        ? reference : null;
}

export function projectMessageMentionReference(mention: MentionRefV1, tokenLabel: string): InlineMessageReference | null {
    const ref = parseMentionRefV1(mention.ref);
    if (!ref) return null;
    const base = { ref: mention.ref, kind: mention.kind, token: mention.token, label: mention.label ?? tokenLabel,
        marker: formatSessionInputMentionMarkerV1({ ...mention, label: mention.label ?? tokenLabel }) };
    switch (mention.kind) {
        case MENTION_KIND_V1.file: {
            const path = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.file, mention.ref);
            if (path === null || !isSafeWorkspaceRelativePath(path)) return null;
            return { ...base, path, glyph: 'file' };
        }
        case MENTION_KIND_V1.session: {
            const sessionId = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.session, mention.ref);
            return sessionId === null ? null : { ...base, sessionId, glyph: 'conversations', sessionTarget: { kind: 'session', sessionId } };
        }
        case MENTION_KIND_V1.skill:
            return ref.scheme === 'skill' ? { ...base, glyph: 'terminal' } : null;
        case MENTION_KIND_V1.vendorPlugin:
            return ref.scheme === 'vendorPlugin' ? { ...base, glyph: 'settings' } : null;
        case MENTION_KIND_V1.workflow:
            return ref.scheme === 'workflow' ? { ...base, glyph: 'action' } : null;
        case MENTION_KIND_V1.widget:
            return ref.scheme === 'widget' ? { ...base, glyph: 'board' } : null;
        default: {
            const contributed = readComposerReferenceMentionV1(mention);
            return contributed ? { ...base, glyph: 'mention' } : null;
        }
    }
}

/**
 * D-26: a reference repeated at several composer positions is one row. Identity is
 * `{kind, ref}`, expressed here on the decoded payload so an envelope file reference and the
 * same path found by the text scan collapse to a single chip.
 */
function referenceIdentity(reference: TranscriptStructuredReference): string {
    return reference.kind === 'file'
        ? `file\u0000${reference.path}`
        : `session\u0000${reference.sessionId}`;
}

/**
 * `ownSessionId` is the Session whose transcript renders the message. Stored mentions keep every
 * participant (the provider prompt needs them), but the reference row is what the person sees, and
 * a Session never lists itself in its own transcript. Inline chips are authored words and stay.
 */
export function resolveMessageStructuredReferences(input: MessageReferenceInput): MessageStructuredReferences {
    const envelope = readHappierStructuredInputV1FromMeta(input.meta);
    // D-4 precedence lives at one owner: with `mentions` present the legacy per-kind arrays
    // and meta-root aliases are ignored entirely.
    const { mentions } = readStructuredInputMentionSourcesV1(envelope);
    const tokens = readEligibleMessageInlineReferenceTokens(input.text);
    const inline = new Map<string, InlineMessageReference & { tokenStarts: Set<number> }>();
    const attachments = readTranscriptAttachmentsMeta(input.meta)?.attachments ?? [];
    const primary = parseHappierMetaEnvelope(input.meta);
    const media = parseSessionMediaMessageMeta(primary?.kind === 'session_media.v1' ? primary : parseHappierMetaEnvelope(input.meta, 'happierMedia'));
    const mediaById = new Map((media?.inlineImages ?? []).filter(item => item.status !== 'unavailable').map(item => [item.id, item]));
    const imageNumbers = new Map<string, number>();
    const addImage = (id: string) => { if (!imageNumbers.has(id)) imageNumbers.set(id, imageNumbers.size + 1); };
    for (const image of envelope?.imageInputs ?? []) addImage(image.id);
    for (const attachment of attachments) {
        if (resolveSessionMediaInlineRenderableImageMimeType(attachment)) addImage(attachment.id ?? attachment.path);
    }
    for (const attachment of envelope?.composerAttachments ?? []) {
        if (attachment.content && mediaById.has(attachment.content.mediaId)) addImage(`session-media:${attachment.content.mediaId}`);
    }
    const attachmentReferences = new Map<string, InlineMessageReference>();
    for (const attachment of attachments) {
        const imageNumber = imageNumbers.get(attachment.id ?? attachment.path);
        if (!attachment.id) continue;
        const reference = projectMessageAttachmentReference({ ...attachment, id: attachment.id,
            kind: attachment.mimeType === 'inode/directory' ? 'folder' : 'file', imageNumber });
        attachmentReferences.set(reference.ref, reference);
    }
    for (const attachment of envelope?.composerAttachments ?? []) {
        const ref = buildMentionRefV1(INLINE_REFERENCE_ATTACHMENT_SCHEME_V1, attachment.instanceId);
        const imageNumber = attachment.content ? imageNumbers.get(`session-media:${attachment.content.mediaId}`) : undefined;
        attachmentReferences.set(ref, {
            ref, kind: 'attachment', attachmentId: attachment.instanceId,
            label: imageNumber ? `Image #${imageNumber}` : attachment.presentation.label,
            marker: imageNumber ? `[Image #${imageNumber}]` : `[File: ${attachment.presentation.label}]`,
            glyph: attachment.presentation.icon ?? (imageNumber ? 'preview' : 'file'),
            ...(imageNumber ? { imageNumber } : {}),
            ...(attachment.content ? { mediaId: attachment.content.mediaId } : {}),
        });
    }
    for (const token of tokens) {
        const mention = mentions.find((entry) => entry.ref === token.ref && entry.token === input.text.slice(token.start, token.end));
        const reference = mention ? projectMessageMentionReference(mention, token.label) : attachmentReferences.get(token.ref);
        if (reference) {
            const previous = inline.get(token.ref);
            if (previous) previous.tokenStarts.add(token.start);
            else inline.set(token.ref, { ...reference, tokenStarts: new Set([token.start]) });
        }
    }

    const references: TranscriptStructuredReference[] = [];
    const seen = new Set<string>();
    for (const reference of inline.values()) {
        if (reference.kind === MENTION_KIND_V1.file) seen.add(`file\u0000${reference.path}`);
        if (reference.kind === MENTION_KIND_V1.session) seen.add(`session\u0000${reference.sessionId}`);
    }
    const add = (reference: TranscriptStructuredReference): void => {
        if (reference.kind === 'session' && reference.sessionId === input.ownSessionId) return;
        const identity = referenceIdentity(reference);
        if (seen.has(identity)) return;
        seen.add(identity);
        references.push(reference);
    };

    for (const mention of mentions) {
        if (scanInlineReferenceTokensV1(mention.token).length > 0) continue;
        // The kind decides first, and `readMentionRefOpaqueForKindV1` then requires the ref's
        // scheme to match that kind. A reference whose kind this build does not know — or whose
        // ref disagrees with its kind — produces no row instead of falling through to a known
        // kind (INV-4).
        if (mention.kind === MENTION_KIND_V1.session) {
            const sessionId = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.session, mention.ref);
            if (sessionId !== null) add({ kind: 'session', sessionId, label: mention.label ?? null });
            continue;
        }
        if (mention.kind === MENTION_KIND_V1.file) {
            const path = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.file, mention.ref);
            if (path !== null && isSafeWorkspaceRelativePath(path)) add({ kind: 'file', path });
        }
    }

    let cursor = 0;
    const scanText: string[] = [];
    for (const token of tokens) {
        scanText.push(input.text.slice(cursor, token.start), ' ');
        cursor = token.end;
    }
    scanText.push(input.text.slice(cursor));
    for (const path of extractWorkspaceFileMentions(scanText.join(''))) {
        add({ kind: 'file', path });
    }

    const nicknames = input.nicknameTargets ? projectMessageNicknameReferences(input.text, input.nicknameTargets) : [];
    if (nicknames.length === 0) {
        return inline.size === 0 && references.length === 0 && imageNumbers.size === 0 ? NO_PROJECTION : { inline, row: references, imageNumbers };
    }
    cursor = 0;
    const hasAuthoredInline = inline.size > 0;
    const display: string[] = [];
    let addedLength = 0;
    const displayEdits = nicknames.map(({ start, end, token }) => {
        const displayStart = start + addedLength;
        const displayEnd = displayStart + token.length;
        addedLength = displayEnd - end;
        return { start, end, displayStart, displayEnd };
    });
    const projectOffset = (offset: number, isEnd = false): number => {
        let shift = 0;
        for (const { start, end, displayStart, displayEnd } of displayEdits) {
            if (offset <= start) break;
            if (offset < end) return isEnd ? displayEnd : displayStart;
            shift = displayEnd - end;
        }
        return offset + shift;
    };
    for (const reference of inline.values()) {
        const originalStarts = [...reference.tokenStarts];
        reference.tokenStarts.clear();
        for (const start of originalStarts) reference.tokenStarts.add(projectOffset(start));
    }
    for (const { ref, token, label, start, end, target } of nicknames) {
        display.push(input.text.slice(cursor, start), token);
        cursor = end;
        const previous = inline.get(ref);
        if (previous) {
            previous.tokenStarts.add(projectOffset(start));
            continue;
        }
        inline.set(ref, {
            ref, token, label, marker: label, kind: MENTION_KIND_V1.session, glyph: 'conversations',
            sessionTarget: target, tokenStarts: new Set([projectOffset(start)]),
            ...(target.kind === 'session' ? { sessionId: target.sessionId } : { agentId: target.agentId }),
        });
    }
    display.push(input.text.slice(cursor));
    return {
        inline, row: references, imageNumbers, markdown: display.join(''), hasAuthoredInline,
        projectFindRange: range => ({ ...range, start: projectOffset(range.start), end: projectOffset(range.end, true) }),
    };
}

/**
 * `enabled: false` is the streaming case: the agent block renders plain text while a turn is
 * still arriving, and a half-arrived path must not flash a chip.
 */
export function useMessageStructuredReferences(
    input: MessageReferenceInput & Readonly<{ enabled?: boolean; message?: object }>,
): MessageStructuredReferences {
    const enabled = input.enabled !== false;
    const meta = input.meta;
    const text = input.text;
    const { message, ownSessionId, nicknameTargets } = input;
    return React.useMemo(() => {
        if (!enabled) return NO_PROJECTION;
        const projectionInput = { meta, text, ownSessionId, nicknameTargets };
        const previous = message && nicknameTargets?.size ? messageProjections.get(message) : undefined;
        if (previous && previous.input.meta === meta && previous.input.text === text
            && previous.input.ownSessionId === ownSessionId && previous.input.nicknameTargets === nicknameTargets) {
            return previous.projection;
        }
        const projection = resolveMessageStructuredReferences(projectionInput);
        if (message && nicknameTargets?.size) messageProjections.set(message, { input: projectionInput, projection });
        return projection;
    }, [enabled, message, meta, text, ownSessionId, nicknameTargets]);
}
