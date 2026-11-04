import type {
    ComposerAttachmentDraftV1,
    ComposerRefV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
    ParticipantRecipientV1,
    PendingRequestedActionV1,
} from '@happier-dev/protocol';
import { DEFAULT_PENDING_REQUESTED_ACTION_V1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { composerRefsV1Equal } from '@happier-dev/protocol/plugins/ui/composerRef';
import * as React from 'react';

import type {
    ComposerReferenceSearchHost,
    ComposerSuggestionKindId,
} from '@/components/autocomplete/composerSuggestionKinds';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { resolveSessionComposerSuggestions } from '@/components/sessions/agentInput/sessionComposerSuggestions';
import { AgentInput } from '@/components/sessions/agentInput';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import {
    projectAgentInputAttachmentRowItems,
    type AgentInputAttachmentsRowItem,
    type AgentInputExtraActionChip,
} from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputSendOptions } from '@/components/sessions/agentInput/agentInputSendOptions';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { createAttachmentActionChip } from '@/components/sessions/agentInput/sessionActions/createAttachmentActionChip';
import {
    buildStructuredInputMetaOverrides,
    mergeMessageMetaOverrides,
    type ComposerStructuredInputMention,
} from '@/components/sessions/agentInput/structuredInputMentions';
import {
    projectComposerAttachmentRowItems,
} from '@/components/sessions/composer/composerAttachmentProjection';
import {
    composerAttachmentDraftToView,
    composerAttachmentViewToDraft,
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
} from '@/components/sessions/composer/composerScopeAdapters';
import { useRepositoryComposerDocumentOwner } from '@/components/sessions/composer/useRepositoryComposerDocumentOwner';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import {
    openAttachmentFilePickerFiles,
    openAttachmentFilePickerImages,
} from '@/components/sessions/attachments/attachmentFilePickerActions';
import {
    clearSessionAttachmentDrafts,
    readSessionAttachmentDrafts,
    writeSessionAttachmentDrafts,
    type SessionAttachmentDraftScope,
} from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import {
    buildAttachmentMessageMeta,
    uploadAttachmentDraftsToSession,
} from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { useSessionFileUploadAvailability } from '@/components/sessions/files/useSessionFileUploadAvailability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import {
    submitComposerSnapshot,
} from '@/components/sessions/composer/composerSubmissionCoordinator';
import {
    applyComposerPresentationTransaction,
    insertComposerAttachmentReferences,
    removeMountedComposerAttachmentReferences,
    notifyComposerPresentationTargetChanged,
    readComposerPresentationSnapshot,
    registerComposerPresentationTarget,
    useStableComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { buildSessionDraftSyncStatusBadge } from '@/components/sessions/drafts/sessionDraftStatusPresentation';
import { useComposerPresentationInputEffects } from '@/components/sessions/presentation/useComposerPresentationInputEffects';
import { useComposerScopePluginPresentation } from '@/components/sessions/presentation/useComposerScopePluginPresentation';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { ensureSessionDraftAddressesHydrated, getSessionDraftSnapshot, subscribeSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveParticipantRoutedSend } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { BrowserContextState } from '@/sync/domains/browser/context';
import { mergeBrowserContextMessageMetaOverrides } from '@/sync/domains/session/input/browserContext';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { getSessionInputFailureLabelKey } from '@/components/sessions/pending/pendingMessageVisualState';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';


/**
 * Thrown by a prepared-submission handler that kept the draft and already shows what happens next
 * (a chooser, an inline state): the composer keeps the draft and says nothing more.
 */
export class ParticipantComposerSubmissionHeld extends Error {}

export type ParticipantComposerPreparedSubmission = Readonly<{
    text: string;
    localId: string;
    displayText?: string;
    metaOverrides?: Record<string, unknown>;
    recipient?: ParticipantRecipientV1;
    requestedAction?: PendingRequestedActionV1;
    draft: ParticipantComposerDocument;
    /** Reads the live source document without accepting or clearing the captured submission. */
    readCurrentDraft: () => ParticipantComposerDocument;
    /** Clears the accepted capture and returns the source owner's live residual for destination promotion. */
    onOutboundHandoff: () => ParticipantComposerDocument;
}>;

// R-9: participant composers offer file, vendor-plugin, and daemon composer references plus
// slash commands. No $ skills.
const PARTICIPANT_COMPOSER_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = [
    'file',
    'vendorPlugin',
    'composerReference',
    'slashCommand',
];

/**
 * The composer's engine chip for a start (lab `convo-S2/S3`): the one engine popover, listing who can
 * answer, with the Roles rail at its head when the host offers roles. The host owns what a choice
 * means; the composer only draws it.
 */
export type ParticipantComposerEngine = Readonly<{
    agentType: string;
    label: string;
    modelLabel?: string;
    title: string;
    options: ReadonlyArray<AgentInputChipPickerOption>;
    selectedOptionId: string | null;
    onSelect: (optionId: string) => void;
}>;

export type ParticipantComposerDocument = Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
    // Persisted participant documents retain only semantic attachment draft
    // data. Availability is derived from the exact scoped projection at read
    // time, never retained from the generation that added the attachment.
    attachments: readonly ComposerAttachmentDraftV1[];
}>;

type SessionParticipantComposerProps = Readonly<{
    sessionId: string | null;
    workspace?: Readonly<{ machineId: string; cwd: string }>;
    /** Exact Home route scope when the parent already owns qualified navigation. */
    serverId?: string | null;
    /** The parent Session's input grant, independent of transient launch readiness. */
    canSendMessages: boolean;
    /** Host work in flight may lock editing without changing the Session's access. */
    disabled?: boolean;
    /** Keep authoring available while the host is waiting for a required selection or resource. */
    isSendDisabled?: boolean;
    recipient: ParticipantRecipientV1 | null;
    executionRunRequestedAction?: PendingRequestedActionV1;
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    browserContextState?: BrowserContextState | null;
    /** Host-owned initial text for a newly mounted draft; never overwrites an existing edit. */
    initialText?: string;
    /** Stable authoring identity for this mounted draft and its retries. */
    initialLocalId?: string;
    /** Rowless first-send identity; a known Run naturally uses its Run id. */
    draftOccurrenceId?: string;
    /** Rowless Run authoring fields on the real parent Session draft. */
    launcherDraftKey?: string;
    onDraftDocumentEdit?: () => void;
    /** Reports this mounted composer's exact presentation ref to its host. */
    onComposerRefAvailable?: (ref: Extract<ComposerRefV1, { kind: 'participantMessage' | 'newSession' }> | null) => void;
    /**
     * Optional orchestration port for a destination that must be created before
     * canonical Session input admission. The composer still owns capture,
     * attachment preparation, browser/reference metadata and accepted clearing.
     */
    submitPreparedMessage?: (submission: ParticipantComposerPreparedSubmission) => Promise<void>;
    /** Who answers, when the host lets the person choose (a start); absent for a known target. */
    engine?: ParticipantComposerEngine | null;
    /** What the empty input says ("Reply to GPT-6 Sol…"); the generic prompt otherwise. */
    placeholder?: string;
}>;

export const SessionParticipantComposer = React.memo((props: SessionParticipantComposerProps) => props.sessionId === null
    ? <SessionTranscriptSourceProvider source={null}><SessionParticipantComposerContent {...props} /></SessionTranscriptSourceProvider>
    : (
    <AppSessionTranscriptSourceProvider sessionId={props.sessionId} serverId={props.serverId}>
        <SessionParticipantComposerContent {...props} />
    </AppSessionTranscriptSourceProvider>
));

function SessionParticipantComposerContent(props: SessionParticipantComposerProps) {
    const preferredServerId = usePreferredServerIdForSession({
        serverId: props.serverId,
        sessionId: props.sessionId ?? '',
    });
    const participantServerId = props.serverId?.trim() || preferredServerId;
    const participantSessionAddress = React.useMemo(
        () => normalizeSessionAddress(participantServerId, props.sessionId),
        [participantServerId, props.sessionId],
    );
    const sessionMachineTarget = useSessionMachineTarget(props.sessionId, participantServerId);
    const participantMachineTarget = React.useMemo(() => props.sessionId === null
        ? props.workspace ? { machineId: props.workspace.machineId, basePath: props.workspace.cwd } : null
        : sessionMachineTarget, [props.sessionId, props.workspace?.machineId, props.workspace?.cwd, sessionMachineTarget]);
    const participantServerIds = React.useMemo(() => [participantServerId], [participantServerId]);
    const participantAccountBindings = useServerCredentialAccountScopeBindings(participantServerIds);
    const participantAccountBinding = React.useMemo(
        () => [...participantAccountBindings.values()][0] ?? null,
        [participantAccountBindings],
    );
    const composerAccountLifetime = React.useMemo(() => {
        if (!participantAccountBinding) return null;
        return {
            scope: participantAccountBinding.scope,
            isCurrent: participantAccountBinding.isCurrent,
            onRetire: participantAccountBinding.onRetire,
        };
    }, [participantAccountBinding]);
    const participantAccountId = participantAccountBinding?.accountId.trim() || null;
    const participantDaemonProjection = useDaemonMergedProjectionInputs({
        machineId: participantMachineTarget?.machineId ?? null,
        serverId: participantServerId,
        enabled: participantMachineTarget !== null,
    });
    const [composerInstanceId] = React.useState(randomUUID);
    const composerRef = React.useMemo<Extract<ComposerRefV1, { kind: 'participantMessage' | 'newSession' }>>(() => props.sessionId === null
        ? { kind: 'newSession', instanceId: composerInstanceId }
        : { kind: 'participantMessage', sessionId: props.sessionId, instanceId: composerInstanceId }, [composerInstanceId, props.sessionId]);
    const composerRefRef = React.useRef<ComposerRefV1>(composerRef);
    const layoutPresented = useLayoutPresentationActive();
    const layoutPresentedRef = React.useRef(layoutPresented);
    layoutPresentedRef.current = layoutPresented;
    composerRefRef.current = composerRef;
    const availabilityRef = React.useRef({ canSendMessages: props.canSendMessages, disabled: props.disabled, isSendDisabled: props.isSendDisabled });
    availabilityRef.current = { canSendMessages: props.canSendMessages, disabled: props.disabled, isSendDisabled: props.isSendDisabled };
    const mountedRef = React.useRef(true);
    // Every mounted participant draft has an identity before any upload or
    // network effect. A caller-provided recovery id wins; ordinary known-Run
    // drafts rotate after handoff while rowless launchers own their identity.
    // Cleared to `null` after an outbound handoff so the next submission mints a fresh local id.
    const initialLocalIdRef = React.useRef<string | null>(props.initialLocalId?.trim() || randomUUID());
    const composerInputFocusedRef = React.useRef(false);
    const composerActionBarLayoutRef = React.useRef<ComposerSnapshotV1['layout']>('wrap');
    const composerFocusRequestRef = React.useRef<(() => void) | null>(null);
    const isParticipantComposerCurrent = React.useCallback(() => (
        mountedRef.current
        && composerRefsV1Equal(composerRefRef.current, composerRef)
        && (composerAccountLifetime === null || composerAccountLifetime.isCurrent())
    ), [composerAccountLifetime, composerRef]);
    const runDraftAddress = React.useMemo(() => props.sessionId === null ? null : props.recipient?.kind === 'execution_run'
        ? { kind: 'run' as const, sessionId: props.sessionId, runId: props.recipient.runId }
        : props.launcherDraftKey ? { kind: 'session' as const, sessionId: props.sessionId } : null,
    [props.launcherDraftKey, props.recipient, props.sessionId]);
    // Known Runs and rowless launchers use the same repository while retaining
    // the public participant composer identity. Launcher fields are independent
    // of the parent Session composer's text and routing.
    const participantComposerDocumentOwner = useRepositoryComposerDocumentOwner({
        scope: runDraftAddress ? composerAccountLifetime?.scope ?? null : null,
        ref: composerRef,
        address: runDraftAddress,
        launcherDraftKey: props.launcherDraftKey,
        onDocumentEdit: props.onDraftDocumentEdit,
        capabilities: { text: true, references: props.sessionId !== null, attachments: props.sessionId !== null, submit: true },
        isCurrent: isParticipantComposerCurrent,
        onDocumentChange: () => notifyComposerPresentationTargetChanged(composerRef),
    });
    // The synchronized draft says out loud when it is not reaching the
    // user's other devices; an ephemeral participant draft has nothing to say.
    const runDraftScope = runDraftAddress ? composerAccountLifetime?.scope ?? null : null;
    const subscribeRunDraft = React.useCallback((listener: () => void) => (
        runDraftScope && runDraftAddress
            ? subscribeSessionDraft(runDraftScope, runDraftAddress, listener)
            : () => undefined
    ), [runDraftAddress, runDraftScope]);
    const readRunDraftSnapshot = React.useCallback(() => (
        runDraftScope && runDraftAddress
            ? getSessionDraftSnapshot(runDraftScope, runDraftAddress)
            : null
    ), [runDraftAddress, runDraftScope]);
    const runDraftSnapshot = React.useSyncExternalStore(
        subscribeRunDraft,
        readRunDraftSnapshot,
        readRunDraftSnapshot,
    );
    const runDraftStatusBadge = React.useMemo(
        () => buildSessionDraftSyncStatusBadge(runDraftSnapshot?.status ?? 'clean'),
        [runDraftSnapshot?.status],
    );
    const statusBadges = React.useMemo(
        () => (runDraftStatusBadge ? [runDraftStatusBadge] : []),
        [runDraftStatusBadge],
    );
    const appliedInitialTextRef = React.useRef<Readonly<{
        owner: typeof participantComposerDocumentOwner;
        text: string;
    }> | null>(null);
    React.useEffect(() => {
        const initialText = props.initialText;
        if (!initialText || (appliedInitialTextRef.current?.owner === participantComposerDocumentOwner
            && appliedInitialTextRef.current.text === initialText)) return;
        let mounted = true;
        const applyInitialText = () => {
            if (!mounted || !isParticipantComposerCurrent()) return;
            const current = participantComposerDocumentOwner.read().document;
            if (current.text.length === 0 && current.structuredInputMentions.length === 0 && current.composerAttachments.length === 0) {
                participantComposerDocumentOwner.replaceDocument({ ...current, text: initialText });
            }
            appliedInitialTextRef.current = { owner: participantComposerDocumentOwner, text: initialText };
        };
        if (runDraftScope && runDraftAddress) {
            fireAndForget(ensureSessionDraftAddressesHydrated(runDraftScope, [runDraftAddress]).then((current) => {
                if (current) applyInitialText();
            }), { tag: 'SessionParticipantComposer.initialText' });
        } else {
            applyInitialText();
        }
        return () => { mounted = false; };
    }, [isParticipantComposerCurrent, participantComposerDocumentOwner, props.initialText, runDraftAddress, runDraftScope]);
    const readParticipantDocument = React.useCallback((): ParticipantComposerDocument => {
        const document = participantComposerDocumentOwner.read().document;
        return {
            text: document.text,
            mentions: document.structuredInputMentions,
            attachments: document.composerAttachments,
        };
    }, [participantComposerDocumentOwner]);
    const composerInputEffects = useComposerPresentationInputEffects({
        ref: composerRef,
    });
    const participantComposerReferenceHostRef = React.useRef<ComposerReferenceSearchHost | null>(null);
    const participantComposerReferenceHost = React.useMemo<ComposerReferenceSearchHost | null>(() => {
        const projection = participantDaemonProjection.inputs?.pluginProjectionV2 ?? null;
        const machineId = participantMachineTarget?.machineId ?? null;
        if (
            participantDaemonProjection.phase !== 'ready'
            || machineId === null
            || projection === null
        ) {
            return null;
        }

        let host: ComposerReferenceSearchHost;
        host = {
            machineId,
            serverId: participantServerId,
            projection,
            pluginUiProjection: participantDaemonProjection.inputs!.pluginUiProjection,
            isCurrent: () => (
                participantComposerReferenceHostRef.current === host
                && isParticipantComposerCurrent()
                && composerInputFocusedRef.current
            ),
        };
        return host;
    }, [
        isParticipantComposerCurrent,
        participantDaemonProjection.inputs?.pluginProjectionV2,
        participantDaemonProjection.inputs?.pluginUiProjection,
        participantDaemonProjection.phase,
        participantMachineTarget?.machineId,
        participantServerId,
    ]);
    participantComposerReferenceHostRef.current = participantComposerReferenceHost;
    const participantComposerDropHost = React.useMemo<ComposerReferenceSearchHost | null>(() => (
        participantComposerReferenceHost ? {
            ...participantComposerReferenceHost,
            isCurrent: () => participantComposerReferenceHostRef.current === participantComposerReferenceHost
                && isParticipantComposerCurrent() && layoutPresentedRef.current,
        } : null
    ), [isParticipantComposerCurrent, layoutPresented, participantComposerReferenceHost]);
    const participantComposerPresentation = useComposerScopePluginPresentation({
        composer: composerRef,
        physicalTarget: props.sessionId === null ? { kind: 'app' } : { kind: 'session', sessionId: props.sessionId },
        resourceContext: props.sessionId === null ? { kind: 'global' } : { kind: 'session', sessionId: props.sessionId },
        machineId: participantMachineTarget?.machineId ?? null,
        serverId: participantServerId,
        projectionPhase: participantDaemonProjection.phase,
        projectionInputs: participantDaemonProjection.inputs,
        accountLifetime: composerAccountLifetime,
        isScopeCurrent: isParticipantComposerCurrent,
        attachmentsEnabled: props.sessionId !== null,
        includeSessionActions: props.sessionId !== null,
    });
    // The daemon catalog remains the only availability owner. Persisted
    // drafts contain semantic attachment data only, and this exact current
    // projection determines whether they are sendable.
    const participantComposerAttachmentEntriesById = participantComposerPresentation.attachmentEntriesById;
    const attachmentsUploadConfig = useAttachmentsUploadConfig();
    const attachmentsUploadsFeatureEnabled = useFeatureEnabled('attachments.uploads');
    const attachmentsUploadsTransferAvailable = useSessionFileUploadAvailability(props.sessionId ?? '', participantServerId, 'attachment');
    const attachmentsUploadsEnabled = props.sessionId !== null && attachmentsUploadsFeatureEnabled
        && attachmentsUploadsTransferAvailable
        && composerAccountLifetime !== null;
    const transferDraftScope = React.useMemo<SessionAttachmentDraftScope | null>(() => {
        const serverId = participantServerId?.trim();
        const occurrenceId = props.draftOccurrenceId?.trim()
            || props.initialLocalId?.trim()
            || (props.recipient?.kind === 'execution_run' ? props.recipient.runId : initialLocalIdRef.current);
        if (!serverId || !participantAccountId || !occurrenceId || props.sessionId === null) return null;
        return { serverId, accountId: participantAccountId, sessionId: props.sessionId, occurrenceId };
    }, [participantAccountId, participantServerId, props.draftOccurrenceId, props.initialLocalId, props.recipient, props.sessionId]);
    const initialTransferDrafts = React.useMemo(
        () => attachmentsUploadsEnabled && transferDraftScope
            ? readSessionAttachmentDrafts(transferDraftScope)
            : [],
        [attachmentsUploadsEnabled, transferDraftScope],
    );
    const transferDraftManager = useAttachmentDraftManager({
        enabled: attachmentsUploadsEnabled,
        maxFileBytes: attachmentsUploadConfig.maxFileBytes,
        initialDrafts: initialTransferDrafts,
        ...(props.sessionId ? { eagerUpload: { sessionId: props.sessionId, config: attachmentsUploadConfig } } : {}),
        onPickedDrafts: (drafts) => {
            if (!composerAccountLifetime?.isCurrent()) return;
            insertComposerAttachmentReferences({ ref: composerRef,
                scope: composerAccountLifetime.scope, items: (drafts).map(draft => ({ draft })) });
        },
        onRemoveDraft: (attachmentId) => {
            if (!composerAccountLifetime?.isCurrent()) return;
            removeMountedComposerAttachmentReferences({ ref: composerRef,
                scope: composerAccountLifetime.scope, attachmentId });
        },
    });
    const [isUploadingAttachments, setIsUploadingAttachments] = React.useState(false);
    const activeTransferDraftScopeRef = React.useRef(transferDraftScope);

    React.useEffect(() => {
        if (!transferDraftScope || !attachmentsUploadsEnabled) return;
        // A mounted composer can survive an Account credential replacement.
        // Never write the previous Account's still-rendered bytes into the new
        // scope; the following effect hydrates the manager first.
        if (activeTransferDraftScopeRef.current !== transferDraftScope) return;
        writeSessionAttachmentDrafts(transferDraftScope, transferDraftManager.drafts);
    }, [attachmentsUploadsEnabled, transferDraftManager.drafts, transferDraftScope]);
    React.useEffect(() => {
        const previousScope = activeTransferDraftScopeRef.current;
        if (previousScope === transferDraftScope) return;
        activeTransferDraftScopeRef.current = transferDraftScope;
        // The same person's same unsent staging can be handed a new draft occurrence
        // when its launcher starts another attempt. Only an Account, Home or Session
        // change replaces the owner of these process-local bytes, so the mounted
        // drafts move with the composer instead of being dropped for an empty one.
        if (
            attachmentsUploadsEnabled
            && previousScope
            && transferDraftScope
            && previousScope.serverId === transferDraftScope.serverId
            && previousScope.accountId === transferDraftScope.accountId
            && previousScope.sessionId === transferDraftScope.sessionId
        ) {
            const carried = transferDraftManager.getDraftsSnapshot();
            clearSessionAttachmentDrafts(previousScope);
            if (carried.length > 0) writeSessionAttachmentDrafts(transferDraftScope, carried);
            return;
        }
        transferDraftManager.replaceDrafts(
            transferDraftScope && attachmentsUploadsEnabled
                ? readSessionAttachmentDrafts(transferDraftScope)
                : [],
        );
    }, [
        attachmentsUploadsEnabled,
        transferDraftManager.getDraftsSnapshot,
        transferDraftManager.replaceDrafts,
        transferDraftScope,
    ]);

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
        if (!mountedRef.current || !composerRefsV1Equal(composerRefRef.current, composerRef)) return;
        if (composerInputFocusedRef.current === focused) return;
        composerInputFocusedRef.current = focused;
        notifyComposerPresentationTargetChanged(composerRef);
    }, [composerRef]);

    const onComposerFocusRequestChange = React.useCallback((request: (() => void) | null) => {
        composerFocusRequestRef.current = request;
    }, []);

    const onComposerActionBarLayoutChange = React.useCallback((layout: ComposerSnapshotV1['layout']) => {
        if (!mountedRef.current || !composerRefsV1Equal(composerRefRef.current, composerRef)) return;
        if (composerActionBarLayoutRef.current === layout) return;
        composerActionBarLayoutRef.current = layout;
        notifyComposerPresentationTargetChanged(composerRef);
    }, [composerRef]);

    const updateParticipantComposerDocument = React.useCallback((next: ParticipantComposerDocument, _notify: boolean): number => {
        if (!composerRefsV1Equal(composerRefRef.current, composerRef)) return participantComposerDocumentOwner.read().revision;
        const revision = participantComposerDocumentOwner.replaceDocument({
            text: next.text,
            structuredInputMentions: next.mentions,
            composerAttachments: next.attachments,
        });
        return revision;
    }, [composerRef, participantComposerDocumentOwner]);

    const readParticipantComposerSnapshot = React.useCallback((): ComposerSnapshotV1 => {
        const document = readParticipantDocument();
        const { canSendMessages, disabled, isSendDisabled } = availabilityRef.current;
        const inputLock = composerInputEffects.readComposerInputLock();
        const editable = canSendMessages && !disabled && inputLock?.mode !== 'editAndSubmit';
        const submittable = canSendMessages && !disabled && !isSendDisabled && inputLock === null;
        return {
            revision: participantComposerDocumentOwner.read().revision,
            ref: composerRef,
            text: document.text,
            references: [...composerReferencesFromStructuredMentions({
                text: document.text,
                mentions: document.mentions,
            })],
            attachments: document.attachments.map((attachment) => composerAttachmentDraftToView(attachment, {
                entriesById: participantComposerAttachmentEntriesById,
            })),
            layout: composerActionBarLayoutRef.current,
            capabilities: {
                text: true,
                references: props.sessionId !== null,
                attachments: props.sessionId !== null,
                submit: true,
            },
            state: {
                focused: composerInputFocusedRef.current,
                editable,
                submittable,
                submitting: false,
                running: false,
                ...(inputLock ? { inputLock } : {}),
            },
        };
    }, [composerInputEffects.readComposerInputLock, composerRef, participantComposerAttachmentEntriesById, participantComposerDocumentOwner, readParticipantDocument, props.sessionId]);

    const commitParticipantComposerDocument = React.useCallback((input: Readonly<{
        expectedRevision: number;
        mutation: ComposerPresentationDocumentMutation;
    }>): ComposerTransactionResultV1 => {
        if (!composerRefsV1Equal(composerRefRef.current, composerRef)) return { status: 'composerUnavailable' };
        return participantComposerDocumentOwner.apply(input.expectedRevision, input.mutation);
    }, [composerRef, participantComposerDocumentOwner]);

    const composerTarget = useStableComposerPresentationTarget(composerRef, {
        readPickedAttachments: () => transferDraftManager,
        readScope: () => composerAccountLifetime?.scope ?? null,
        readReferenceWorkspace: () => props.sessionId === null ? null : resolveWorkspaceTargetForSession(participantSessionAddress ?? props.sessionId),
        readRevision: () => participantComposerDocumentOwner.read().revision,
        replace: (text, expectedRevision) => {
            if (participantComposerDocumentOwner.read().revision !== expectedRevision) return participantComposerDocumentOwner.read().revision;
            return updateParticipantComposerDocument({
                ...readParticipantDocument(),
                text,
            }, true);
        },
        readSnapshot: readParticipantComposerSnapshot,
        isPresented: () => layoutPresented,
        commitDocument: commitParticipantComposerDocument,
        createAttachmentInstanceId: randomUUID,
        openAttachmentPicker: () => {
            if (!attachmentsUploadsEnabled || isUploadingAttachments || !transferDraftManager.filePickerRef.current) return false;
            openAttachmentFilePickerFiles(transferDraftManager.filePickerRef.current);
            return true;
        },
        setComposerDecorations: composerInputEffects.setComposerDecorations,
        acquireComposerInputLock: composerInputEffects.acquireComposerInputLock,
        isCurrent: () => (
            mountedRef.current
            && composerRefsV1Equal(composerRefRef.current, composerRef)
            && (composerAccountLifetime === null || composerAccountLifetime.isCurrent())
        ),
        focusComposer: () => {
            if (
                !mountedRef.current
                || !composerRefsV1Equal(composerRefRef.current, composerRef)
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

    React.useEffect(() => registerComposerPresentationTarget(composerRef, composerTarget), [composerRef, composerTarget]);

    React.useEffect(() => {
        props.onComposerRefAvailable?.(composerRef);
        return () => props.onComposerRefAvailable?.(null);
    }, [composerRef, props.onComposerRefAvailable]);

    React.useEffect(() => {
        notifyComposerPresentationTargetChanged(composerRef);
    }, [composerRef, participantComposerAttachmentEntriesById, props.canSendMessages, props.disabled, props.isSendDisabled]);

    const removeComposerAttachment = React.useCallback((instanceId: string) => {
        const snapshot = readComposerPresentationSnapshot(composerRef);
        if (!snapshot) return;
        applyComposerPresentationTransaction({
            ref: composerRef,
            transaction: {
                expectedRevision: snapshot.revision,
                operations: [{ kind: 'attachment.remove', instanceId }],
            },
        });
    }, [composerRef]);

    const document = readParticipantDocument();
    const composerAttachmentViews = React.useMemo(() => document.attachments.map((attachment) => (
        composerAttachmentDraftToView(attachment, {
            entriesById: participantComposerAttachmentEntriesById,
        })
    )), [document.attachments, participantComposerAttachmentEntriesById]);
    const composerAttachmentRowItems = React.useMemo(() => projectComposerAttachmentRowItems({
        attachments: composerAttachmentViews,
        // Mirrors this scope's `ComposerSnapshotV1.state.editable`: removal is
        // a Composer mutation, so a view-only participant or an `editAndSubmit`
        // lock keeps preview/picker access without an enabled remove control
        // the transaction owner would refuse.
        ...(props.canSendMessages && !props.disabled && composerInputEffects.composerInputLock?.mode !== 'editAndSubmit'
            ? { onRemove: removeComposerAttachment }
            : {}),
        entriesById: participantComposerAttachmentEntriesById ?? undefined,
        renderSurface: participantComposerPresentation.renderAttachmentSurface,
        resolveInteraction: participantComposerPresentation.resolveAttachmentInteraction,
    }), [
        composerAttachmentViews,
        composerInputEffects.composerInputLock,
        participantComposerAttachmentEntriesById,
        participantComposerPresentation.renderAttachmentSurface,
        participantComposerPresentation.resolveAttachmentInteraction,
        props.canSendMessages,
        props.disabled,
        removeComposerAttachment,
    ]);

    const handleParticipantSend = React.useCallback((sendOptions?: AgentInputSendOptions) => {
        if (!props.canSendMessages) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return;
        }
        if (props.disabled || props.isSendDisabled) return;

        const currentDocument = readParticipantDocument();
        const liveComposerText = sendOptions?.inputTextOverride ?? currentDocument.text;
        if (liveComposerText !== currentDocument.text) {
            updateParticipantComposerDocument({
                ...currentDocument,
                text: liveComposerText,
            }, true);
        }

        const snapshot = readParticipantComposerSnapshot();
        const submittedCurrentness = participantComposerDocumentOwner.captureCurrentness();
        const submittedTransferDrafts = [...transferDraftManager.getSendableDraftsSnapshot()];
        const submittedTransferDraftIds = new Set(submittedTransferDrafts.map((draft) => draft.id));
        const clearSubmittedTransferDrafts = () => {
            if (submittedTransferDraftIds.size === 0) return;
            const next = transferDraftManager
                .getDraftsSnapshot()
                .filter((draft) => !submittedTransferDraftIds.has(draft.id));
            transferDraftManager.replaceDrafts(next);
            if (transferDraftScope) {
                if (next.length === 0) clearSessionAttachmentDrafts(transferDraftScope);
                else writeSessionAttachmentDrafts(transferDraftScope, next);
            }
        };
        fireAndForget(submitComposerSnapshot({
            snapshot,
            attachmentDraftIds: submittedTransferDrafts.map(draft => draft.id),
            signal: participantComposerPresentation.scopeSignal,
            additionalSendableContent: submittedTransferDrafts.length > 0,
            route: {
                ...(composerRef.kind === 'newSession'
                    ? { kind: 'newSession' as const, ref: composerRef }
                    : { kind: 'participantMessage' as const, ref: composerRef }),
                readCurrentExecutionTarget: () => (
                    participantComposerPresentation.scopeSignal.aborted
                        ? null
                        : {
                            serverId: participantServerId,
                            machineId: participantMachineTarget?.machineId,
                        }
                ),
                admit: async (submittedSnapshot, handoff) => {
                    // One identity covers this mounted draft's transfer staging
                    // and canonical input admission. It survives retries; a
                    // remounted/next draft owns the next identity.
                    const submissionLocalId = initialLocalIdRef.current ?? randomUUID();
                    initialLocalIdRef.current = submissionLocalId;
                    const text = submittedSnapshot.text.trim();
                    const hasComposerAttachments = submittedSnapshot.attachments.length > 0;
                    const snapshotStructuredInputMetaOverrides = buildStructuredInputMetaOverrides({
                        mentions: composerStructuredMentionsFromReferences({
                            references: submittedSnapshot.references,
                            existing: [],
                        }),
                        text: submittedSnapshot.text,
                        ...(hasComposerAttachments
                            ? { composerAttachments: submittedSnapshot.attachments.map(composerAttachmentViewToDraft) }
                            : {}),
                    });
                    const structuredInputMetaOverrides = mergeMessageMetaOverrides(
                        submittedSnapshot.references.length === 0
                            ? sendOptions?.structuredInputMetaOverrides
                            : undefined,
                        Object.keys(snapshotStructuredInputMetaOverrides).length > 0
                            ? snapshotStructuredInputMetaOverrides
                            : undefined,
                    );

                    const mergeBrowserContextMeta = (metaOverrides?: Record<string, unknown>): Record<string, unknown> | undefined | null => {
                        const result = mergeBrowserContextMessageMetaOverrides({
                            // Detached text-only Runs do not inherit a parent Session's browser attachments.
                            state: props.sessionId === null ? null : props.browserContextState ?? null,
                            metaOverrides,
                        });
                        if (result.ok) {
                            return result.metaOverrides;
                        }
                        Modal.alert(t('common.error'), t('browserContext.composer.contextUnavailable'));
                        return null;
                    };

                    try {
                        const outboundText = text;
                        let transferMetaOverrides: Record<string, unknown> | undefined;
                        if (submittedTransferDrafts.length > 0) {
                            if (!composerAccountLifetime || props.sessionId === null) {
                                throw new Error(t('common.unavailable'));
                            }
                            setIsUploadingAttachments(true);
                            const { uploaded } = await uploadAttachmentDraftsToSession({
                                sessionId: props.sessionId,
                                signal: participantComposerPresentation.scopeSignal,
                                sessionTarget: {
                                    serverId: composerAccountLifetime.scope.serverId,
                                    accountId: composerAccountLifetime.scope.accountId,
                                    sessionId: props.sessionId,
                                },
                                drafts: submittedTransferDrafts,
                                config: attachmentsUploadConfig,
                                applyDraftPatch: transferDraftManager.applyDraftPatch,
                                messageLocalId: submissionLocalId,
                            });
                            transferMetaOverrides = buildAttachmentMessageMeta(uploaded);
                        }
                        // Every Session-bound participant destination — including an Execution
                        // Run — is an ordinary target of canonical Session input admission. The
                        // Run carries the same text, structured references, composer attachments
                        // and browser/source context as the main Session; only the recipient
                        // differs. The previous direct `sessionExecutionRunSend` branch was a
                        // second admission system that had to reject attachments and browser
                        // context because it had no metadata channel of its own.
                        const routed =
                            props.recipient
                                ? resolveParticipantRoutedSend({
                                    text: outboundText,
                                    recipient: props.recipient,
                                    ...(props.recipient.kind === 'execution_run'
                                        ? {
                                            requestedAction: props.executionRunRequestedAction
                                                ?? DEFAULT_PENDING_REQUESTED_ACTION_V1,
                                        }
                                        : {}),
                                })
                                : null;

                        if (routed) {
                            const metaOverrides = mergeBrowserContextMeta(mergeMessageMetaOverrides(
                                mergeMessageMetaOverrides(routed.metaOverrides, structuredInputMetaOverrides),
                                transferMetaOverrides,
                            ));
                            if (metaOverrides === null) return { status: 'rejected' };
                            const submission = {
                                text: routed.text,
                                localId: submissionLocalId,
                                ...(routed.displayText
                                    ? { displayText: routed.displayText }
                                    : text.length > 0 && routed.text !== text
                                        ? { displayText: text }
                                        : {}),
                                ...(metaOverrides ? { metaOverrides } : {}),
                                recipient: routed.recipient,
                                ...(routed.requestedAction ? { requestedAction: routed.requestedAction } : {}),
                                draft: {
                                    text: submittedSnapshot.text,
                                    mentions: composerStructuredMentionsFromReferences({
                                        references: submittedSnapshot.references,
                                        existing: [],
                                    }),
                                    attachments: submittedSnapshot.attachments.map(composerAttachmentViewToDraft),
                                },
                                readCurrentDraft: readParticipantDocument,
                                onOutboundHandoff: () => {
                                    initialLocalIdRef.current = null;
                                    handoff.accept();
                                    clearSubmittedTransferDrafts();
                                    return readParticipantDocument();
                                },
                            } satisfies ParticipantComposerPreparedSubmission;
                            if (props.submitPreparedMessage) {
                                await props.submitPreparedMessage(submission);
                            } else if (props.sessionId !== null) await sync.submitMessage(props.sessionId, submission.text, submission.displayText, metaOverrides, {
                                ...(participantServerId ? { serverId: participantServerId } : {}),
                                recipient: routed.recipient,
                                ...(routed.requestedAction ? { requestedAction: routed.requestedAction } : {}),
                                localId: submissionLocalId,
                                callerSurface: 'participant_composer',
                                onOutboundHandoff: submission.onOutboundHandoff,
                            });
                            else throw new Error(t('common.unavailable'));
                            return { status: 'accepted' };
                        }

                        const metaOverrides = mergeBrowserContextMeta(mergeMessageMetaOverrides(
                            structuredInputMetaOverrides,
                            transferMetaOverrides,
                        ));
                        if (metaOverrides === null) return { status: 'rejected' };
                        const submission = {
                            text: outboundText,
                            localId: submissionLocalId,
                            ...(text.length > 0 && outboundText !== text ? { displayText: text } : {}),
                            ...(metaOverrides ? { metaOverrides } : {}),
                            draft: {
                                text: submittedSnapshot.text,
                                mentions: composerStructuredMentionsFromReferences({
                                    references: submittedSnapshot.references,
                                    existing: [],
                                }),
                                attachments: submittedSnapshot.attachments.map(composerAttachmentViewToDraft),
                            },
                            readCurrentDraft: readParticipantDocument,
                            onOutboundHandoff: () => {
                                initialLocalIdRef.current = null;
                                handoff.accept();
                                clearSubmittedTransferDrafts();
                                return readParticipantDocument();
                            },
                        } satisfies ParticipantComposerPreparedSubmission;
                        if (props.submitPreparedMessage) {
                            await props.submitPreparedMessage(submission);
                        } else if (props.sessionId !== null) await sync.submitMessage(
                            props.sessionId,
                            outboundText,
                            text.length > 0 && outboundText !== text ? text : undefined,
                            metaOverrides,
                            {
                                ...(participantServerId ? { serverId: participantServerId } : {}),
                                localId: submissionLocalId,
                                callerSurface: 'participant_composer',
                                onOutboundHandoff: submission.onOutboundHandoff,
                            },
                        );
                        else throw new Error(t('common.unavailable'));
                        return { status: 'accepted' };
                    } catch (error) {
                        if (error instanceof ParticipantComposerSubmissionHeld) return { status: 'rejected' };
                        const failureLabelKey = getSessionInputFailureLabelKey(error);
                        Modal.alert(
                            t('common.error'),
                            failureLabelKey
                                ? t(failureLabelKey)
                                : error instanceof Error ? error.message : t('errors.failedToSendMessage'),
                        );
                        return { status: 'rejected' };
                    } finally {
                        setIsUploadingAttachments(false);
                    }
                },
            },
            clearAcceptedSnapshot: () => participantComposerDocumentOwner.clearAccepted(submittedCurrentness).changed,
        }).then((result) => {
            if (
                result.status === 'blocked'
                && (result.reason === 'attachmentUnavailable' || result.reason === 'mediaContentUnavailable')
            ) {
                Modal.alert(t('common.error'), t('common.unavailable'));
            }
        }), { tag: 'SessionParticipantComposer.sendMessage' });
    }, [
        props.browserContextState,
        props.canSendMessages,
        props.disabled,
        props.isSendDisabled,
        props.executionRunRequestedAction,
        props.recipient,
        props.sessionId,
        props.submitPreparedMessage,
        attachmentsUploadConfig,
        composerAccountLifetime,
        participantMachineTarget?.machineId,
        participantServerId,
        participantComposerDocumentOwner,
        participantComposerPresentation.scopeSignal,
        readParticipantComposerSnapshot,
        transferDraftManager.applyDraftPatch,
        transferDraftManager.getDraftsSnapshot,
        transferDraftManager.replaceDrafts,
        transferDraftScope,
        updateParticipantComposerDocument,
    ]);

    const transferAttachmentChip = React.useMemo(() => attachmentsUploadsEnabled
        ? createAttachmentActionChip({
            onPickFile: () => openAttachmentFilePickerFiles(transferDraftManager.filePickerRef.current),
            onPickImage: () => openAttachmentFilePickerImages(transferDraftManager.filePickerRef.current),
            disabled: isUploadingAttachments,
        })
        : null, [attachmentsUploadsEnabled, isUploadingAttachments, transferDraftManager.filePickerRef]);
    const extraActionChips = React.useMemo(() => [
        ...(props.extraActionChips ?? []),
        ...(transferAttachmentChip ? [transferAttachmentChip] : []),
        ...participantComposerPresentation.extraActionChips,
    ], [participantComposerPresentation.extraActionChips, props.extraActionChips, transferAttachmentChip]);
    const attachmentRowItems = React.useMemo<readonly AgentInputAttachmentsRowItem[]>(() => (
        projectAgentInputAttachmentRowItems({
            items: composerAttachmentRowItems,
            transferAttachments: attachmentsUploadsEnabled
                ? transferDraftManager.agentInputAttachments
                : undefined,
        })
    ), [attachmentsUploadsEnabled, composerAttachmentRowItems, transferDraftManager.agentInputAttachments]);

    return (
        <PluginContextualResourceStoreProvider>
            {participantComposerPresentation.beforeComposer}
            <AgentInput
                composerRef={composerRef}
                composerReferenceHost={props.sessionId === null ? null : participantComposerDropHost}
                composerFileScope={props.sessionId === null ? undefined : resolveWorkspaceTargetForSession(participantSessionAddress ?? props.sessionId)}
                placeholder={props.canSendMessages ? props.placeholder ?? t('session.inputPlaceholder') : t('session.sharing.viewOnlyMode')}
                {...(props.engine ? {
                    agentType: props.engine.agentType,
                    agentLabel: props.engine.label,
                    engineLabel: props.engine.modelLabel ?? props.engine.label,
                    agentPickerTitle: props.engine.title,
                    agentPickerOptions: props.engine.options,
                    agentPickerSelectedOptionId: props.engine.selectedOptionId,
                    onAgentPickerSelect: props.engine.onSelect,
                } : {})}
                value={document.text}
                onComposerFocusChange={onComposerFocusChange}
                onComposerFocusRequestChange={onComposerFocusRequestChange}
                onComposerActionBarLayoutChange={onComposerActionBarLayoutChange}
                composerDecorations={composerInputEffects.composerDecorations}
                composerInputLock={composerInputEffects.composerInputLock}
                onChangeText={(text) => {
                    updateParticipantComposerDocument({
                        ...readParticipantDocument(),
                        text,
                    }, true);
                }}
                structuredInputMentions={document.mentions}
                onStructuredInputMentionsChange={(mentions) => {
                    updateParticipantComposerDocument({
                        ...readParticipantDocument(),
                        mentions,
                    }, true);
                }}
                sessionId={props.sessionId ?? undefined}
                sessionAddress={participantSessionAddress}
                onSend={handleParticipantSend}
                autocompleteKinds={props.sessionId === null ? [] : PARTICIPANT_COMPOSER_SUGGESTION_KINDS}
                autocompleteSuggestions={(query, signal) => props.sessionId === null ? Promise.resolve([]) : resolveSessionComposerSuggestions(props.sessionId, query, {
                    kinds: PARTICIPANT_COMPOSER_SUGGESTION_KINDS,
                    signal,
                    composerReferenceHost: participantComposerReferenceHost,
                })}
                isSendDisabled={!props.canSendMessages || props.disabled || props.isSendDisabled || composerInputEffects.composerInputLock !== null}
                disabled={!props.canSendMessages || props.disabled || composerInputEffects.composerInputLock?.mode === 'editAndSubmit'}
                extraActionChips={extraActionChips}
                statusBadges={statusBadges}
                attachmentRowItems={attachmentRowItems}
                onAttachmentsAdded={attachmentsUploadsEnabled ? transferDraftManager.addWebFiles : undefined}
                hasSendableAttachments={
                    composerAttachmentViews.some((attachment) => attachment.availability.status === 'ready')
                    || transferDraftManager.hasSendableAttachments
                }
            />
            {participantComposerPresentation.afterComposer}
            {attachmentsUploadsEnabled ? (
                <AttachmentFilePicker
                    ref={transferDraftManager.filePickerRef}
                    onAttachmentsPicked={transferDraftManager.addPickedAttachments}
                    multiple
                />
            ) : null}
        </PluginContextualResourceStoreProvider>
    );
}
