import type {
    ComposerAttachmentDraftV1,
    ComposerRefV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
    MentionRefV1,
} from '@happier-dev/protocol';
import * as React from 'react';

import type {
    AgentInputAttachmentsRowItem,
    AgentInputComposerDecoration,
    AgentInputComposerInputLock,
    AgentInputExtraActionChip,
} from '@/components/sessions/agentInput/agentInputContracts';
import { projectComposerAttachmentRowItems } from '@/components/sessions/composer/composerAttachmentProjection';
import {
    composerAttachmentDraftToView,
    composerAttachmentViewToDraft,
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
    type ComposerAttachmentAvailabilityCatalog,
} from '@/components/sessions/composer/composerScopeAdapters';
import {
    readComposerSubmissionFieldCurrentness,
    type ComposerSubmissionSnapshot,
} from '@/components/sessions/composer/composerSubmissionCoordinator';
import {
    applyComposerPresentationTransaction,
    notifyComposerPresentationTargetChanged,
    registerComposerPresentationTarget,
    useStableComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useComposerPresentationInputEffects } from '@/components/sessions/presentation/useComposerPresentationInputEffects';
import {
    useComposerScopePluginPresentation,
    type ComposerScopeProjectionInputs,
} from '@/components/sessions/presentation/useComposerScopePluginPresentation';
import type { DaemonMergedProjectionPhase } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ComposerStructuredInputMention } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

import type { NewSessionPromptStore } from './newSessionPromptStore';

type NewSessionComposerDocumentState = Readonly<{
    attachments: readonly ComposerAttachmentDraftV1[];
    mentions: readonly ComposerStructuredInputMention[];
}>;

export type NewSessionComposerDocument = Readonly<{
    ref: Extract<ComposerRefV1, Readonly<{ kind: 'newSession' }>>;
    /** Exact live-scope/account currentness for host adapters; no global focus registry. */
    isCurrent: () => boolean;
    /** Reference search additionally retires when this concrete input loses focus. */
    isReferenceSearchCurrent: () => boolean;
    /** Semantic draft revision for persistence/currentness consumers. */
    revision: number;
    attachments: readonly ComposerAttachmentDraftV1[];
    structuredInputMentions: readonly ComposerStructuredInputMention[];
    onStructuredInputMentionsChange: (mentions: readonly ComposerStructuredInputMention[]) => void;
    /** Bound by the mounted New Session input; never a global focus registry. */
    onComposerFocusChange: (focused: boolean) => void;
    onComposerFocusRequestChange: (request: (() => void) | null) => void;
    onComposerActionBarLayoutChange: (layout: ComposerSnapshotV1['layout']) => void;
    composerDecorations: readonly AgentInputComposerDecoration[];
    composerInputLock: AgentInputComposerInputLock | null;
    attachmentRowItems: readonly AgentInputAttachmentsRowItem[];
    hasSendableAttachments: boolean;
    extraActionChips: readonly AgentInputExtraActionChip[];
    beforeComposer: React.ReactNode;
    afterComposer: React.ReactNode;
    /** Reads the live target only while this exact projection scope remains current. */
    readCurrentExecutionTarget?: () => Readonly<{ serverId: string; machineId: string }> | null;
    captureSubmissionSnapshot: (inputTextOverride?: string) => ComposerSnapshotV1 | null;
    clearAcceptedSnapshot: (snapshot: ComposerSubmissionSnapshot) => boolean;
}>;

function sameJsonValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function sameComposerRef(
    left: ComposerRefV1,
    right: ComposerRefV1,
): left is Extract<ComposerRefV1, Readonly<{ kind: 'newSession' }>> {
    return left.kind === 'newSession'
        && right.kind === 'newSession'
        && left.instanceId === right.instanceId;
}

function sameDocumentState(
    left: NewSessionComposerDocumentState,
    right: NewSessionComposerDocumentState,
): boolean {
    return sameJsonValue(left.attachments, right.attachments)
        && sameJsonValue(left.mentions, right.mentions);
}

function attachmentSignature(attachments: readonly ComposerAttachmentDraftV1[]): string {
    return JSON.stringify(attachments);
}

/**
 * Adapts New Session's incumbent prompt store and persisted contentless
 * attachment drafts to the one Composer presentation document. This is not a
 * second draft store: text remains prompt-store owned, attachment persistence
 * remains the New Session draft owner, and the target only commits through
 * those owners.
 */
export function useNewSessionComposerDocument(params: Readonly<{
    promptStore: NewSessionPromptStore;
    persistedAttachments: readonly ComposerAttachmentDraftV1[];
    /** Exact current daemon projection for this new-session machine/account scope. */
    composerAttachmentEntriesById: ComposerAttachmentAvailabilityCatalog['entriesById'];
    /** Raw daemon projection remains the one controls/regions/catalog owner. */
    composerPluginProjection?: Readonly<{
        machineId: string | null;
        serverId?: string | null;
        phase: DaemonMergedProjectionPhase;
        inputs: ComposerScopeProjectionInputs | null;
    }>;
    /**
     * References already persisted with the seeded prompt — today the Automation
     * edit seed's stored template. They are placed through the same scope adapter
     * a live transaction uses, so an untouched composer resubmits exactly what it
     * read and an edited one drops whatever token the user removed.
     */
    initialStructuredInputReferences?: readonly MentionRefV1[];
    /** Changes only when the incumbent account-scoped New Session draft changes owner. */
    scopeKey: string | null;
    /** Derived by the New Session authoring owner after this adapter is mounted. */
    canSubmitRef: React.RefObject<boolean>;
    isSubmitting: boolean;
}>): NewSessionComposerDocument {
    const composerAccountLifetime = captureActiveServerAccountScopeLifetime();
    const scopedIdentityRef = React.useRef<Readonly<{
        scopeKey: string | null;
        instanceId: string;
    }> | null>(null);
    if (scopedIdentityRef.current?.scopeKey !== params.scopeKey) {
        scopedIdentityRef.current = {
            scopeKey: params.scopeKey,
            instanceId: randomUUID(),
        };
    }
    const instanceId = scopedIdentityRef.current.instanceId;
    const ref = React.useMemo<Extract<ComposerRefV1, Readonly<{ kind: 'newSession' }>>>(() => ({
        kind: 'newSession',
        instanceId,
    }), [instanceId]);
    const refRef = React.useRef<ComposerRefV1>(ref);
    refRef.current = ref;
    const mountedRef = React.useRef(true);
    const composerInputFocusedRef = React.useRef(false);
    const composerActionBarLayoutRef = React.useRef<ComposerSnapshotV1['layout']>('wrap');
    const composerFocusRequestRef = React.useRef<(() => void) | null>(null);
    const isSubmittingRef = React.useRef(params.isSubmitting);
    isSubmittingRef.current = params.isSubmitting;
    const suppressPromptNotificationRef = React.useRef(false);
    const initialStateRef = React.useRef<NewSessionComposerDocumentState | null>(null);
    // Placed once for this mount: the adapter is only meaningful for the first
    // document, and re-running it on every composer render would be per-keystroke
    // work for a value that is discarded.
    initialStateRef.current ??= {
        attachments: params.persistedAttachments,
        mentions: composerStructuredMentionsFromReferences({
            references: params.initialStructuredInputReferences ?? [],
            existing: [],
        }),
    };
    const documentRef = React.useRef<NewSessionComposerDocumentState>(initialStateRef.current);
    const [documentState, setDocumentState] = React.useState<NewSessionComposerDocumentState>(initialStateRef.current);
    const revisionRef = React.useRef(0);
    const localDocumentChangeRef = React.useRef(false);
    const hydratedScopeKeyRef = React.useRef<string | null>(params.scopeKey);
    const hydratedAttachmentSignatureRef = React.useRef(attachmentSignature(params.persistedAttachments));
    const persistedAttachmentSignature = attachmentSignature(params.persistedAttachments);

    const isNewSessionComposerCurrent = React.useCallback(() => (
        mountedRef.current
        && sameComposerRef(refRef.current, ref)
        && (composerAccountLifetime === null || composerAccountLifetime.isCurrent())
    ), [composerAccountLifetime, ref]);
    const isNewSessionReferenceSearchCurrent = React.useCallback(() => (
        isNewSessionComposerCurrent() && composerInputFocusedRef.current
    ), [isNewSessionComposerCurrent]);
    const composerInputEffects = useComposerPresentationInputEffects({
        ref,
    });
    const composerPluginPresentation = useComposerScopePluginPresentation({
        composer: ref,
        physicalTarget: { kind: 'app' },
        resourceContext: { kind: 'global' },
        machineId: params.composerPluginProjection?.machineId ?? null,
        serverId: params.composerPluginProjection?.serverId,
        projectionPhase: params.composerPluginProjection?.phase ?? 'idle',
        projectionInputs: params.composerPluginProjection?.inputs ?? null,
        accountLifetime: composerAccountLifetime,
        isScopeCurrent: isNewSessionComposerCurrent,
        attachmentsEnabled: true,
        includeSessionActions: false,
    });
    const readCurrentExecutionTarget = React.useCallback((): Readonly<{
        serverId: string;
        machineId: string;
    }> | null => {
        if (!isNewSessionComposerCurrent() || composerPluginPresentation.scopeSignal.aborted) return null;
        const projection = params.composerPluginProjection;
        if (!projection?.serverId || !projection.machineId) return null;
        return {
            serverId: projection.serverId,
            machineId: projection.machineId,
        };
    }, [composerPluginPresentation.scopeSignal, isNewSessionComposerCurrent, params.composerPluginProjection]);

    React.useLayoutEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        const retirement = composerAccountLifetime?.onRetire(() => {
            composerInputEffects.retire();
        });
        return () => retirement?.dispose();
    }, [composerAccountLifetime, composerInputEffects.retire]);

    const onComposerFocusChange = React.useCallback((focused: boolean) => {
        if (!mountedRef.current || !sameComposerRef(refRef.current, ref)) return;
        if (composerInputFocusedRef.current === focused) return;
        composerInputFocusedRef.current = focused;
        notifyComposerPresentationTargetChanged(ref);
    }, [ref]);

    const onComposerFocusRequestChange = React.useCallback((request: (() => void) | null) => {
        composerFocusRequestRef.current = request;
    }, []);

    const onComposerActionBarLayoutChange = React.useCallback((layout: ComposerSnapshotV1['layout']) => {
        if (!mountedRef.current || !sameComposerRef(refRef.current, ref)) return;
        if (composerActionBarLayoutRef.current === layout) return;
        composerActionBarLayoutRef.current = layout;
        notifyComposerPresentationTargetChanged(ref);
    }, [ref]);

    const updateDocument = React.useCallback((input: Readonly<{
        text: string;
        state: NewSessionComposerDocumentState;
        notify: boolean;
        local: boolean;
    }>): number => {
        const textChanged = params.promptStore.getPrompt() !== input.text;
        const stateChanged = !sameDocumentState(documentRef.current, input.state);
        if (!textChanged && !stateChanged) {
            return revisionRef.current;
        }

        if (textChanged) {
            suppressPromptNotificationRef.current = true;
            try {
                params.promptStore.setPrompt(input.text);
            } finally {
                suppressPromptNotificationRef.current = false;
            }
        }
        if (stateChanged) {
            documentRef.current = input.state;
            setDocumentState(input.state);
        }
        if (input.local) {
            localDocumentChangeRef.current = true;
        }
        revisionRef.current += 1;
        if (input.notify) {
            notifyComposerPresentationTargetChanged(ref);
        }
        return revisionRef.current;
    }, [params.promptStore, ref]);

    const readSnapshot = React.useCallback((): ComposerSnapshotV1 => {
        const state = documentRef.current;
        const text = params.promptStore.getPrompt();
        const canSubmit = params.canSubmitRef.current === true && !isSubmittingRef.current;
        const inputLock = composerInputEffects.readComposerInputLock();
        const editable = canSubmit && inputLock?.mode !== 'editAndSubmit';
        const submittable = canSubmit && inputLock === null;
        return {
            revision: revisionRef.current,
            ref,
            text,
            // The scope adapter exposes immutable normalized references. The
            // Protocol snapshot is the wire-shaped mutable-array boundary.
            references: [...composerReferencesFromStructuredMentions({ text, mentions: state.mentions })],
            attachments: state.attachments.map((attachment) => composerAttachmentDraftToView(attachment, {
                entriesById: params.composerAttachmentEntriesById,
            })),
            layout: composerActionBarLayoutRef.current,
            capabilities: {
                text: true,
                references: true,
                attachments: true,
                submit: true,
            },
            state: {
                focused: composerInputFocusedRef.current,
                editable,
                submittable,
                submitting: isSubmittingRef.current,
                running: false,
                ...(inputLock ? { inputLock } : {}),
            },
        };
    }, [composerInputEffects.readComposerInputLock, params.composerAttachmentEntriesById, params.promptStore, ref]);

    const commitDocument = React.useCallback((input: Readonly<{
        expectedRevision: number;
        mutation: ComposerPresentationDocumentMutation;
    }>): ComposerTransactionResultV1 => {
        if (!sameComposerRef(refRef.current, ref) || revisionRef.current !== input.expectedRevision) {
            return { status: 'conflict', currentRevision: revisionRef.current };
        }
        const nextState: NewSessionComposerDocumentState = {
            attachments: input.mutation.attachments.map(composerAttachmentViewToDraft),
            mentions: composerStructuredMentionsFromReferences({
                references: input.mutation.references,
                existing: documentRef.current.mentions,
            }),
        };
        return {
            status: 'applied',
            revision: updateDocument({
                text: input.mutation.text,
                state: nextState,
                notify: false,
                local: true,
            }),
        };
    }, [ref, updateDocument]);

    const target = useStableComposerPresentationTarget(ref, {
        readRevision: () => revisionRef.current,
        replace: (text, expectedRevision) => {
            if (revisionRef.current !== expectedRevision) return revisionRef.current;
            return updateDocument({
                text,
                state: documentRef.current,
                notify: true,
                local: true,
            });
        },
        readSnapshot,
        commitDocument,
        createAttachmentInstanceId: randomUUID,
        setComposerDecorations: composerInputEffects.setComposerDecorations,
        acquireComposerInputLock: composerInputEffects.acquireComposerInputLock,
        isCurrent: () => (
            mountedRef.current
            && sameComposerRef(refRef.current, ref)
            && (composerAccountLifetime === null || composerAccountLifetime.isCurrent())
        ),
        focusComposer: () => {
            if (
                !mountedRef.current
                || !sameComposerRef(refRef.current, ref)
                || (composerAccountLifetime !== null && !composerAccountLifetime.isCurrent())
            ) {
                return false;
            }
            const focus = composerFocusRequestRef.current;
            if (!focus) return false;
            focus();
            return true;
        },
    } satisfies ComposerPresentationTarget);

    React.useEffect(() => registerComposerPresentationTarget(ref, target), [ref, target]);

    React.useEffect(() => {
        notifyComposerPresentationTargetChanged(ref);
    }, [params.composerAttachmentEntriesById, ref]);

    React.useEffect(() => params.promptStore.subscribe(() => {
        if (suppressPromptNotificationRef.current) return;
        localDocumentChangeRef.current = true;
        revisionRef.current += 1;
        notifyComposerPresentationTargetChanged(ref);
    }), [params.promptStore, ref]);

    React.useEffect(() => {
        const scopeChanged = hydratedScopeKeyRef.current !== params.scopeKey;
        if (!scopeChanged && localDocumentChangeRef.current) {
            return;
        }
        if (!scopeChanged && hydratedAttachmentSignatureRef.current === persistedAttachmentSignature) {
            return;
        }

        hydratedScopeKeyRef.current = params.scopeKey;
        hydratedAttachmentSignatureRef.current = persistedAttachmentSignature;
        if (scopeChanged) {
            localDocumentChangeRef.current = false;
        }
        updateDocument({
            text: params.promptStore.getPrompt(),
            state: {
                attachments: params.persistedAttachments,
                mentions: scopeChanged ? [] : documentRef.current.mentions,
            },
            notify: true,
            local: false,
        });
    }, [
        params.persistedAttachments,
        params.promptStore,
        params.scopeKey,
        persistedAttachmentSignature,
        updateDocument,
    ]);

    React.useEffect(() => {
        notifyComposerPresentationTargetChanged(ref);
    }, [params.isSubmitting, ref]);

    const captureSubmissionSnapshot = React.useCallback((inputTextOverride?: string): ComposerSnapshotV1 | null => {
        if (!mountedRef.current) return null;
        if (typeof inputTextOverride === 'string' && inputTextOverride !== params.promptStore.getPrompt()) {
            updateDocument({
                text: inputTextOverride,
                state: documentRef.current,
                notify: true,
                local: true,
            });
        }
        return readSnapshot();
    }, [params.promptStore, readSnapshot, updateDocument]);

    const clearAcceptedSnapshot = React.useCallback((snapshot: ComposerSubmissionSnapshot): boolean => {
        if (!mountedRef.current || !sameComposerRef(refRef.current, snapshot.ref)) return false;
        const current = readSnapshot();
        const currentness = readComposerSubmissionFieldCurrentness(current, snapshot);
        if (!currentness) return false;
        updateDocument({
            text: currentness.reconciledText,
            state: {
                attachments: currentness.attachments ? [] : documentRef.current.attachments,
                mentions: composerStructuredMentionsFromReferences({
                    references: currentness.reconciledReferences,
                    existing: documentRef.current.mentions,
                }),
            },
            notify: true,
            local: true,
        });
        return true;
    }, [readSnapshot, updateDocument]);

    const onStructuredInputMentionsChange = React.useCallback((mentions: readonly ComposerStructuredInputMention[]) => {
        updateDocument({
            text: params.promptStore.getPrompt(),
            state: {
                ...documentRef.current,
                mentions,
            },
            notify: true,
            local: true,
        });
    }, [params.promptStore, updateDocument]);

    const removeAttachment = React.useCallback((instanceId: string) => {
        const snapshot = readSnapshot();
        applyComposerPresentationTransaction({
            ref,
            transaction: {
                expectedRevision: snapshot.revision,
                operations: [{ kind: 'attachment.remove', instanceId }],
            },
        });
    }, [readSnapshot, ref]);
    const attachmentViews = React.useMemo(() => documentState.attachments.map((attachment) => (
        composerAttachmentDraftToView(attachment, {
            entriesById: params.composerAttachmentEntriesById,
        })
    )), [documentState.attachments, params.composerAttachmentEntriesById]);
    const attachmentRowItems = React.useMemo(() => projectComposerAttachmentRowItems({
        attachments: attachmentViews,
        onRemove: removeAttachment,
        entriesById: params.composerAttachmentEntriesById ?? undefined,
        renderSurface: composerPluginPresentation.renderAttachmentSurface,
        resolveInteraction: composerPluginPresentation.resolveAttachmentInteraction,
    }), [
        attachmentViews,
        composerPluginPresentation.renderAttachmentSurface,
        composerPluginPresentation.resolveAttachmentInteraction,
        params.composerAttachmentEntriesById,
        removeAttachment,
    ]);

    return React.useMemo(() => ({
        ref,
        isCurrent: isNewSessionComposerCurrent,
        isReferenceSearchCurrent: isNewSessionReferenceSearchCurrent,
        revision: revisionRef.current,
        attachments: documentState.attachments,
        structuredInputMentions: documentState.mentions,
        onStructuredInputMentionsChange,
        onComposerFocusChange,
        onComposerFocusRequestChange,
        onComposerActionBarLayoutChange,
        composerDecorations: composerInputEffects.composerDecorations,
        composerInputLock: composerInputEffects.composerInputLock,
        attachmentRowItems,
        hasSendableAttachments: attachmentViews.some((attachment) => attachment.availability.status === 'ready'),
        extraActionChips: composerPluginPresentation.extraActionChips,
        beforeComposer: composerPluginPresentation.beforeComposer,
        afterComposer: composerPluginPresentation.afterComposer,
        readCurrentExecutionTarget,
        captureSubmissionSnapshot,
        clearAcceptedSnapshot,
    }), [
        attachmentRowItems,
        attachmentViews,
        captureSubmissionSnapshot,
        clearAcceptedSnapshot,
        composerInputEffects.composerDecorations,
        composerInputEffects.composerInputLock,
        composerPluginPresentation.afterComposer,
        composerPluginPresentation.beforeComposer,
        composerPluginPresentation.extraActionChips,
        documentState.attachments,
        documentState.mentions,
        onComposerActionBarLayoutChange,
        onComposerFocusChange,
        onComposerFocusRequestChange,
        onStructuredInputMentionsChange,
        isNewSessionComposerCurrent,
        isNewSessionReferenceSearchCurrent,
        readCurrentExecutionTarget,
        ref,
        revisionRef.current,
    ]);
}
