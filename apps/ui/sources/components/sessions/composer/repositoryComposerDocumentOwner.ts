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
    normalizeComposerDraftReferenceTokens,
} from '@/components/sessions/composer/composerScopeAdapters';
import {
    parseComposerStructuredInputMentionsForText,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentnessLocal,
    deleteSessionDraft,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    flushSessionDraft,
    writeExistingSessionDraft,
    writeNewSessionDraft,
    executionRunLauncherDraftFieldPath,
    type SessionDraftCurrentness,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { getSessionDraftDocumentField } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';
import { fireAndForget } from '@/utils/system/fireAndForget';

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
    launcherDraftKey?: string,
): RepositoryComposerDocumentRead {
    const snapshot = getSessionDraftSnapshot(scope, address);
    if (!snapshot) return { document: EMPTY_DOCUMENT, repositoryRevision: 0 };

    const value = (field: 'text' | 'mentions' | 'attachments') => launcherDraftKey
        ? getSessionDraftDocumentField(snapshot.document, executionRunLauncherDraftFieldPath(launcherDraftKey, field))?.value
        : getSessionDraftDocumentField(snapshot.document, { kind: 'composer', field })?.value;
    const text = typeof value('text') === 'string'
        ? String(value('text'))
        : '';
    const parsedMentions = parseComposerStructuredInputMentionsForText(
        value('mentions'),
        text,
    );
    const normalized = normalizeComposerDraftReferenceTokens({ text, mentions: parsedMentions.mentions });
    const attachmentValue = value('attachments');
    const attachments = Array.isArray(attachmentValue)
        ? attachmentValue.flatMap((value) => {
            const parsed = ComposerAttachmentDraftV1Schema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
        })
        : [];
    return {
        document: Object.freeze({
            text: normalized.text,
            structuredInputMentions: Object.freeze(normalized.mentions),
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
    /** A rowless launcher uses its own fields on the real parent Session draft. */
    launcherDraftKey?: string;
    /** Actual composer mutations only; hydration and repository echoes never call this. */
    onDocumentEdit?: () => void;
    isCurrent?: () => boolean;
    /** Accepted input can settle after its view closes, within the captured Account. */
    scopeLifetime?: ServerAccountScopeLifetime;
}>): MutableComposerDocumentOwner {
    const acceptedLifetime = input.scopeLifetime ? readServerAccountScopeOwnerLifetime(input.scopeLifetime) : null;
    const address = input.address ?? (input.ref.kind === 'session'
        ? { kind: 'session' as const, sessionId: input.ref.sessionId }
        : input.ref.kind === 'newSession'
            ? { kind: 'newSession' as const, draftId: input.ref.instanceId }
            : null);
    if (address === null) {
        throw new Error('A participant composer requires an explicit synchronized draft address');
    }
    if (input.launcherDraftKey && address.kind !== 'session') throw new Error('A launcher draft belongs to its parent Session');
    const fieldId = (field: 'text' | 'mentions' | 'attachments') => input.launcherDraftKey
        ? `extensions.happier.${executionRunLauncherDraftFieldPath(input.launcherDraftKey, field).fieldId}`
        : `composer.${field}`;
    const fieldIds = (['text', 'mentions', 'attachments'] as const).map(fieldId);
    // A mounted launcher owns a participant instance, like New Session. Parent
    // composer edits must not invalidate that independent document's revision.
    const projectsRepositoryRevision = address.kind !== 'newSession' && !input.launcherDraftKey;
    const initial = readRepositoryComposerDocument(input.scope, address, input.launcherDraftKey);
    let observed = {
        document: initial.document,
        revision: projectsRepositoryRevision ? initial.repositoryRevision : 0,
    };
    const repositoryCurrentnessByCapture = new WeakMap<ComposerDraftFieldCurrentness, SessionDraftCurrentness>();

    const refresh = () => {
        const next = readRepositoryComposerDocument(input.scope, address, input.launcherDraftKey);
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
            const changes = readComposerDraftDocumentChanges(current.document, {
                text: mutation.text, structuredInputMentions: nextMentions, composerAttachments: nextAttachments,
            });
            const patch = {
                // A legacy read projection is already semantically canonical. An
                // attachment-only edit must not turn that projection into a newer
                // text mutation while an accepted send still owns its custody.
                ...(changes.text || changes.structuredInputMentions ? {
                    text: mutation.text,
                    mentions: nextMentions.map(strictJson),
                } : {}),
                attachments: nextAttachments.map(strictJson),
                ...(mutation.sessionDiscussionSelectionSourceV1
                    ? { sessionDiscussionSelectionSourceV1: mutation.sessionDiscussionSelectionSourceV1 } : {}),
            };
            if (address.kind === 'session' || address.kind === 'run') {
                writeExistingSessionDraft({
                    scope: input.scope,
                    sessionId: address.sessionId,
                    ...(address.kind === 'run' ? { runId: address.runId } : {}),
                    patch: input.launcherDraftKey ? { executionRunLauncher: { key: input.launcherDraftKey, patch } } : patch,
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
            input.onDocumentEdit?.();
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
                fieldIds,
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
            if ((acceptedLifetime ? acceptedLifetime.isCurrent() : input.isCurrent?.()) === false) return noChange();
            if (!sameComposerDocumentRef(input.ref, currentness.ref)) return noChange();
            const repositoryCurrentness = repositoryCurrentnessByCapture.get(currentness);
            if (!repositoryCurrentness) return noChange();
            // References are text-bound, matching the ephemeral document owner:
            // mentions clear exactly when the accepted text clears, and a text
            // edited after capture keeps its still-binding mentions while the
            // exact-range reconciliation drops only unbindable ones.
            const current = captureSessionDraftCurrentness({
                scope: input.scope,
                address,
                fieldIds: [...fieldIds],
            });
            const capturedTextMutationId = repositoryCurrentness.mutationIds[fieldId('text')];
            const textCurrent = capturedTextMutationId !== undefined
                && current.mutationIds[fieldId('text')] === capturedTextMutationId;
            const capturedAttachmentsMutationId = repositoryCurrentness.mutationIds[fieldId('attachments')];
            const attachmentsCurrent = capturedAttachmentsMutationId !== undefined
                && current.mutationIds[fieldId('attachments')] === capturedAttachmentsMutationId;
            const beforeClear = refresh().document;
            if (!textCurrent && !attachmentsCurrent) return noChange();
            const clearFieldIds = [
                ...(textCurrent ? [fieldId('text'), fieldId('mentions')] : []),
                ...(attachmentsCurrent ? [fieldId('attachments')] : []),
            ];
            clearSessionDraftCurrentnessLocal({
                scope: input.scope,
                address,
                currentness: input.launcherDraftKey && textCurrent
                    ? { ...repositoryCurrentness, mutationIds: { ...repositoryCurrentness.mutationIds,
                        ...(current.mutationIds[fieldId('mentions')] ? { [fieldId('mentions')]: current.mutationIds[fieldId('mentions')]! } : {}) } }
                    : repositoryCurrentness,
                fieldIds: clearFieldIds,
                clearComposerReferencesWithCurrentText: true,
            });
            const changes = readComposerDraftDocumentChanges(beforeClear, refresh().document);
            const changed = changes.text || changes.structuredInputMentions || changes.composerAttachments;
            if (changed) fireAndForget(flushSessionDraft({ scope: input.scope, address }), { tag: 'composer.clearAcceptedDraft' });
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
            if (input.launcherDraftKey) {
                clearSessionDraftCurrentnessLocal({ scope: input.scope, address,
                    currentness: captureSessionDraftCurrentness({ scope: input.scope, address, fieldIds }) });
                fireAndForget(flushSessionDraft({ scope: input.scope, address }), { tag: 'composer.clearDraft' });
                return;
            }
            fireAndForget(deleteSessionDraft({ scope: input.scope, address }), { tag: 'composer.deleteDraft' });
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
