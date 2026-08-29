import type {
    ComposerAttachmentDraftV1,
    ComposerRefV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
    MentionRefV1,
    ComposerAttachmentViewV1,
} from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol';
import { composerRefsV1Equal } from '@happier-dev/protocol/plugins/ui/composerRef';
import * as React from 'react';

import type {
    AgentInputAttachmentsRowItem,
    AgentInputComposerDecoration,
    AgentInputComposerInputLock,
    AgentInputExtraActionChip,
} from '@/components/sessions/agentInput/agentInputContracts';
import {
    isNewSessionComposerAttachmentSeedAdmitted,
    useNewSessionSeededComposerAttachments,
} from '@/components/sessions/new/attachments/useNewSessionSeededComposerAttachments';
import { projectComposerAttachmentRowItems } from '@/components/sessions/composer/composerAttachmentProjection';
import { createEphemeralComposerDocumentOwner } from '@/components/sessions/composer/composerDocumentOwner';
import { createNewSessionComposerDocumentOwner } from '@/components/sessions/composer/newSessionComposerDocumentOwner';
import { clearNewSessionComposerAttachmentSeedsFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import {
    composerAttachmentDraftToView,
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
    placePositionlessComposerReferences,
    type ComposerAttachmentAvailabilityCatalog,
} from '@/components/sessions/composer/composerScopeAdapters';
import type { ComposerSubmissionSnapshot } from '@/components/sessions/composer/composerSubmissionCoordinator';
import type { ComposerDraftFieldCurrentness } from '@/components/sessions/composer/composerDocumentOwner';
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
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ComposerStructuredInputMention } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import type { NewSessionComposerAttachmentSeedV1 } from '@/sync/domains/state/persistence';
import { t } from '@/text';

import type { NewSessionPromptStore } from './newSessionPromptStore';

type NewSessionComposerDocumentState = Readonly<{
    attachments: readonly ComposerAttachmentDraftV1[];
    mentions: readonly ComposerStructuredInputMention[];
}>;

const EMPTY_PENDING_ATTACHMENT_IDS: ReadonlySet<string> = new Set();

function projectPendingAttachmentSeed(
    seed: NewSessionComposerAttachmentSeedV1,
): ComposerAttachmentViewV1 {
    return {
        v: 1,
        instanceId: seed.instanceId,
        attachment: { pluginId: seed.pluginId, localId: seed.attachmentLocalId },
        key: seed.value.key,
        value: seed.value.value,
        presentation: { ...seed.value.presentation, typeLabel: t('common.unavailable') },
        availability: { status: 'unavailable' },
    };
}

function isUnadmittedPendingAttachmentView(
    seed: NewSessionComposerAttachmentSeedV1,
    attachment: ComposerAttachmentViewV1,
): boolean {
    const pending = projectPendingAttachmentSeed(seed);
    return attachment.instanceId === pending.instanceId
        && attachment.attachment.pluginId === pending.attachment.pluginId
        && attachment.attachment.localId === pending.attachment.localId
        && attachment.key === pending.key
        && sameStrictJsonValue(attachment.value, pending.value)
        && sameStrictJsonValue(attachment.presentation, pending.presentation);
}

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

function sameDocumentState(
    left: NewSessionComposerDocumentState,
    right: NewSessionComposerDocumentState,
): boolean {
    return sameStrictJsonValue(left.attachments, right.attachments)
        && sameStrictJsonValue(left.mentions, right.mentions);
}

/**
 * Adapts New Session's incumbent prompt store and persisted contentless attachment
 * drafts to the one Composer presentation document. Once a repository scope exists,
 * its Composer document owner is canonical; the prompt store mirrors live input for
 * the mounted control rather than becoming another persistence writer.
 */
export function useNewSessionComposerDocument(params: Readonly<{
    /** Required by the routed New Session owner; optional only for isolated legacy harnesses. */
    draftId?: string;
    draftScope?: ServerAccountScope | null;
    promptStore: NewSessionPromptStore;
    persistedAttachments: readonly ComposerAttachmentDraftV1[];
    /** Draft-local attachment requests waiting for current catalog admission. */
    persistedAttachmentSeeds?: readonly NewSessionComposerAttachmentSeedV1[];
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
    const [legacyHarnessDraftId] = React.useState(randomUUID);
    const draftId = params.draftId ?? legacyHarnessDraftId;
    const draftScope = params.draftScope ?? null;
    const composerAccountLifetime = captureActiveServerAccountScopeLifetime();
    const documentOwnerKey = `${params.scopeKey ?? 'ephemeral'}\u0000${draftId}`;
    // One live document identity per document owner. A durable owner is
    // addressed by its draft id, so the ref keeps that address; an ephemeral
    // owner carries no address, so its identity is minted per owner key and
    // rotates when the owner does — the replaced scope's target, decorations,
    // locks and focus retire with the old ref instead of leaking into the
    // replacement.
    const ephemeralIdentityRef = React.useRef<Readonly<{ ownerKey: string; instanceId: string }> | null>(null);
    if (draftScope === null && ephemeralIdentityRef.current?.ownerKey !== documentOwnerKey) {
        ephemeralIdentityRef.current = { ownerKey: documentOwnerKey, instanceId: randomUUID() };
    }
    const instanceId = draftScope !== null ? draftId : ephemeralIdentityRef.current!.instanceId;
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
    const localDocumentChangeRef = React.useRef(false);
    // A local apply publishes its owner notification synchronously from inside
    // `documentOwner.apply`. This latch marks that window so the observe listener
    // below stays a no-op for a document this mount just wrote and reconciles
    // itself; genuinely external (repository-side) writes still observe normally.
    // Without it, the listener observes the half-applied transaction — the prompt
    // store has not been reconciled yet — and duplicates the store write and the
    // React state commit for every local edit.
    const localApplyInFlightRef = React.useRef(false);
    const hydratedScopeKeyRef = React.useRef<string | null>(params.scopeKey);
    const hydratedAttachmentsRef = React.useRef(params.persistedAttachments);

    const isNewSessionComposerCurrent = React.useCallback(() => (
        mountedRef.current
        && composerRefsV1Equal(refRef.current, ref)
        && (composerAccountLifetime === null || composerAccountLifetime.isCurrent())
    ), [composerAccountLifetime, ref]);
    const isNewSessionReferenceSearchCurrent = React.useCallback(() => (
        isNewSessionComposerCurrent() && composerInputFocusedRef.current
    ), [isNewSessionComposerCurrent]);
    const isCurrentCallbackRef = React.useRef(isNewSessionComposerCurrent);
    isCurrentCallbackRef.current = isNewSessionComposerCurrent;
    // Positionless seed references (an Automation edit template's stored
    // message-level refs) are placed into the current prompt exactly once,
    // here at the seed boundary: after this the document's exact-range
    // custody owns every occurrence, and a token the seed text does not
    // contain is dropped instead of being silently relocated.
    const initialSeedReferences = placePositionlessComposerReferences({
        text: params.promptStore.getPrompt(),
        references: params.initialStructuredInputReferences ?? [],
    });
    const documentOwnerRef = React.useRef<Readonly<{
        key: string;
        owner: ReturnType<typeof createNewSessionComposerDocumentOwner>;
    }> | null>(null);
    if (documentOwnerRef.current?.key !== documentOwnerKey) {
        documentOwnerRef.current = {
            key: documentOwnerKey,
            owner: draftScope
                ? createNewSessionComposerDocumentOwner({
                    scope: draftScope,
                    ref,
                    isCurrent: () => isCurrentCallbackRef.current(),
                })
                : createEphemeralComposerDocumentOwner({
                    ref,
                    capabilities: { text: true, references: true, attachments: true, submit: true },
                    isCurrent: () => isCurrentCallbackRef.current(),
                    initialDocument: {
                        text: params.promptStore.getPrompt(),
                        structuredInputMentions: composerStructuredMentionsFromReferences({
                            references: initialSeedReferences,
                            existing: [],
                        }),
                        composerAttachments: params.persistedAttachments,
                    },
                }),
        };
    }
    const documentOwner = documentOwnerRef.current.owner;
    const initialOwnerDocument = documentOwner.read().document;
    const initialStateRef = React.useRef<NewSessionComposerDocumentState | null>(null);
    initialStateRef.current ??= {
        attachments: initialOwnerDocument.composerAttachments.length > 0
            ? initialOwnerDocument.composerAttachments
            : params.persistedAttachments,
        mentions: initialOwnerDocument.structuredInputMentions.length > 0
            ? initialOwnerDocument.structuredInputMentions
            : composerStructuredMentionsFromReferences({
                references: initialSeedReferences,
                existing: [],
            }),
    };
    const documentRef = React.useRef<NewSessionComposerDocumentState>(initialStateRef.current);
    const [documentState, setDocumentState] = React.useState<NewSessionComposerDocumentState>(initialStateRef.current);
    // Pending requests remain presentation-only until the mounted catalog
    // admits them through the canonical transaction applier. Keeping them out
    // of the document prevents a request and its eventual canonical record
    // from becoming two attachments (especially for cardinality-one entries).
    const [pendingAttachmentRetirements, setPendingAttachmentRetirements] = React.useState<Readonly<{
        ownerKey: string;
        instanceIds: ReadonlySet<string>;
    }>>({
        ownerKey: documentOwnerKey,
        instanceIds: EMPTY_PENDING_ATTACHMENT_IDS,
    });
    const retiredPendingAttachmentIds = pendingAttachmentRetirements.ownerKey === documentOwnerKey
        ? pendingAttachmentRetirements.instanceIds
        : EMPTY_PENDING_ATTACHMENT_IDS;
    const pendingAttachmentSeeds = React.useMemo(
        () => (params.persistedAttachmentSeeds ?? []).filter(
            (seed) => !retiredPendingAttachmentIds.has(seed.instanceId),
        ),
        [params.persistedAttachmentSeeds, retiredPendingAttachmentIds],
    );
    const submissionCurrentnessRef = React.useRef(new WeakMap<object, ComposerDraftFieldCurrentness>());
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
        if (!mountedRef.current || !composerRefsV1Equal(refRef.current, ref)) return;
        if (composerInputFocusedRef.current === focused) return;
        composerInputFocusedRef.current = focused;
        notifyComposerPresentationTargetChanged(ref);
    }, [ref]);

    const onComposerFocusRequestChange = React.useCallback((request: (() => void) | null) => {
        composerFocusRequestRef.current = request;
    }, []);

    const onComposerActionBarLayoutChange = React.useCallback((layout: ComposerSnapshotV1['layout']) => {
        if (!mountedRef.current || !composerRefsV1Equal(refRef.current, ref)) return;
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
        const current = documentOwner.read();
        const ownerState = {
            attachments: current.document.composerAttachments,
            mentions: current.document.structuredInputMentions,
        };
        const ownerChanged = current.document.text !== input.text
            || !sameDocumentState(ownerState, input.state);
        if (!textChanged && !stateChanged && !ownerChanged) {
            return current.revision;
        }

        localApplyInFlightRef.current = true;
        try {
            const result = documentOwner.apply(current.revision, {
                text: input.text,
                references: composerReferencesFromStructuredMentions({
                    text: input.text,
                    mentions: input.state.mentions,
                }),
                attachments: input.state.attachments.map((attachment) => composerAttachmentDraftToView(attachment, {
                    entriesById: params.composerAttachmentEntriesById,
                })),
            });
            if (result.status !== 'applied') return documentOwner.read().revision;

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
            if (input.notify) {
                notifyComposerPresentationTargetChanged(ref);
            }
            return result.revision;
        } finally {
            localApplyInFlightRef.current = false;
        }
    }, [documentOwner, params.composerAttachmentEntriesById, params.promptStore, ref]);

    const readSnapshot = React.useCallback((): ComposerSnapshotV1 => {
        const state = documentRef.current;
        const text = params.promptStore.getPrompt();
        const attachmentViews = state.attachments.map((attachment) => composerAttachmentDraftToView(attachment, {
            entriesById: params.composerAttachmentEntriesById,
        }));
        const pendingViews = pendingAttachmentSeeds
            .filter((seed) => !state.attachments.some((attachment) => (
                isNewSessionComposerAttachmentSeedAdmitted(seed, attachment)
            )))
            .map(projectPendingAttachmentSeed);
        const attachmentsReady = pendingViews.length === 0
            && attachmentViews.every((attachment) => attachment.availability.status === 'ready');
        const canSubmit = params.canSubmitRef.current === true
            && !isSubmittingRef.current
            && attachmentsReady;
        const inputLock = composerInputEffects.readComposerInputLock();
        // Readiness gates submission, not authoring. In particular an
        // unavailable seeded attachment must remain removable so the user can
        // clear the canonical placeholder and its pending seed custody.
        const editable = !isSubmittingRef.current && inputLock?.mode !== 'editAndSubmit';
        const submittable = canSubmit && inputLock === null;
        return {
            revision: documentOwner.read().revision,
            ref,
            text,
            // The scope adapter exposes immutable normalized references. The
            // Protocol snapshot is the wire-shaped mutable-array boundary.
            references: [...composerReferencesFromStructuredMentions({ text, mentions: state.mentions })],
            attachments: [...attachmentViews, ...pendingViews],
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
    }, [composerInputEffects.readComposerInputLock, documentOwner, params.composerAttachmentEntriesById, params.promptStore, pendingAttachmentSeeds, ref]);

    const commitDocument = React.useCallback((input: Readonly<{
        expectedRevision: number;
        mutation: ComposerPresentationDocumentMutation;
    }>): ComposerTransactionResultV1 => {
        if (!composerRefsV1Equal(refRef.current, ref)) return { status: 'composerUnavailable' };
        localApplyInFlightRef.current = true;
        try {
            // Pending seed rows participate in visible submit truth but are not
            // admitted records. A transaction starts from that public snapshot;
            // exclude only untouched pending rows while retaining the row the
            // canonical attachment applier actually resolved (its host-owned
            // presentation differs from the pending projection).
            const attachments = input.mutation.attachments.filter((attachment) => !pendingAttachmentSeeds.some(
                (seed) => isUnadmittedPendingAttachmentView(seed, attachment),
            ));
            const result = documentOwner.apply(input.expectedRevision, {
                ...input.mutation,
                attachments,
            });
            if (result.status !== 'applied') return result;
            const next = documentOwner.read().document;
            suppressPromptNotificationRef.current = true;
            try {
                params.promptStore.setPrompt(next.text);
            } finally {
                suppressPromptNotificationRef.current = false;
            }
            const nextState = {
                attachments: next.composerAttachments,
                mentions: next.structuredInputMentions,
            };
            documentRef.current = nextState;
            setDocumentState(nextState);
            localDocumentChangeRef.current = true;
            return result;
        } finally {
            localApplyInFlightRef.current = false;
        }
    }, [documentOwner, params.promptStore, pendingAttachmentSeeds, ref]);

    const target = useStableComposerPresentationTarget(ref, {
        readRevision: () => documentOwner.read().revision,
        replace: (text, expectedRevision) => {
            if (documentOwner.read().revision !== expectedRevision) return documentOwner.read().revision;
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
            && composerRefsV1Equal(refRef.current, ref)
            && (composerAccountLifetime === null || composerAccountLifetime.isCurrent())
        ),
        focusComposer: () => {
            if (
                !mountedRef.current
                || !composerRefsV1Equal(refRef.current, ref)
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

    // The other half of a plugin-seeded New Session. The seed could state the
    // attachment REQUEST and nothing more; this mount is the first place the
    // contribution authority and the host-minted instance id exist, so it is
    // where the request becomes a record — through the same applier a live
    // plugin composer control uses.
    const onSeedsApplied = React.useCallback((seeds: readonly NewSessionComposerAttachmentSeedV1[]) => {
        if (!isNewSessionComposerCurrent()) return;
        const admittedIds = new Set(seeds.map((seed) => seed.instanceId));
        setPendingAttachmentRetirements((current) => ({
            ownerKey: documentOwnerKey,
            instanceIds: new Set([
                ...(current.ownerKey === documentOwnerKey ? current.instanceIds : []),
                ...admittedIds,
            ]),
        }));
        if (!draftScope || !params.draftId) return;
        clearNewSessionComposerAttachmentSeedsFromRepository({
            scope: draftScope,
            draftId: params.draftId,
            seeds,
        });
    }, [documentOwnerKey, draftScope, isNewSessionComposerCurrent, params.draftId]);
    const isSeedAdmitted = React.useCallback(
        (seed: NewSessionComposerAttachmentSeedV1) => documentOwner.read().document.composerAttachments.some(
            (attachment) => isNewSessionComposerAttachmentSeedAdmitted(seed, attachment),
        ),
        [documentOwner],
    );
    useNewSessionSeededComposerAttachments({
        scope: params.draftScope,
        draftId,
        ref,
        seeds: pendingAttachmentSeeds,
        entriesById: params.composerAttachmentEntriesById,
        localize: composerPluginPresentation.localizePluginText,
        isCurrent: isNewSessionComposerCurrent,
        isSeedAdmitted,
        onSeedsApplied,
    });

    React.useEffect(() => documentOwner.observe(() => {
        if (localApplyInFlightRef.current) return;
        const next = documentOwner.read().document;
        const nextState = {
            attachments: next.composerAttachments,
            mentions: next.structuredInputMentions,
        };
        const stateChanged = !sameDocumentState(documentRef.current, nextState);
        if (
            params.promptStore.getPrompt() === next.text
            && sameDocumentState(documentRef.current, nextState)
        ) {
            return;
        }
        if (
            hydratedScopeKeyRef.current !== params.scopeKey
            && localDocumentChangeRef.current
            && (
                params.promptStore.getPrompt() !== next.text
                || !sameDocumentState(documentRef.current, nextState)
            )
        ) {
            return;
        }
        suppressPromptNotificationRef.current = true;
        try {
            params.promptStore.setPrompt(next.text);
        } finally {
            suppressPromptNotificationRef.current = false;
        }
        if (stateChanged) {
            documentRef.current = nextState;
            setDocumentState(nextState);
        }
        notifyComposerPresentationTargetChanged(ref);
    }), [documentOwner, params.promptStore, ref]);

    React.useEffect(() => {
        notifyComposerPresentationTargetChanged(ref);
    }, [params.composerAttachmentEntriesById, ref]);

    React.useEffect(() => params.promptStore.subscribe(() => {
        if (suppressPromptNotificationRef.current) return;
        localDocumentChangeRef.current = true;
        updateDocument({
            text: params.promptStore.getPrompt(),
            state: documentRef.current,
            notify: true,
            local: true,
        });
    }), [params.promptStore, updateDocument]);

    React.useEffect(() => {
        const scopeChanged = hydratedScopeKeyRef.current !== params.scopeKey;
        if (!scopeChanged && localDocumentChangeRef.current) {
            return;
        }
        if (!scopeChanged && sameStrictJsonValue(hydratedAttachmentsRef.current, params.persistedAttachments)) {
            return;
        }

        hydratedScopeKeyRef.current = params.scopeKey;
        hydratedAttachmentsRef.current = params.persistedAttachments;
        if (scopeChanged && localDocumentChangeRef.current) {
            updateDocument({
                text: params.promptStore.getPrompt(),
                state: documentRef.current,
                notify: true,
                local: false,
            });
            return;
        }
        const ownedDocument = documentOwner.read().document;
        if (
            ownedDocument.text.length > 0
            || ownedDocument.structuredInputMentions.length > 0
            || ownedDocument.composerAttachments.length > 0
        ) {
            suppressPromptNotificationRef.current = true;
            try {
                params.promptStore.setPrompt(ownedDocument.text);
            } finally {
                suppressPromptNotificationRef.current = false;
            }
            const ownedState = {
                attachments: ownedDocument.composerAttachments,
                mentions: ownedDocument.structuredInputMentions,
            };
            documentRef.current = ownedState;
            setDocumentState(ownedState);
            notifyComposerPresentationTargetChanged(ref);
            return;
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
        documentOwner,
        params.persistedAttachments,
        ref,
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
        const snapshot = readSnapshot();
        submissionCurrentnessRef.current.set(snapshot, documentOwner.captureCurrentness());
        return snapshot;
    }, [documentOwner, params.promptStore, readSnapshot, updateDocument]);

    const clearAcceptedSnapshot = React.useCallback((snapshot: ComposerSubmissionSnapshot): boolean => {
        if (!mountedRef.current || !composerRefsV1Equal(refRef.current, snapshot.ref)) return false;
        const currentness = submissionCurrentnessRef.current.get(snapshot);
        if (!currentness || !documentOwner.clearAccepted(currentness).changed) return false;
        const next = documentOwner.read().document;
        suppressPromptNotificationRef.current = true;
        try {
            params.promptStore.setPrompt(next.text);
        } finally {
            suppressPromptNotificationRef.current = false;
        }
        const nextState = {
            attachments: next.composerAttachments,
            mentions: next.structuredInputMentions,
        };
        documentRef.current = nextState;
        setDocumentState(nextState);
        notifyComposerPresentationTargetChanged(ref);
        return true;
    }, [documentOwner, params.promptStore, ref]);

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
        const pending = pendingAttachmentSeeds.find((seed) => seed.instanceId === instanceId);
        if (pending) {
            setPendingAttachmentRetirements((current) => ({
                ownerKey: documentOwnerKey,
                instanceIds: new Set([
                    ...(current.ownerKey === documentOwnerKey ? current.instanceIds : []),
                    instanceId,
                ]),
            }));
            if (draftScope && params.draftId) {
                clearNewSessionComposerAttachmentSeedsFromRepository({
                    scope: draftScope,
                    draftId: params.draftId,
                    seeds: [pending],
                });
            }
            notifyComposerPresentationTargetChanged(ref);
            return;
        }
        const result = applyComposerPresentationTransaction({
            ref,
            transaction: {
                expectedRevision: snapshot.revision,
                operations: [{ kind: 'attachment.remove', instanceId }],
            },
        });
        if (result.status !== 'applied') return;
        // The commit path retires the exact pending seed for every removed
        // canonical attachment, including removals issued by Host API callers.
        // Keep this callback a thin canonical transaction launcher.
    }, [draftScope, params.draftId, pendingAttachmentSeeds, readSnapshot, ref]);
    const attachmentViews = React.useMemo(() => documentState.attachments.map((attachment) => (
        composerAttachmentDraftToView(attachment, {
            entriesById: params.composerAttachmentEntriesById,
        })
    )), [documentState.attachments, params.composerAttachmentEntriesById]);
    const pendingAttachmentViews = React.useMemo(
        () => pendingAttachmentSeeds
            .filter((seed) => !documentState.attachments.some((attachment) => (
                isNewSessionComposerAttachmentSeedAdmitted(seed, attachment)
            )))
            .map(projectPendingAttachmentSeed),
        [documentState.attachments, pendingAttachmentSeeds],
    );
    const attachmentRowItems = React.useMemo(() => projectComposerAttachmentRowItems({
        attachments: [...attachmentViews, ...pendingAttachmentViews],
        // Mirrors this scope's `ComposerSnapshotV1.state.editable`: readiness
        // only gates submit, so an unavailable pending seed remains removable.
        ...(!isSubmittingRef.current
            && composerInputEffects.composerInputLock?.mode !== 'editAndSubmit'
            ? { onRemove: removeAttachment }
            : {}),
        entriesById: params.composerAttachmentEntriesById ?? undefined,
        renderSurface: composerPluginPresentation.renderAttachmentSurface,
        resolveInteraction: composerPluginPresentation.resolveAttachmentInteraction,
    }), [
        attachmentViews,
        pendingAttachmentViews,
        composerInputEffects.composerInputLock,
        composerPluginPresentation.renderAttachmentSurface,
        composerPluginPresentation.resolveAttachmentInteraction,
        params.composerAttachmentEntriesById,
        removeAttachment,
    ]);

    return React.useMemo(() => ({
        ref,
        isCurrent: isNewSessionComposerCurrent,
        isReferenceSearchCurrent: isNewSessionReferenceSearchCurrent,
        revision: documentOwner.read().revision,
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
        documentOwner,
    ]);
}
