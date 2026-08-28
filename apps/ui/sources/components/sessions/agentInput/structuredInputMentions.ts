import {
    MENTION_KIND_V1,
    admitMentionRefsV1ForText,
    buildMentionRefForKindV1,
    readComposerReferenceMentionV1,
    resolveSkillCatalogItemIdentityV1,
    resolveSkillCatalogOriginV1,
    sanitizeMentionRefsV1,
    type ComposerAttachmentDraftV1,
    type MentionRefV1,
} from '@happier-dev/protocol';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';

/**
 * The composer mention shape is declared once, by the schema that persists it
 * (`sync/domains/input/draftValues/sessionDraftValueTypes.ts`), and re-exported here for
 * the composer's consumers (SB-4, D-19). It used to be declared a second time in this
 * module as hand-written TS; the two drifted, and the strict persisted arm silently
 * stripped the skill provider context this file's envelope writer reads.
 *
 * `kind` is an OPEN string (D-12), so a draft written by a newer build survives being
 * loaded, reconciled and re-saved by an older one instead of being discarded or
 * reinterpreted (INV-4). The range reconciler below is generic over
 * `tokenText`/`start`/`end`, so an unknown mention shifts and disappears with its token
 * exactly like a known one.
 */
import type {
    ComposerSkillMention,
    ComposerReferenceMention,
    ComposerStructuredInputMention,
    ComposerStructuredInputMentionPayload,
    ComposerUnknownMention,
    ComposerVendorPluginMention,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

export type {
    ComposerSkillMention,
    ComposerReferenceMention,
    ComposerStructuredInputMention,
    ComposerStructuredInputMentionPayload,
    ComposerUnknownMention,
    ComposerVendorPluginMention,
};

export type StructuredInputImageInput = Readonly<{
    type: 'localImage' | 'image';
    kind?: 'image';
    path?: string;
    localPath?: string;
    url?: string;
    name?: string;
    mimeType?: string;
    sizeBytes?: number;
    sha256?: string;
    provenance?: Readonly<{ kind: 'sessionAttachmentUpload' }>;
}>;

type StructuredInputEnvelope = Readonly<{
    v: 1;
    mentions?: ReadonlyArray<MentionRefV1>;
    vendorPluginMentions?: ReadonlyArray<Omit<ComposerVendorPluginMention, 'kind' | 'tokenText' | 'start' | 'end'>>;
    skillMentions?: ReadonlyArray<Omit<ComposerSkillMention, 'kind' | 'tokenText' | 'start' | 'end'>>;
    imageInputs?: ReadonlyArray<StructuredInputImageInput>;
    composerAttachments?: ReadonlyArray<ComposerAttachmentDraftV1>;
}>;

/**
 * `id` is deliberately not projected into the legacy per-kind arrays: they
 * retain provider context for supported older readers, while the additive
 * Protocol `mentions[]` field carries catalog identity for current readers.
 */
function canonicalizeSkillMentionForWrite(
    mention: ComposerSkillMention,
): Omit<ComposerSkillMention, 'kind' | 'tokenText' | 'start' | 'end' | 'id'> {
    // One owner for the legacy origin table: the skill catalog schema
    // (`packages/protocol/src/runtime/catalog/skills.ts`), which is also the
    // producer of the canonical `(origin, backendId, projectionRef)` triple the
    // composer's catalog reader normalizes into.
    const legacy = resolveSkillCatalogOriginV1(mention.origin);
    const origin = legacy.origin === 'vendor' || mention.backendId || mention.agentId
        ? 'vendor'
        : legacy.origin === 'happier' || mention.projectionRef || mention.projectionKind
            ? 'happier'
            : undefined;
    const projectionRef = mention.projectionRef ?? legacy.projectionRef;
    const backendId = mention.backendId ?? legacy.backendId;
    return {
        name: mention.name,
        ...(mention.path ? { path: mention.path } : {}),
        ...(mention.displayName ? { displayName: mention.displayName } : {}),
        ...(mention.description ? { description: mention.description } : {}),
        ...(origin ? { origin } : {}),
        ...(mention.projectionKind ? { projectionKind: mention.projectionKind } : {}),
        ...(projectionRef ? { projectionRef } : {}),
        ...(backendId ? { backendId } : {}),
        ...(mention.agentId ? { agentId: mention.agentId } : {}),
    };
}

function isComposerVendorPluginMention(
    mention: ComposerStructuredInputMention,
): mention is ComposerVendorPluginMention {
    return mention.kind === 'vendorPlugin' && 'vendorPluginRef' in mention;
}

function isComposerSkillMention(
    mention: ComposerStructuredInputMention,
): mention is ComposerSkillMention {
    return mention.kind === 'skill' && 'name' in mention;
}

function isComposerUnknownMention(
    mention: ComposerStructuredInputMention,
): mention is ComposerUnknownMention {
    return !isComposerVendorPluginMention(mention) && !isComposerSkillMention(mention);
}

/**
 * A provider companion crosses this boundary only when the Protocol reader
 * recognizes the exact persisted reference. This keeps arbitrary unknown
 * draft fields inert while preserving the one public provider identity that
 * the send-time owner must resolve.
 */
function isComposerReferenceMention(
    mention: ComposerUnknownMention,
): mention is ComposerReferenceMention {
    return readComposerReferenceMentionV1({
        kind: mention.kind,
        ...(mention.ref ? { ref: mention.ref } : {}),
        ...(mention.label ? { label: mention.label } : {}),
        token: mention.tokenText,
        ...(mention.composerReference
            ? { composerReference: mention.composerReference }
            : {}),
    }) !== null;
}

/**
 * A legacy vendor/skill mention without a derivable canonical identity must keep the whole
 * message on legacy arrays. D-4 gives `mentions[]` precedence, so dual-writing that one
 * mention alongside referenceable siblings would otherwise make it silently disappear.
 * Unknown kinds without a reference are inert instead: they have no legacy projection to
 * preserve and must not be coerced into one.
 */
type MentionRefWrite =
    | Readonly<{ status: 'reference'; reference: MentionRefV1 }>
    | Readonly<{ status: 'inert' }>
    | Readonly<{ status: 'unreferenceable' }>;

/**
 * The UI has one small adapter from its positional draft binding to the
 * Protocol-owned reference wire. Known built-ins derive identity through the
 * same Protocol catalog owner the send-time resolver uses; unknown kinds carry
 * only their opaque Protocol identity and are never interpreted locally.
 */
function resolveMentionRefWrite(mention: ComposerStructuredInputMention): MentionRefWrite {
    const token = { token: mention.tokenText };
    if (isComposerVendorPluginMention(mention)) {
        return {
            status: 'reference',
            reference: {
                kind: MENTION_KIND_V1.vendorPlugin,
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, mention.vendorPluginRef),
                ...token,
                ...(mention.label ? { label: mention.label } : {}),
            },
        };
    }
    if (isComposerSkillMention(mention)) {
        const identity = resolveSkillCatalogItemIdentityV1(mention);
        if (!identity) return { status: 'unreferenceable' };
        return {
            status: 'reference',
            reference: {
                kind: MENTION_KIND_V1.skill,
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, identity.id),
                ...token,
                label: mention.displayName ?? mention.name,
            },
        };
    }
    if (!isComposerUnknownMention(mention) || !mention.ref) return { status: 'inert' };
    return {
        status: 'reference',
        reference: {
            kind: mention.kind,
            ref: mention.ref,
            ...token,
            ...(mention.label ? { label: mention.label } : {}),
            ...(isComposerReferenceMention(mention)
                ? { composerReference: mention.composerReference }
                : {}),
        },
    };
}

/** The reference identity (D-26): what `sanitizeMentionRefsV1` already deduplicates on. */
function mentionRefIdentityKey(reference: MentionRefV1): string {
    return `${reference.kind}\u0000${reference.ref}`;
}

/** Exact editable-draft ownership. The downstream Message reference remains positionless. */
export function structuredInputMentionSurvivesText(
    text: string,
    mention: ComposerStructuredInputMention,
): boolean {
    return text.slice(mention.start, mention.end) === mention.tokenText;
}

function findChangedSpan(previousText: string, nextText: string): Readonly<{
    previousStart: number;
    previousEnd: number;
    nextEnd: number;
    delta: number;
}> {
    let prefix = 0;
    const maxPrefix = Math.min(previousText.length, nextText.length);
    while (prefix < maxPrefix && previousText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) {
        prefix += 1;
    }

    let suffix = 0;
    const previousRemaining = previousText.length - prefix;
    const nextRemaining = nextText.length - prefix;
    while (
        suffix < previousRemaining
        && suffix < nextRemaining
        && previousText.charCodeAt(previousText.length - 1 - suffix)
            === nextText.charCodeAt(nextText.length - 1 - suffix)
    ) {
        suffix += 1;
    }

    return {
        previousStart: prefix,
        previousEnd: previousText.length - suffix,
        nextEnd: nextText.length - suffix,
        delta: nextText.length - previousText.length,
    };
}

function clampSelection(
    selection: Readonly<{ start: number; end: number }>,
    textLength: number,
): Readonly<{ start: number; end: number }> {
    const start = Number.isFinite(selection.start)
        ? Math.min(Math.max(0, Math.trunc(selection.start)), textLength)
        : textLength;
    const end = Number.isFinite(selection.end)
        ? Math.min(Math.max(start, Math.trunc(selection.end)), textLength)
        : start;
    return { start, end };
}

function resolveSelectionChangedSpan(args: Readonly<{
    previousText: string;
    nextText: string;
    previousSelection: Readonly<{ start: number; end: number }>;
}>): ReturnType<typeof findChangedSpan> | null {
    const selection = clampSelection(args.previousSelection, args.previousText.length);
    const insertedLength = args.nextText.length - (args.previousText.length - (selection.end - selection.start));
    if (insertedLength < 0) return null;
    const nextEnd = selection.start + insertedLength;
    if (nextEnd > args.nextText.length) return null;
    if (
        selection.start > 0
        && args.previousText.charCodeAt(selection.start - 1) !== args.nextText.charCodeAt(selection.start - 1)
    ) return null;
    if (
        selection.end < args.previousText.length
        && nextEnd < args.nextText.length
        && args.previousText.charCodeAt(selection.end) !== args.nextText.charCodeAt(nextEnd)
    ) return null;
    return {
        previousStart: selection.start,
        previousEnd: selection.end,
        nextEnd,
        delta: args.nextText.length - args.previousText.length,
    };
}

function reconcileStructuredInputMentionsWithChangedSpan(args: Readonly<{
    nextText: string;
    mentions: readonly ComposerStructuredInputMention[];
    change: ReturnType<typeof findChangedSpan>;
}>): ComposerStructuredInputMention[] {
    const nextMentions: ComposerStructuredInputMention[] = [];
    for (const mention of args.mentions) {
        const changeBeforeMention = args.change.previousEnd <= mention.start;
        const changeAfterMention = args.change.previousStart >= mention.end;
        if (changeBeforeMention) {
            const shifted = {
                ...mention,
                start: mention.start + args.change.delta,
                end: mention.end + args.change.delta,
            };
            if (structuredInputMentionSurvivesText(args.nextText, shifted)) nextMentions.push(shifted);
            continue;
        }
        if (changeAfterMention && structuredInputMentionSurvivesText(args.nextText, mention)) {
            nextMentions.push(mention);
        }
    }
    return nextMentions;
}

export function reconcileStructuredInputMentionsWithText(args: Readonly<{
    previousText: string;
    nextText: string;
    mentions: readonly ComposerStructuredInputMention[];
}>): ComposerStructuredInputMention[] {
    if (args.mentions.length === 0) return [];
    if (args.previousText === args.nextText) {
        return args.mentions.filter((mention) => structuredInputMentionSurvivesText(args.nextText, mention));
    }
    return reconcileStructuredInputMentionsWithChangedSpan({
        nextText: args.nextText,
        mentions: args.mentions,
        change: findChangedSpan(args.previousText, args.nextText),
    });
}

export function reconcileStructuredInputMentionsWithTextChange(args: Readonly<{
    previousText: string;
    nextText: string;
    previousSelection: Readonly<{ start: number; end: number }>;
    mentions: readonly ComposerStructuredInputMention[];
}>): ComposerStructuredInputMention[] {
    if (args.mentions.length === 0) return [];
    if (args.previousText === args.nextText) {
        return args.mentions.filter((mention) => structuredInputMentionSurvivesText(args.nextText, mention));
    }
    return reconcileStructuredInputMentionsWithChangedSpan({
        nextText: args.nextText,
        mentions: args.mentions,
        change: resolveSelectionChangedSpan(args) ?? findChangedSpan(args.previousText, args.nextText),
    });
}

export function createStructuredInputMentionFromSuggestion(args: Readonly<{
    suggestion: AutocompleteSuggestion;
    start: number;
}>): ComposerStructuredInputMention | null {
    const structuredInput = args.suggestion.structuredInput;
    if (!structuredInput) return null;

    // The payload is carried through unchanged. It used to be rebuilt field by field with a
    // `kind: 'skill'` fallthrough for anything that was not `vendorPlugin`, which meant a
    // reference of an unknown kind was silently reinterpreted as a skill (INV-4).
    const tokenText = args.suggestion.text;
    return {
        ...structuredInput,
        tokenText,
        start: args.start,
        end: args.start + tokenText.length,
    };
}

function buildEnvelope(args: Readonly<{
    mentions?: readonly ComposerStructuredInputMention[];
    text?: string;
    attachments?: readonly StructuredInputImageInput[];
    composerAttachments?: readonly ComposerAttachmentDraftV1[];
}>): StructuredInputEnvelope | null {
    const composerMentions = args.mentions ?? [];
    const writes = composerMentions.map(resolveMentionRefWrite);
    const canWriteReferences = !writes.some((write) => write.status === 'unreferenceable');
    const mentionByIdentity = new Map<string, ComposerStructuredInputMention>();
    const candidateReferences: MentionRefV1[] = [];
    if (canWriteReferences) {
        for (let index = 0; index < writes.length; index += 1) {
            const write = writes[index]!;
            if (write.status !== 'reference') continue;
            candidateReferences.push(write.reference);
            const key = mentionRefIdentityKey(write.reference);
            if (!mentionByIdentity.has(key)) {
                mentionByIdentity.set(key, composerMentions[index]!);
            }
        }
    }
    const sanitizedReferences = sanitizeMentionRefsV1(candidateReferences);
    const references = typeof args.text === 'string'
        ? admitMentionRefsV1ForText(args.text, sanitizedReferences)
        : sanitizedReferences;
    const vendorPluginMentions: Array<Omit<ComposerVendorPluginMention, 'kind' | 'tokenText' | 'start' | 'end'>> = [];
    const skillMentions: Array<Omit<ComposerSkillMention, 'kind' | 'tokenText' | 'start' | 'end'>> = [];
    if (canWriteReferences) {
        for (const reference of references) {
            const mention = mentionByIdentity.get(mentionRefIdentityKey(reference));
            if (!mention) continue;
            if (isComposerVendorPluginMention(mention)) {
                vendorPluginMentions.push({
                    vendorPluginRef: mention.vendorPluginRef,
                    ...(mention.label ? { label: mention.label } : {}),
                    ...(mention.backendId ? { backendId: mention.backendId } : {}),
                    ...(mention.agentId ? { agentId: mention.agentId } : {}),
                });
            } else if (isComposerSkillMention(mention)) {
                skillMentions.push(canonicalizeSkillMentionForWrite(mention));
            }
        }
    } else {
        for (const mention of composerMentions) {
            if (isComposerVendorPluginMention(mention)) {
                vendorPluginMentions.push({
                    vendorPluginRef: mention.vendorPluginRef,
                    ...(mention.label ? { label: mention.label } : {}),
                    ...(mention.backendId ? { backendId: mention.backendId } : {}),
                    ...(mention.agentId ? { agentId: mention.agentId } : {}),
                });
            } else if (isComposerSkillMention(mention)) {
                skillMentions.push(canonicalizeSkillMentionForWrite(mention));
            }
        }
    }
    const imageInputs = [...(args.attachments ?? [])];
    const composerAttachments = [...(args.composerAttachments ?? [])];

    if (
        references.length === 0
        && vendorPluginMentions.length === 0
        && skillMentions.length === 0
        && imageInputs.length === 0
        && composerAttachments.length === 0
    ) {
        return null;
    }

    return {
        v: 1,
        ...(references.length > 0 ? { mentions: references } : {}),
        ...(vendorPluginMentions.length > 0 ? { vendorPluginMentions } : {}),
        ...(skillMentions.length > 0 ? { skillMentions } : {}),
        ...(imageInputs.length > 0 ? { imageInputs } : {}),
        ...(composerAttachments.length > 0 ? { composerAttachments } : {}),
    };
}

export function buildStructuredInputMetaOverrides(args: Readonly<{
    mentions?: readonly ComposerStructuredInputMention[];
    text?: string;
    attachments?: readonly StructuredInputImageInput[];
    composerAttachments?: readonly ComposerAttachmentDraftV1[];
}>): Record<string, unknown> {
    const text = args.text;
    const survivingMentions = typeof text === 'string'
        ? (args.mentions ?? []).filter((mention) => structuredInputMentionSurvivesText(text, mention))
        : (args.mentions ?? []);
    const envelope = buildEnvelope({
        mentions: survivingMentions,
        ...(typeof text === 'string' ? { text } : {}),
        ...(args.attachments ? { attachments: args.attachments } : {}),
        ...(args.composerAttachments ? { composerAttachments: args.composerAttachments } : {}),
    });
    return envelope ? { happierStructuredInputV1: envelope } : {};
}

function readStructuredEnvelope(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const envelope = meta?.happierStructuredInputV1;
    return envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        ? envelope as Record<string, unknown>
        : {};
}

function mergeArrays(left: unknown, right: unknown): unknown[] | undefined {
    const out = [
        ...(Array.isArray(left) ? left : []),
        ...(Array.isArray(right) ? right : []),
    ];
    return out.length > 0 ? out : undefined;
}

export function mergeMessageMetaOverrides(
    left?: Record<string, unknown> | null,
    right?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
    if (!left && !right) return undefined;
    const merged: Record<string, unknown> = {
        ...(left ?? {}),
        ...(right ?? {}),
    };
    const leftEnvelope = readStructuredEnvelope(left);
    const rightEnvelope = readStructuredEnvelope(right);
    const mentions = mergeArrays(leftEnvelope.mentions, rightEnvelope.mentions);
    const vendorPluginMentions = mergeArrays(leftEnvelope.vendorPluginMentions, rightEnvelope.vendorPluginMentions);
    const skillMentions = mergeArrays(leftEnvelope.skillMentions, rightEnvelope.skillMentions);
    const composerAttachments = mergeArrays(leftEnvelope.composerAttachments, rightEnvelope.composerAttachments);
    const imageInputs = mergeArrays(
        [...(Array.isArray(leftEnvelope.imageInputs) ? leftEnvelope.imageInputs : []), ...(Array.isArray(leftEnvelope.attachments) ? leftEnvelope.attachments : [])],
        [...(Array.isArray(rightEnvelope.imageInputs) ? rightEnvelope.imageInputs : []), ...(Array.isArray(rightEnvelope.attachments) ? rightEnvelope.attachments : [])],
    );

    if (mentions || vendorPluginMentions || skillMentions || imageInputs || composerAttachments) {
        merged.happierStructuredInputV1 = {
            v: 1,
            ...(mentions ? { mentions } : {}),
            ...(vendorPluginMentions ? { vendorPluginMentions } : {}),
            ...(skillMentions ? { skillMentions } : {}),
            ...(imageInputs ? { imageInputs } : {}),
            ...(composerAttachments ? { composerAttachments } : {}),
        };
    }

    return merged;
}
