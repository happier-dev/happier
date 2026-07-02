import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';

export type ComposerVendorPluginMention = Readonly<{
    kind: 'vendorPlugin';
    tokenText: string;
    start: number;
    end: number;
    vendorPluginRef: string;
    label?: string;
    backendId?: string;
    agentId?: string;
}>;

export type ComposerSkillMention = Readonly<{
    kind: 'skill';
    tokenText: string;
    start: number;
    end: number;
    name: string;
    path?: string;
    displayName?: string;
    description?: string;
    origin?: string;
    projectionKind?: string;
    projectionRef?: string;
    backendId?: string;
    agentId?: string;
}>;

export type ComposerStructuredInputMention = ComposerVendorPluginMention | ComposerSkillMention;

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
    vendorPluginMentions?: ReadonlyArray<Omit<ComposerVendorPluginMention, 'kind' | 'tokenText' | 'start' | 'end'>>;
    skillMentions?: ReadonlyArray<Omit<ComposerSkillMention, 'kind' | 'tokenText' | 'start' | 'end'>>;
    imageInputs?: ReadonlyArray<StructuredInputImageInput>;
}>;

const LEGACY_VENDOR_SKILL_BACKENDS = {
    codex_native: 'codex',
    opencode_native: 'opencode',
    claude_native: 'claude',
    pi_native: 'pi',
} as const;

const LEGACY_HAPPIER_SKILL_ORIGINS = new Set(['happier_projected', 'text_fallback_only']);

function readLegacyVendorSkillBackend(origin: string): string | null {
    return Object.prototype.hasOwnProperty.call(LEGACY_VENDOR_SKILL_BACKENDS, origin)
        ? LEGACY_VENDOR_SKILL_BACKENDS[origin as keyof typeof LEGACY_VENDOR_SKILL_BACKENDS]
        : null;
}

function canonicalizeSkillMentionForWrite(
    mention: ComposerSkillMention,
): Omit<ComposerSkillMention, 'kind' | 'tokenText' | 'start' | 'end'> {
    const legacyVendorBackendId = mention.origin ? readLegacyVendorSkillBackend(mention.origin) : null;
    const legacyHappierProjectionRef = mention.origin && LEGACY_HAPPIER_SKILL_ORIGINS.has(mention.origin)
        ? mention.origin
        : null;
    const origin = mention.origin === 'vendor' || legacyVendorBackendId || mention.backendId || mention.agentId
        ? 'vendor'
        : mention.origin === 'happier' || legacyHappierProjectionRef || mention.projectionRef || mention.projectionKind
            ? 'happier'
            : undefined;
    return {
        name: mention.name,
        ...(mention.path ? { path: mention.path } : {}),
        ...(mention.displayName ? { displayName: mention.displayName } : {}),
        ...(mention.description ? { description: mention.description } : {}),
        ...(origin ? { origin } : {}),
        ...(mention.projectionKind ? { projectionKind: mention.projectionKind } : {}),
        ...(mention.projectionRef ?? legacyHappierProjectionRef ? { projectionRef: mention.projectionRef ?? legacyHappierProjectionRef ?? undefined } : {}),
        ...(mention.backendId ?? legacyVendorBackendId ? { backendId: mention.backendId ?? legacyVendorBackendId ?? undefined } : {}),
        ...(mention.agentId ? { agentId: mention.agentId } : {}),
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

function tokenSurvives(text: string, mention: ComposerStructuredInputMention): boolean {
    return text.slice(mention.start, mention.end) === mention.tokenText;
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
    const nextMentions: ComposerStructuredInputMention[] = [];

    for (const mention of args.mentions) {
        const changeBeforeMention = change.previousEnd <= mention.start;
        const changeAfterMention = change.previousStart >= mention.end;
        if (changeBeforeMention) {
            const shifted = {
                ...mention,
                start: mention.start + change.delta,
                end: mention.end + change.delta,
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

    if (structuredInput.kind === 'vendorPlugin') {
        return {
            ...base,
            kind: 'vendorPlugin',
            vendorPluginRef: structuredInput.vendorPluginRef,
            ...(structuredInput.label ? { label: structuredInput.label } : {}),
            ...(structuredInput.backendId ? { backendId: structuredInput.backendId } : {}),
            ...(structuredInput.agentId ? { agentId: structuredInput.agentId } : {}),
        };
    }

    return {
        ...base,
        kind: 'skill',
        name: structuredInput.name,
        ...(structuredInput.path ? { path: structuredInput.path } : {}),
        ...(structuredInput.displayName ? { displayName: structuredInput.displayName } : {}),
        ...(structuredInput.description ? { description: structuredInput.description } : {}),
        ...(structuredInput.origin ? { origin: structuredInput.origin } : {}),
        ...(structuredInput.projectionKind ? { projectionKind: structuredInput.projectionKind } : {}),
        ...(structuredInput.projectionRef ? { projectionRef: structuredInput.projectionRef } : {}),
        ...(structuredInput.backendId ? { backendId: structuredInput.backendId } : {}),
        ...(structuredInput.agentId ? { agentId: structuredInput.agentId } : {}),
    };
}

function buildEnvelope(args: Readonly<{
    mentions?: readonly ComposerStructuredInputMention[];
    attachments?: readonly StructuredInputImageInput[];
}>): StructuredInputEnvelope | null {
    const vendorPluginMentions = (args.mentions ?? [])
        .filter((mention): mention is ComposerVendorPluginMention => mention.kind === 'vendorPlugin')
        .map(({ vendorPluginRef, label, backendId, agentId }) => ({
            vendorPluginRef,
            ...(label ? { label } : {}),
            ...(backendId ? { backendId } : {}),
            ...(agentId ? { agentId } : {}),
        }));
    const skillMentions = (args.mentions ?? [])
        .filter((mention): mention is ComposerSkillMention => mention.kind === 'skill')
        .map(canonicalizeSkillMentionForWrite);
    const imageInputs = [...(args.attachments ?? [])];

    if (vendorPluginMentions.length === 0 && skillMentions.length === 0 && imageInputs.length === 0) {
        return null;
    }

    return {
        v: 1,
        ...(vendorPluginMentions.length > 0 ? { vendorPluginMentions } : {}),
        ...(skillMentions.length > 0 ? { skillMentions } : {}),
        ...(imageInputs.length > 0 ? { imageInputs } : {}),
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
    const vendorPluginMentions = mergeArrays(leftEnvelope.vendorPluginMentions, rightEnvelope.vendorPluginMentions);
    const skillMentions = mergeArrays(leftEnvelope.skillMentions, rightEnvelope.skillMentions);
    const imageInputs = mergeArrays(
        [...(Array.isArray(leftEnvelope.imageInputs) ? leftEnvelope.imageInputs : []), ...(Array.isArray(leftEnvelope.attachments) ? leftEnvelope.attachments : [])],
        [...(Array.isArray(rightEnvelope.imageInputs) ? rightEnvelope.imageInputs : []), ...(Array.isArray(rightEnvelope.attachments) ? rightEnvelope.attachments : [])],
    );

    if (vendorPluginMentions || skillMentions || imageInputs) {
        merged.happierStructuredInputV1 = {
            v: 1,
            ...(vendorPluginMentions ? { vendorPluginMentions } : {}),
            ...(skillMentions ? { skillMentions } : {}),
            ...(imageInputs ? { imageInputs } : {}),
        };
    }

    return merged;
}
