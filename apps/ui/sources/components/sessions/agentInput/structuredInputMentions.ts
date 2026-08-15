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
 * The reconciler below is generic over `tokenText`, so an unknown mention disappears with its
 * token exactly like a known one.
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

type LegacyVendorPluginMentionRecord = Omit<ComposerVendorPluginMention, 'kind' | 'tokenText'>;
type LegacySkillMentionRecord = Omit<
    ComposerSkillMention,
    'kind' | 'tokenText' | 'id' | 'projectionRef' | 'backendId' | 'agentId'
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
                ...token,
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
                ...token,
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
            ...token,
            ...(unknown.label ? { label: unknown.label } : {}),
        },
    };
}

/** The reference identity (D-26): what `sanitizeMentionRefsV1` already deduplicates on. */
function mentionRefIdentityKey(reference: MentionRefV1): string {
    return `${reference.kind}\u0000${reference.ref}`;
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

/**
 * Whether the composer still carries this mention: its token is somewhere in the text.
 *
 * This is the whole reconciliation rule, and it is deliberately positionless. A mention used
 * to hold `[start, end)` into the composer text, maintained across every edit by a changed-span
 * diff; the offsets were then re-checked at the request boundary against the text actually
 * submitted — which is a TRANSFORM of the composer text (`messageToSend.trim()`, an attachments
 * block, a review-comments wrapper). The offsets were correct for the text they were measured
 * against and wrong for the one that shipped, so the reference was silently dropped and the
 * agent received a bare `@…`. Nothing read a position: `sessionReferenceBlock` and
 * `messageStructuredReferences` both key on `{kind, ref}`.
 */
export function structuredInputMentionSurvivesText(
    text: string,
    mention: ComposerStructuredInputMention,
): boolean {
    return text.includes(mention.tokenText);
}

/**
 * The one reconciler. It runs on live edits and on programmatic text swaps alike, because
 * "does the text still contain this token" needs neither the previous text nor the selection
 * the edit replaced.
 */
export function reconcileStructuredInputMentionsWithText(args: Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
}>): ComposerStructuredInputMention[] {
    if (args.mentions.length === 0) return [];
    return args.mentions.filter((mention) => structuredInputMentionSurvivesText(args.text, mention));
}

export function createStructuredInputMentionFromSuggestion(args: Readonly<{
    suggestion: AutocompleteSuggestion;
}>): ComposerStructuredInputMention | null {
    const structuredInput = args.suggestion.structuredInput;
    if (!structuredInput) return null;
    return { ...structuredInput, tokenText: args.suggestion.text };
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

    const mentionByIdentity = new Map<string, ComposerStructuredInputMention>();
    const candidateReferences: MentionRefV1[] = [];
    if (canWriteReferences) {
        for (let index = 0; index < writes.length; index += 1) {
            const write = writes[index]!;
            if (write.status !== 'reference') continue;
            candidateReferences.push(write.reference);
            const identity = mentionRefIdentityKey(write.reference);
            // First occurrence wins, matching what `sanitizeMentionRefsV1` keeps.
            if (!mentionByIdentity.has(identity)) mentionByIdentity.set(identity, composerMentions[index]!);
        }
    }
    // `sanitizeMentionRefsV1` deduplicates by `{kind, ref}` and enforces the bounds; the
    // text-composed half of the token contract is applied here too, so what ships already
    // satisfies the admission step the request boundary re-applies.
    const sanitizedReferences = sanitizeMentionRefsV1(candidateReferences);
    const references = typeof args.text === 'string'
        ? admitMentionRefsV1ForText(args.text, sanitizedReferences)
        : sanitizedReferences;

    const vendorPluginMentions: LegacyVendorPluginMentionRecord[] = [];
    const skillMentions: LegacySkillMentionRecord[] = [];
    if (canWriteReferences) {
        // No second dedupe pass: `references` is already one entry per `{kind, ref}`.
        for (const reference of references) {
            const mention = mentionByIdentity.get(mentionRefIdentityKey(reference));
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
        ? (args.mentions ?? []).filter((mention) => structuredInputMentionSurvivesText(text, mention))
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
