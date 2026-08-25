import {
    pluginJsonValuesEqual,
    type ComposerAttachmentDraftV1,
    type ComposerAttachmentViewV1,
    type ComposerCapabilitiesV1,
    type ComposerRefV1,
    type ComposerSnapshotV1,
    type ComposerTransactionResultV1,
} from '@happier-dev/protocol';
import { composerRefsV1Equal } from '@happier-dev/protocol/plugins/ui/composerRef';

import type { ComposerStructuredInputMention } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import {
    composerAttachmentViewToDraft,
    composerStructuredMentionsFromReferences,
} from './composerScopeAdapters';

export type ComposerDraftDocument = Readonly<{
    text: string;
    structuredInputMentions: readonly ComposerStructuredInputMention[];
    composerAttachments: readonly ComposerAttachmentDraftV1[];
}>;

type ComposerMentionRef = ComposerSnapshotV1['references'][number];

export type ComposerPresentationDocumentMutation = Readonly<{
    text: string;
    selection?: NonNullable<ComposerSnapshotV1['selection']>;
    references: readonly ComposerMentionRef[];
    attachments: readonly ComposerAttachmentViewV1[];
}>;

export type ComposerDraftFieldCurrentness = Readonly<{
    ref: ComposerRefV1;
    textMutationRevision: number;
    structuredInputMentionsMutationRevision: number;
    composerAttachmentsMutationRevision: number;
}>;

export type ComposerDraftClearReason = 'discarded' | 'scopeClosed' | 'submissionAccepted';

export interface ComposerDocumentOwner {
    readonly ref: ComposerRefV1;
    readonly capabilities: ComposerCapabilitiesV1;
    read(): { document: ComposerDraftDocument; revision: number };
    observe(listener: () => void): () => void;
    apply(expectedRevision: number, mutation: ComposerPresentationDocumentMutation): ComposerTransactionResultV1;
    captureCurrentness(): ComposerDraftFieldCurrentness;
    clearAccepted(currentness: ComposerDraftFieldCurrentness): boolean;
    clear(reason: ComposerDraftClearReason): void;
}

export type MutableComposerDocumentOwner = ComposerDocumentOwner & Readonly<{
    replaceDocument(document: ComposerDraftDocument): number;
}>;

const EMPTY_DOCUMENT: ComposerDraftDocument = Object.freeze({
    text: '',
    structuredInputMentions: Object.freeze([]),
    composerAttachments: Object.freeze([]),
});

export type ComposerDraftDocumentFieldChanges = Readonly<{
    text: boolean;
    structuredInputMentions: boolean;
    composerAttachments: boolean;
}>;

/**
 * The one Composer semantic-equality rule. Mentions and attachments are strict
 * JSON, so they compare through Protocol's `pluginJsonValuesEqual` owner rather
 * than through serialization: a valid public transaction may supply an
 * equivalent value in another object-key order, and serialization would report
 * that as a mutation in one Composer scope while the durable repository writer
 * — which already delegates to the same owner — treats it as unchanged.
 */
export function readComposerDraftDocumentChanges(
    previous: ComposerDraftDocument,
    next: ComposerDraftDocument,
): ComposerDraftDocumentFieldChanges {
    return {
        text: previous.text !== next.text,
        structuredInputMentions: !pluginJsonValuesEqual(
            previous.structuredInputMentions,
            next.structuredInputMentions,
        ),
        composerAttachments: !pluginJsonValuesEqual(
            previous.composerAttachments,
            next.composerAttachments,
        ),
    };
}

/** The same rule applied to the public attachment projection callers compare. */
export function sameComposerAttachmentViews(
    left: readonly ComposerAttachmentViewV1[],
    right: readonly ComposerAttachmentViewV1[],
): boolean {
    return pluginJsonValuesEqual(left, right);
}

export const sameComposerDocumentRef = composerRefsV1Equal;

function freezeDocument(document: ComposerDraftDocument): ComposerDraftDocument {
    return Object.freeze({
        text: document.text,
        structuredInputMentions: Object.freeze([...document.structuredInputMentions]),
        composerAttachments: Object.freeze([...document.composerAttachments]),
    });
}

function invalidUnsupportedField(field: 'attachments' | 'references'): ComposerTransactionResultV1 {
    return {
        status: 'invalidOperation',
        operationIndex: 0,
        reason: `Composer does not support ${field}`,
    };
}

/**
 * Host-private owner for native/ephemeral composer documents. Durable Session
 * and New Session adapters implement the same interface over the synchronized
 * repository; they do not use this process-local storage implementation.
 */
export function createEphemeralComposerDocumentOwner(input: Readonly<{
    ref: ComposerRefV1;
    capabilities: ComposerCapabilitiesV1;
    initialDocument?: ComposerDraftDocument;
    isCurrent?: () => boolean;
    onDocumentChange?: (document: ComposerDraftDocument) => void;
}>): MutableComposerDocumentOwner {
    let document = freezeDocument(input.initialDocument ?? EMPTY_DOCUMENT);
    let revision = 0;
    let textMutationRevision = 0;
    let structuredInputMentionsMutationRevision = 0;
    let composerAttachmentsMutationRevision = 0;
    const listeners = new Set<() => void>();

    const emit = () => {
        input.onDocumentChange?.(document);
        for (const listener of listeners) listener();
    };

    const replaceDocument = (nextInput: ComposerDraftDocument): number => {
        const next = freezeDocument(nextInput);
        const changes = readComposerDraftDocumentChanges(document, next);
        const textChanged = changes.text;
        const mentionsChanged = changes.structuredInputMentions;
        const attachmentsChanged = changes.composerAttachments;
        if (!textChanged && !mentionsChanged && !attachmentsChanged) return revision;

        document = next;
        revision += 1;
        if (textChanged) textMutationRevision += 1;
        if (mentionsChanged) structuredInputMentionsMutationRevision += 1;
        if (attachmentsChanged) composerAttachmentsMutationRevision += 1;
        emit();
        return revision;
    };

    const owner: MutableComposerDocumentOwner = {
        ref: input.ref,
        capabilities: input.capabilities,
        read: () => ({ document, revision }),
        observe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        apply: (expectedRevision, mutation) => {
            if (input.isCurrent?.() === false) return { status: 'composerUnavailable' };
            if (expectedRevision !== revision) return { status: 'conflict', currentRevision: revision };
            if (!input.capabilities.references && mutation.references.length > 0) {
                return invalidUnsupportedField('references');
            }
            if (!input.capabilities.attachments && mutation.attachments.length > 0) {
                return invalidUnsupportedField('attachments');
            }
            const next: ComposerDraftDocument = {
                text: mutation.text,
                structuredInputMentions: composerStructuredMentionsFromReferences({
                    references: mutation.references,
                    existing: document.structuredInputMentions,
                }),
                composerAttachments: mutation.attachments.map(composerAttachmentViewToDraft),
            };
            return { status: 'applied', revision: replaceDocument(next) };
        },
        captureCurrentness: () => ({
            ref: input.ref,
            textMutationRevision,
            structuredInputMentionsMutationRevision,
            composerAttachmentsMutationRevision,
        }),
        clearAccepted: (currentness) => {
            if (!sameComposerDocumentRef(input.ref, currentness.ref)) return false;
            const textCurrent = textMutationRevision === currentness.textMutationRevision;
            const mentionsCurrent = structuredInputMentionsMutationRevision
                === currentness.structuredInputMentionsMutationRevision;
            const attachmentsCurrent = composerAttachmentsMutationRevision
                === currentness.composerAttachmentsMutationRevision;
            // "Cleared" is whether this accepted snapshot actually removed
            // something. Reporting true after an A -> B -> A edit, whose text is
            // no longer current and whose other fields were already empty, told
            // the submission owner a draft had been handed off when the live
            // one was untouched.
            const revisionBeforeClear = revision;
            replaceDocument({
                text: textCurrent ? '' : document.text,
                structuredInputMentions: mentionsCurrent ? [] : document.structuredInputMentions,
                composerAttachments: attachmentsCurrent ? [] : document.composerAttachments,
            });
            return revision !== revisionBeforeClear;
        },
        clear: () => {
            replaceDocument(EMPTY_DOCUMENT);
        },
        replaceDocument,
    };
    return Object.freeze(owner);
}
