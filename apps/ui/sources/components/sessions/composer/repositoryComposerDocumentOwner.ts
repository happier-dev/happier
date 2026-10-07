import { ComposerAttachmentDraftV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { ComposerCapabilitiesV1 } from '@happier-dev/protocol/plugins/ui/composer';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { SessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { StrictJsonValue } from '@happier-dev/protocol/drafts/sessionDrafts';

import {
    readComposerDraftDocumentChanges,
    reconcileComposerDraftDocumentTextReplacement,
    type MutableComposerDocumentOwner,
    type ComposerDraftDocument,
    type ComposerDraftFieldCurrentness,
    sameComposerDocumentRef,
} from '@/components/sessions/composer/composerDocumentOwner';
import {
    composerAttachmentViewToDraft,
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
} from '@/components/sessions/composer/composerScopeAdapters';
import {
    parseComposerStructuredInputMentionsForText,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentnessLocal,
    deleteSessionDraft,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    flushSessionDraft,
    writeExistingSessionDraft,
    writeNewSessionDraft,
    type SessionDraftCurrentness,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

const CAPABILITIES: ComposerCapabilitiesV1 = Object.freeze({
    text: true,
    references: true,
    attachments: true,
    submit: true,
});

const EMPTY_DOCUMENT: ComposerDraftDocument = Object.freeze({
    text: '',
    structuredInputMentions: Object.freeze([]),
    composerAttachments: Object.freeze([]),
});
function strictJson(value: unknown): StrictJsonValue {
    return StrictJsonValueSchema.parse(value);
}

type RepositoryComposerDocumentRead = Readonly<{
    document: ComposerDraftDocument;
    /** The repository's own semantic document revision for this draft. */
    repositoryRevision: number;
}>;

function readRepositoryComposerDocument(
    scope: ServerAccountScope,
    address: Extract<SessionDraftAddressV2, { kind: 'session' | 'run' | 'newSession' }>,
): RepositoryComposerDocumentRead {
    const snapshot = getSessionDraftSnapshot(scope, address);
    if (!snapshot) return { document: EMPTY_DOCUMENT, repositoryRevision: 0 };

    const text = typeof snapshot.document.composer.text.value === 'string'
        ? snapshot.document.composer.text.value
        : '';
    const mentions = parseComposerStructuredInputMentionsForText(
        snapshot.document.composer.mentions.value,
        text,
    );
    const attachments = Array.isArray(snapshot.document.composer.attachments.value)
        ? snapshot.document.composer.attachments.value.flatMap((value) => {
            const parsed = ComposerAttachmentDraftV1Schema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
        })
        : [];
    return {
        document: Object.freeze({
            text,
            structuredInputMentions: Object.freeze(mentions.mentions),
            composerAttachments: Object.freeze(attachments),
        }),
        repositoryRevision: snapshot.revision,
    };
}

/**
 * Semantic Composer adapter over the synchronized draft repository. It owns no
 * persistence and no revision store.
 *
 * A Session draft has an incumbent persisted `documentRevision`, so this owner
 * projects it unchanged: the supported offscreen `composers.get({kind:'session'})`
 * path constructs a fresh owner for every read and apply, and an instance-local
 * counter would restart at zero and let a stale transaction overwrite a newer
 * draft. New Session scopes have no incumbent persisted revision, so they keep
 * one host-private monotonic live revision per instance instead.
 */
export function createRepositoryComposerDocumentOwner(input: Readonly<{
    scope: ServerAccountScope;
    ref: Extract<ComposerRefV1, { kind: 'session' | 'newSession' | 'participantMessage' }>;
    /**
     * Repository identity is deliberately independent from the public composer
     * identity. A Run composer remains a `participantMessage` to plugin and
     * presentation consumers while its document uses the existing synchronized
     * `{ kind: 'run' }` draft address.
     */
    address?: Extract<SessionDraftAddressV2, { kind: 'session' | 'run' | 'newSession' }>;
    isCurrent?: () => boolean;
}>): MutableComposerDocumentOwner {
    const address = input.address ?? (input.ref.kind === 'session'
        ? { kind: 'session' as const, sessionId: input.ref.sessionId }
        : input.ref.kind === 'newSession'
            ? { kind: 'newSession' as const, draftId: input.ref.instanceId }
            : null);
    if (address === null) {
        throw new Error('A participant composer requires an explicit synchronized draft address');
    }
    const projectsRepositoryRevision = address.kind !== 'newSession';
    const initial = readRepositoryComposerDocument(input.scope, address);
    let observed = {
        document: initial.document,
        revision: projectsRepositoryRevision ? initial.repositoryRevision : 0,
    };
    const repositoryCurrentnessByCapture = new WeakMap<ComposerDraftFieldCurrentness, SessionDraftCurrentness>();

    const refresh = () => {
        const next = readRepositoryComposerDocument(input.scope, address);
        const changes = readComposerDraftDocumentChanges(observed.document, next.document);
        const documentChanged = changes.text
            || changes.structuredInputMentions
            || changes.composerAttachments;
        const revision = projectsRepositoryRevision
            ? next.repositoryRevision
            : observed.revision + (documentChanged ? 1 : 0);
        if (documentChanged || revision !== observed.revision) {
            observed = { document: documentChanged ? next.document : observed.document, revision };
        }
        return { document: observed.document, revision: observed.revision };
    };

    const owner: MutableComposerDocumentOwner = {
        ref: input.ref,
        capabilities: CAPABILITIES,
        read: () => input.isCurrent?.() === false
            ? { document: EMPTY_DOCUMENT, revision: observed.revision }
            : refresh(),
        observe: (listener) => input.isCurrent?.() === false
            ? () => undefined
            : subscribeSessionDraft(input.scope, address, () => {
            if (input.isCurrent?.() === false) return;
            const previousRevision = observed.revision;
            const next = refresh();
            if (next.revision !== previousRevision) listener();
        }),
        apply: (expectedRevision, mutation) => {
            if (input.isCurrent?.() === false) return { status: 'composerUnavailable' };
            const current = refresh();
            if (current.revision !== expectedRevision) {
                return { status: 'conflict', currentRevision: current.revision };
            }
            const nextMentions = composerStructuredMentionsFromReferences({
                references: mutation.references,
                existing: current.document.structuredInputMentions,
            });
            const nextAttachments = mutation.attachments.map(composerAttachmentViewToDraft);
            const patch = {
                text: mutation.text,
                mentions: nextMentions.map(strictJson),
                attachments: nextAttachments.map(strictJson),
            };
            if (address.kind === 'session' || address.kind === 'run') {
                writeExistingSessionDraft({
                    scope: input.scope,
                    sessionId: address.sessionId,
                    ...(address.kind === 'run' ? { runId: address.runId } : {}),
                    patch,
                    materializationIntent: 'userEdit',
                });
            } else {
                writeNewSessionDraft({
                    scope: input.scope,
                    draftId: address.draftId,
                    patch,
                    materializationIntent: 'userEdit',
                });
            }
            return { status: 'applied', revision: refresh().revision };
        },
        captureCurrentness: () => {
            const currentness: ComposerDraftFieldCurrentness = {
                ref: input.ref,
                textMutationRevision: 0,
                structuredInputMentionsMutationRevision: 0,
                composerAttachmentsMutationRevision: 0,
            };
            if (input.isCurrent?.() === false) return currentness;
            repositoryCurrentnessByCapture.set(currentness, captureSessionDraftCurrentness({
                scope: input.scope,
                address,
                fieldIds: ['composer.text', 'composer.mentions', 'composer.attachments'],
            }));
            return currentness;
        },
        clearAccepted: (currentness) => {
            const noChange = () => ({
                changed: false,
                changes: {
                    text: false,
                    structuredInputMentions: false,
                    composerAttachments: false,
                },
                acceptedFieldsCurrent: {
                    text: false,
                    structuredInputMentions: false,
                    composerAttachments: false,
                },
            } as const);
            if (input.isCurrent?.() === false) return noChange();
            if (!sameComposerDocumentRef(input.ref, currentness.ref)) return noChange();
            const repositoryCurrentness = repositoryCurrentnessByCapture.get(currentness);
            if (!repositoryCurrentness) return noChange();
            const fieldIds = ['composer.text', 'composer.mentions', 'composer.attachments'] as const;
            // References are text-bound, matching the ephemeral document owner:
            // mentions clear exactly when the accepted text clears, and a text
            // edited after capture keeps its still-binding mentions while the
            // exact-range reconciliation drops only unbindable ones.
            const current = captureSessionDraftCurrentness({
                scope: input.scope,
                address,
                fieldIds: [...fieldIds],
            });
            const capturedTextMutationId = repositoryCurrentness.mutationIds['composer.text'];
            const textCurrent = capturedTextMutationId !== undefined
                && current.mutationIds['composer.text'] === capturedTextMutationId;
            const capturedAttachmentsMutationId = repositoryCurrentness.mutationIds['composer.attachments'];
            const attachmentsCurrent = capturedAttachmentsMutationId !== undefined
                && current.mutationIds['composer.attachments'] === capturedAttachmentsMutationId;
            const beforeClear = refresh().document;
            if (!textCurrent && !attachmentsCurrent) return noChange();
            const clearFieldIds = [
                ...(textCurrent ? ['composer.text' as const] : []),
                ...(textCurrent ? ['composer.mentions' as const] : []),
                ...(attachmentsCurrent ? ['composer.attachments' as const] : []),
            ];
            clearSessionDraftCurrentnessLocal({
                scope: input.scope,
                address,
                currentness: repositoryCurrentness,
                fieldIds: clearFieldIds,
                clearComposerReferencesWithCurrentText: true,
            });
            const changes = readComposerDraftDocumentChanges(beforeClear, refresh().document);
            const changed = changes.text || changes.structuredInputMentions || changes.composerAttachments;
            if (changed) void flushSessionDraft({ scope: input.scope, address });
            return {
                changed,
                changes,
                acceptedFieldsCurrent: {
                    text: textCurrent,
                    structuredInputMentions: textCurrent,
                    composerAttachments: attachmentsCurrent,
                },
            };
        },
        clear: () => {
            if (input.isCurrent?.() === false) return;
            void deleteSessionDraft({ scope: input.scope, address });
        },
        replaceDocument: (document) => {
            if (input.isCurrent?.() === false) return observed.revision;
            const current = refresh();
            const reconciled = reconcileComposerDraftDocumentTextReplacement(current.document, document);
            const result = owner.apply(current.revision, {
                text: reconciled.text,
                references: composerReferencesFromStructuredMentions({
                    text: reconciled.text,
                    mentions: reconciled.structuredInputMentions,
                }),
                attachments: reconciled.composerAttachments.map((attachment) => ({
                    ...attachment,
                    availability: { status: 'ready' as const },
                })),
            });
            return result.status === 'applied' ? result.revision : current.revision;
        },
    };
    return Object.freeze(owner);
}
