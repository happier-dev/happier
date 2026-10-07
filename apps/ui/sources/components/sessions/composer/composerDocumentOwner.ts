import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ComposerAttachmentDraftV1, ComposerAttachmentViewV1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import type { ComposerCapabilitiesV1, ComposerSnapshotV1, ComposerTransactionResultV1 } from '@happier-dev/protocol/plugins/ui/composer';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import { composerRefsV1Equal } from '@happier-dev/protocol/plugins/ui/composerRef';

import type { ComposerStructuredInputMention } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { reconcileStructuredInputMentionsWithText } from '@/components/sessions/agentInput/structuredInputMentions';
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

export type ComposerDraftDocumentFieldChanges = Readonly<{
    text: boolean;
    structuredInputMentions: boolean;
    composerAttachments: boolean;
}>;

export type ComposerDraftClearAcceptedResult = Readonly<{
    changed: boolean;
    changes: ComposerDraftDocumentFieldChanges;
    acceptedFieldsCurrent: ComposerDraftDocumentFieldChanges;
}>;

const NO_COMPOSER_DOCUMENT_CHANGES: ComposerDraftDocumentFieldChanges = Object.freeze({
    text: false,
    structuredInputMentions: false,
    composerAttachments: false,
});

export type ComposerDraftClearReason = 'discarded' | 'scopeClosed' | 'submissionAccepted';

export interface ComposerDocumentOwner {
    readonly ref: ComposerRefV1;
    readonly capabilities: ComposerCapabilitiesV1;
    read(): { document: ComposerDraftDocument; revision: number };
    observe(listener: () => void): () => void;
    apply(expectedRevision: number, mutation: ComposerPresentationDocumentMutation): ComposerTransactionResultV1;
    captureCurrentness(): ComposerDraftFieldCurrentness;
    clearAccepted(currentness: ComposerDraftFieldCurrentness): ComposerDraftClearAcceptedResult;
    clear(reason: ComposerDraftClearReason): void;
}

export type MutableComposerDocumentOwner = ComposerDocumentOwner & Readonly<{
    /** Replaces the complete canonical document for host-owned seed hydration. */
    replaceDocument(document: ComposerDraftDocument): number;
}>;

/**
 * Promotes the live residual from an accepted source into a known destination
 * without turning the route into another draft owner. Only destination fields
 * whose seeded accepted value is still current are replaced, so a concurrent
 * destination edit survives the handoff.
 */
export function promoteAcceptedComposerDocument(input: Readonly<{
    residual: ComposerDraftDocument;
    destination: MutableComposerDocumentOwner;
    destinationAcceptedCurrentness: ComposerDraftFieldCurrentness;
}>): void {
    const destinationClear = input.destination.clearAccepted(input.destinationAcceptedCurrentness);
    if (
        !destinationClear.acceptedFieldsCurrent.text
        && !destinationClear.acceptedFieldsCurrent.structuredInputMentions
        && !destinationClear.acceptedFieldsCurrent.composerAttachments
    ) {
        return;
    }
    const destination = input.destination.read().document;

    input.destination.replaceDocument({
        text: destinationClear.acceptedFieldsCurrent.text ? input.residual.text : destination.text,
        structuredInputMentions: destinationClear.acceptedFieldsCurrent.text
            ? input.residual.structuredInputMentions
            : destination.structuredInputMentions,
        composerAttachments: destinationClear.acceptedFieldsCurrent.composerAttachments
            ? input.residual.composerAttachments
            : destination.composerAttachments,
    });
}

const EMPTY_DOCUMENT: ComposerDraftDocument = Object.freeze({
    text: '',
    structuredInputMentions: Object.freeze([]),
    composerAttachments: Object.freeze([]),
});

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

/**
 * A host text edit and a reference edit are separate Composer operations. When
 * the host replaces only text, retain the incumbent exact-occurrence references
 * by rebasing them through the same structured-input text-diff owner used by the
 * mounted input. A caller that supplies a genuinely different reference set
 * remains authoritative for that complete document replacement.
 */
export function reconcileComposerDraftDocumentTextReplacement(
    previous: ComposerDraftDocument,
    next: ComposerDraftDocument,
): ComposerDraftDocument {
    if (
        previous.text === next.text
        || !pluginJsonValuesEqual(previous.structuredInputMentions, next.structuredInputMentions)
    ) {
        return next;
    }
    return {
        ...next,
        structuredInputMentions: reconcileStructuredInputMentionsWithText({
            previousText: previous.text,
            nextText: next.text,
            mentions: previous.structuredInputMentions,
        }),
    };
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
        const next = freezeDocument(reconcileComposerDraftDocumentTextReplacement(document, nextInput));
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
            if (!sameComposerDocumentRef(input.ref, currentness.ref)) {
                return {
                    changed: false,
                    changes: NO_COMPOSER_DOCUMENT_CHANGES,
                    acceptedFieldsCurrent: NO_COMPOSER_DOCUMENT_CHANGES,
                };
            }
            const textCurrent = textMutationRevision === currentness.textMutationRevision;
            const attachmentsCurrent = composerAttachmentsMutationRevision
                === currentness.composerAttachmentsMutationRevision;
            // Text owns the lifetime of every range-bound reference. If the
            // accepted text is still current, clear it and all references in
            // one replacement even when a reference-only transaction happened
            // while admission was in flight. If the text changed, preserve it;
            // replaceDocument already rebased still-valid exact occurrences.
            const textAndMentionsWillClear = textCurrent;
            const nextText = textAndMentionsWillClear ? '' : document.text;
            // "Cleared" is whether this accepted snapshot actually removed
            // something. Reporting true after an A -> B -> A edit, whose text is
            // no longer current and whose other fields were already empty, told
            // the submission owner a draft had been handed off when the live
            // one was untouched.
            const beforeClear = document;
            replaceDocument({
                text: nextText,
                structuredInputMentions: textAndMentionsWillClear ? [] : document.structuredInputMentions,
                composerAttachments: attachmentsCurrent ? [] : document.composerAttachments,
            });
            const changes = readComposerDraftDocumentChanges(beforeClear, document);
            return {
                changed: changes.text || changes.structuredInputMentions || changes.composerAttachments,
                changes,
                acceptedFieldsCurrent: {
                    text: textCurrent,
                    structuredInputMentions: textCurrent,
                    composerAttachments: attachmentsCurrent,
                },
            };
        },
        clear: () => {
            replaceDocument(EMPTY_DOCUMENT);
        },
        replaceDocument,
    };
    return Object.freeze(owner);
}
