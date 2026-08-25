import {
    ComposerAttachmentDraftV1Schema,
    StrictJsonValueSchema,
    type ComposerCapabilitiesV1,
    type ComposerRefV1,
    type StrictJsonValue,
} from '@happier-dev/protocol';

import {
    readComposerDraftDocumentChanges,
    type ComposerDocumentOwner,
    type ComposerDraftDocument,
    type ComposerDraftFieldCurrentness,
    sameComposerDocumentRef,
} from '@/components/sessions/composer/composerDocumentOwner';
import {
    composerAttachmentViewToDraft,
    composerStructuredMentionsFromReferences,
} from '@/components/sessions/composer/composerScopeAdapters';
import {
    ComposerStructuredInputMentionsSchema,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    areSessionDraftCurrentnessCapturesEqual,
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentness,
    deleteSessionDraft,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
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

    const mentions = ComposerStructuredInputMentionsSchema.safeParse(snapshot.document.composer.mentions.value);
    const attachments = Array.isArray(snapshot.document.composer.attachments.value)
        ? snapshot.document.composer.attachments.value.flatMap((value) => {
            const parsed = ComposerAttachmentDraftV1Schema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
        })
        : [];
    return {
        document: Object.freeze({
            text: typeof snapshot.document.composer.text.value === 'string'
                ? snapshot.document.composer.text.value
                : '',
            structuredInputMentions: Object.freeze(mentions.success ? mentions.data : []),
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
}>): ComposerDocumentOwner {
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

    const owner: ComposerDocumentOwner = {
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
            if (!sameComposerDocumentRef(input.ref, currentness.ref)) return false;
            const repositoryCurrentness = repositoryCurrentnessByCapture.get(currentness);
            if (!repositoryCurrentness) return false;
            const beforeClear = captureSessionDraftCurrentness({
                scope: input.scope,
                address,
                fieldIds: ['composer.text', 'composer.mentions', 'composer.attachments'],
            });
            void clearSessionDraftCurrentness({
                scope: input.scope,
                address,
                currentness: repositoryCurrentness,
            });
            const afterClear = captureSessionDraftCurrentness({
                scope: input.scope,
                address,
                fieldIds: ['composer.text', 'composer.mentions', 'composer.attachments'],
            });
            return !areSessionDraftCurrentnessCapturesEqual(beforeClear, afterClear);
        },
        clear: () => {
            void deleteSessionDraft({ scope: input.scope, address });
        },
    };
    return Object.freeze(owner);
}
