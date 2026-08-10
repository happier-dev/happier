import {
    MENTION_KIND_V1,
    admitMentionRefsV1ForText,
    buildMentionRefForKindV1,
    resolveSkillCatalogItemIdentityV1,
    sanitizeMentionRefsV1,
    type MentionRefV1,
} from '@happier-dev/protocol';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';

/**
 * The composer mention shape is declared once, by the schema that persists it
 * (`sync/domains/input/draftValues/sessionDraftValueTypes.ts`), and re-exported here for the
 * composer's consumers (SB-4, D-19). It used to be declared a second time in this module as
 * hand-written TS; both declarations were mutually assignable because every drifted field is
 * optional, so the type system could never see the divergence.
 *
 * `kind` is an OPEN string (D-12), so a draft written by a newer build survives being loaded,
 * reconciled and re-saved by an older one instead of being discarded or reinterpreted (INV-4).
 * The range reconciler below is generic over `tokenText`/`start`/`end`, so an unknown mention
 * shifts and disappears with its token exactly like a known one.
 */
import type {
    ComposerSessionMention,
    ComposerSkillMention,
    ComposerStructuredInputMention,
    ComposerStructuredInputMentionPayload,
    ComposerUnknownMention,
    ComposerVendorPluginMention,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

export type {
    ComposerSessionMention,
    ComposerSkillMention,
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

type LegacyVendorPluginMentionRecord = Omit<ComposerVendorPluginMention, 'kind' | 'tokenText' | 'start' | 'end'>;
type LegacySkillMentionRecord = Omit<
    ComposerSkillMention,
    'kind' | 'tokenText' | 'start' | 'end' | 'id' | 'projectionRef' | 'backendId' | 'agentId'
>;

type StructuredInputEnvelope = Readonly<{
    v: 1;
    mentions?: ReadonlyArray<MentionRefV1>;
    vendorPluginMentions?: ReadonlyArray<LegacyVendorPluginMentionRecord>;
    skillMentions?: ReadonlyArray<LegacySkillMentionRecord>;
    attachments?: ReadonlyArray<StructuredInputImageInput>;
}>;

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

function isComposerSessionMention(
    mention: ComposerStructuredInputMention,
): mention is ComposerSessionMention {
    return mention.kind === 'session' && 'sessionId' in mention;
}

/**
 * What one composer mention contributes to the canonical `mentions[]` array.
 *
 * `unreferenceable` is the case that decides whether dual writing is safe for this message:
 * a mention that HAS a legacy projection but no derivable canonical identity would be written
 * to the legacy array and then made invisible by D-4's precedence rule, because a reader that
 * finds `mentions` ignores the legacy arrays entirely. So one unreferenceable mention keeps
 * the whole message on the legacy shape rather than silently losing it.
 *
 * `inert` is different and safe: an unknown kind has no legacy projection to lose, so it is
 * simply not enumerable by this build (INV-4).
 */
type MentionRefWrite =
    | Readonly<{ status: 'reference'; reference: MentionRefV1 }>
    | Readonly<{ status: 'inert' }>
    | Readonly<{ status: 'unreferenceable' }>;

function resolveMentionRefWrite(mention: ComposerStructuredInputMention): MentionRefWrite {
    const range = { token: mention.tokenText, start: mention.start, end: mention.end };

    if (isComposerVendorPluginMention(mention)) {
        return {
            status: 'reference',
            reference: {
                kind: MENTION_KIND_V1.vendorPlugin,
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, mention.vendorPluginRef),
                ...range,
                ...(mention.label ? { label: mention.label } : {}),
            },
        };
    }

    if (isComposerSkillMention(mention)) {
        // The SAME derivation the send-time resolver runs over the live catalog item
        // (`resolveSkillCatalogItemIdentityV1`), so a reference written here is the one the
        // host looks up. `path` is never identity: it is worktree-local and goes stale.
        const identity = resolveSkillCatalogItemIdentityV1(mention);
        if (!identity) return { status: 'unreferenceable' };
        return {
            status: 'reference',
            reference: {
                kind: MENTION_KIND_V1.skill,
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, identity.id),
                ...range,
                label: mention.displayName ?? mention.name,
            },
        };
    }

    if (isComposerSessionMention(mention)) {
        return {
            status: 'reference',
            reference: {
                kind: MENTION_KIND_V1.session,
                // Relative, no authority component (D-8): the containing session's server is
                // already the only server this reference can mean.
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, mention.sessionId),
                ...range,
                ...(mention.label ? { label: mention.label } : {}),
            },
        };
    }

    const unknown = mention as ComposerUnknownMention;
    if (typeof unknown.ref !== 'string' || unknown.ref.length === 0) return { status: 'inert' };
    return {
        status: 'reference',
        reference: {
            kind: unknown.kind,
            ref: unknown.ref,
            ...range,
            ...(unknown.label ? { label: unknown.label } : {}),
        },
    };
}

function mentionRefRangeKey(reference: MentionRefV1): string {
    return `${reference.kind}\u0000${reference.ref}\u0000${reference.start}\u0000${reference.end}`;
}

function buildLegacyVendorPluginRecord(mention: ComposerVendorPluginMention): LegacyVendorPluginMentionRecord {
    return {
        vendorPluginRef: mention.vendorPluginRef,
        ...(mention.label ? { label: mention.label } : {}),
        ...(mention.backendId ? { backendId: mention.backendId } : {}),
        ...(mention.agentId ? { agentId: mention.agentId } : {}),
    };
}

/**
 * The legacy record keeps exactly the fields it carried before dual writing (R-10). The
 * identity fields (`id`, `projectionRef`, `backendId`, `agentId`) stay out of it on purpose:
 * they exist so the canonical reference can be derived, and the send-time resolver rebuilds
 * this record from the live catalog with the same six fields.
 */
function buildLegacySkillRecord(mention: ComposerSkillMention): LegacySkillMentionRecord {
    return {
        name: mention.name,
        ...(mention.path ? { path: mention.path } : {}),
        ...(mention.displayName ? { displayName: mention.displayName } : {}),
        ...(mention.description ? { description: mention.description } : {}),
        ...(mention.origin ? { origin: mention.origin } : {}),
        ...(mention.projectionKind ? { projectionKind: mention.projectionKind } : {}),
    };
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
        && previousText.charCodeAt(previousText.length - 1 - suffix) === nextText.charCodeAt(nextText.length - 1 - suffix)
    ) {
        suffix += 1;
    }

    const previousEnd = previousText.length - suffix;
    const nextEnd = nextText.length - suffix;
    return {
        previousStart: prefix,
        previousEnd,
        nextEnd,
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
}>): Readonly<{
    previousStart: number;
    previousEnd: number;
    nextEnd: number;
    delta: number;
}> | null {
    const previousSelection = clampSelection(args.previousSelection, args.previousText.length);
    const selectedLength = previousSelection.end - previousSelection.start;
    const insertedLength = args.nextText.length - (args.previousText.length - selectedLength);
    if (insertedLength < 0) return null;

    const nextEnd = previousSelection.start + insertedLength;
    if (nextEnd > args.nextText.length) return null;

    if (
        previousSelection.start > 0
        && args.previousText.charCodeAt(previousSelection.start - 1)
            !== args.nextText.charCodeAt(previousSelection.start - 1)
    ) {
        return null;
    }

    if (
        previousSelection.end < args.previousText.length
        && nextEnd < args.nextText.length
        && args.previousText.charCodeAt(previousSelection.end) !== args.nextText.charCodeAt(nextEnd)
    ) {
        return null;
    }

    return {
        previousStart: previousSelection.start,
        previousEnd: previousSelection.end,
        nextEnd,
        delta: args.nextText.length - args.previousText.length,
    };
}

function tokenSurvives(text: string, mention: ComposerStructuredInputMention): boolean {
    return text.slice(mention.start, mention.end) === mention.tokenText;
}

function reconcileStructuredInputMentionsWithChangedSpan(args: Readonly<{
    nextText: string;
    mentions: readonly ComposerStructuredInputMention[];
    change: Readonly<{
        previousStart: number;
        previousEnd: number;
        nextEnd: number;
        delta: number;
    }>;
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
            if (tokenSurvives(args.nextText, shifted)) {
                nextMentions.push(shifted);
            }
            continue;
        }

        if (changeAfterMention && tokenSurvives(args.nextText, mention)) {
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
        return args.mentions.filter((mention) => tokenSurvives(args.nextText, mention));
    }

    const change = findChangedSpan(args.previousText, args.nextText);
    return reconcileStructuredInputMentionsWithChangedSpan({
        nextText: args.nextText,
        mentions: args.mentions,
        change,
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
        return args.mentions.filter((mention) => tokenSurvives(args.nextText, mention));
    }

    const change = resolveSelectionChangedSpan({
        previousText: args.previousText,
        nextText: args.nextText,
        previousSelection: args.previousSelection,
    }) ?? findChangedSpan(args.previousText, args.nextText);

    return reconcileStructuredInputMentionsWithChangedSpan({
        nextText: args.nextText,
        mentions: args.mentions,
        change,
    });
}

export function createStructuredInputMentionFromSuggestion(args: Readonly<{
    suggestion: AutocompleteSuggestion;
    start: number;
}>): ComposerStructuredInputMention | null {
    const structuredInput = args.suggestion.structuredInput;
    if (!structuredInput) return null;

    const tokenText = args.suggestion.text;
    const base = {
        tokenText,
        start: args.start,
        end: args.start + tokenText.length,
    };

    return { ...structuredInput, ...base };
}

/**
 * Dual writing (EU-6): `mentions[]` is the canonical enumeration and the legacy per-kind
 * arrays are a PROJECTION of it — same membership, same order, deduplicated by `{kind, ref}`
 * (D-26). Building the legacy arrays independently would let the two shapes disagree, and
 * D-4's precedence rule makes any such disagreement invisible rather than loud: a reader that
 * finds `mentions` ignores the legacy arrays entirely.
 */
function buildEnvelope(args: Readonly<{
    mentions?: readonly ComposerStructuredInputMention[];
    text?: string;
    attachments?: readonly StructuredInputImageInput[];
}>): StructuredInputEnvelope | null {
    const composerMentions = args.mentions ?? [];
    const writes = composerMentions.map(resolveMentionRefWrite);
    const canWriteReferences = !writes.some((write) => write.status === 'unreferenceable');

    const mentionByRangeKey = new Map<string, ComposerStructuredInputMention>();
    const candidateReferences: MentionRefV1[] = [];
    if (canWriteReferences) {
        for (let index = 0; index < writes.length; index += 1) {
            const write = writes[index]!;
            if (write.status !== 'reference') continue;
            candidateReferences.push(write.reference);
            mentionByRangeKey.set(mentionRefRangeKey(write.reference), composerMentions[index]!);
        }
    }
    // `sanitizeMentionRefsV1` canonicalizes order and drops overlaps; the text-composed half of
    // the range contract is applied here too, so what ships already satisfies the admission
    // step the request boundary re-applies.
    const sanitizedReferences = sanitizeMentionRefsV1(candidateReferences);
    const references = typeof args.text === 'string'
        ? admitMentionRefsV1ForText(args.text, sanitizedReferences)
        : sanitizedReferences;

    const vendorPluginMentions: LegacyVendorPluginMentionRecord[] = [];
    const skillMentions: LegacySkillMentionRecord[] = [];
    if (canWriteReferences) {
        const projected = new Set<string>();
        for (const reference of references) {
            const dedupeKey = `${reference.kind} ${reference.ref}`;
            if (projected.has(dedupeKey)) continue;
            projected.add(dedupeKey);
            const mention = mentionByRangeKey.get(mentionRefRangeKey(reference));
            if (!mention) continue;
            if (isComposerVendorPluginMention(mention)) vendorPluginMentions.push(buildLegacyVendorPluginRecord(mention));
            else if (isComposerSkillMention(mention)) skillMentions.push(buildLegacySkillRecord(mention));
        }
    } else {
        // Fallback: this message carries a mention with no derivable canonical identity, so it
        // stays on the pre-EU-6 shape byte for byte rather than losing that mention.
        for (const mention of composerMentions) {
            if (isComposerVendorPluginMention(mention)) vendorPluginMentions.push(buildLegacyVendorPluginRecord(mention));
            else if (isComposerSkillMention(mention)) skillMentions.push(buildLegacySkillRecord(mention));
        }
    }

    const attachments = [...(args.attachments ?? [])];

    if (
        references.length === 0
        && vendorPluginMentions.length === 0
        && skillMentions.length === 0
        && attachments.length === 0
    ) {
        return null;
    }

    return {
        v: 1,
        ...(references.length > 0 ? { mentions: references } : {}),
        ...(vendorPluginMentions.length > 0 ? { vendorPluginMentions } : {}),
        ...(skillMentions.length > 0 ? { skillMentions } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
    };
}

export function buildStructuredInputMetaOverrides(args: Readonly<{
    mentions?: readonly ComposerStructuredInputMention[];
    text?: string;
    attachments?: readonly StructuredInputImageInput[];
}>): Record<string, unknown> {
    const text = args.text;
    const survivingMentions = typeof text === 'string'
        ? (args.mentions ?? []).filter((mention) => tokenSurvives(text, mention))
        : (args.mentions ?? []);
    const envelope = buildEnvelope({
        mentions: survivingMentions,
        ...(typeof text === 'string' ? { text } : {}),
        ...(args.attachments ? { attachments: args.attachments } : {}),
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
    const attachments = mergeArrays(leftEnvelope.attachments, rightEnvelope.attachments);

    if (mentions || vendorPluginMentions || skillMentions || attachments) {
        merged.happierStructuredInputV1 = {
            v: 1,
            // `mentions` is rebuilt here like every other array: dropping it would silently
            // downgrade a dual-written message to legacy-only the moment an attachment
            // envelope is merged into it.
            ...(mentions ? { mentions } : {}),
            ...(vendorPluginMentions ? { vendorPluginMentions } : {}),
            ...(skillMentions ? { skillMentions } : {}),
            ...(attachments ? { attachments } : {}),
        };
    }

    return merged;
}
