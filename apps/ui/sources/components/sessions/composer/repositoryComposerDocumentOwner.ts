import {
    ComposerAttachmentDraftV1Schema,
    StrictJsonValueSchema,
    type ComposerCapabilitiesV1,
    type ComposerRefV1,
    type StrictJsonValue,
} from '@happier-dev/protocol';

import {
    readComposerDraftDocumentChanges,
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
    address: Extract<ComposerRefV1, { kind: 'session' | 'newSession' }>,
): RepositoryComposerDocumentRead {
    const repositoryAddress = address.kind === 'session'
        ? { kind: 'session' as const, sessionId: address.sessionId }
        : { kind: 'newSession' as const, draftId: address.instanceId };
    const snapshot = getSessionDraftSnapshot(scope, repositoryAddress);
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
    ref: Extract<ComposerRefV1, { kind: 'session' | 'newSession' }>;
    isCurrent?: () => boolean;
}>): MutableComposerDocumentOwner {
    const address = input.ref.kind === 'session'
        ? { kind: 'session' as const, sessionId: input.ref.sessionId }
        : { kind: 'newSession' as const, draftId: input.ref.instanceId };
    const projectsRepositoryRevision = input.ref.kind === 'session';
    const initial = readRepositoryComposerDocument(input.scope, input.ref);
    let observed = {
        document: initial.document,
        revision: projectsRepositoryRevision ? initial.repositoryRevision : 0,
    };
    const repositoryCurrentnessByCapture = new WeakMap<ComposerDraftFieldCurrentness, SessionDraftCurrentness>();

    const refresh = () => {
        const next = readRepositoryComposerDocument(input.scope, input.ref);
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
        read: refresh,
        observe: (listener) => subscribeSessionDraft(input.scope, address, () => {
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
            if (input.ref.kind === 'session') {
                writeExistingSessionDraft({
                    scope: input.scope,
                    sessionId: input.ref.sessionId,
                    patch,
                    materializationIntent: 'userEdit',
                });
            } else {
                writeNewSessionDraft({
                    scope: input.scope,
                    draftId: input.ref.instanceId,
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
            } as const);
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
            const capturedMentionsMutationId = repositoryCurrentness.mutationIds['composer.mentions'];
            const textCurrent = capturedTextMutationId !== undefined
                && current.mutationIds['composer.text'] === capturedTextMutationId;
            const mentionsCurrent = capturedMentionsMutationId !== undefined
                && current.mutationIds['composer.mentions'] === capturedMentionsMutationId;
            const textAndMentionsWillClear = textCurrent && mentionsCurrent;
            const beforeClear = refresh().document;
            const changed = clearSessionDraftCurrentnessLocal({
                scope: input.scope,
                address,
                currentness: repositoryCurrentness,
                fieldIds: textAndMentionsWillClear
                    ? [...fieldIds]
                    : ['composer.attachments'],
            });
            if (changed) void flushSessionDraft({ scope: input.scope, address });
            const changes = changed
                ? readComposerDraftDocumentChanges(beforeClear, refresh().document)
                : noChange().changes;
            return {
                changed: changes.text || changes.structuredInputMentions || changes.composerAttachments,
                changes,
            };
        },
        clear: () => {
            void deleteSessionDraft({ scope: input.scope, address });
        },
        replaceDocument: (document) => {
            const current = refresh();
            const result = owner.apply(current.revision, {
                text: document.text,
                references: composerReferencesFromStructuredMentions({
                    text: document.text,
                    mentions: document.structuredInputMentions,
                }),
                attachments: document.composerAttachments.map((attachment) => ({
                    ...attachment,
                    availability: { status: 'ready' as const },
                })),
            });
            return result.status === 'applied' ? result.revision : current.revision;
        },
    };
    return Object.freeze(owner);
}
