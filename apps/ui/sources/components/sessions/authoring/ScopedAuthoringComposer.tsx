import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type {
    ComposerAttachmentDraftV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
    MentionRefV1,
    PortableComposerAttachmentV1,
} from '@happier-dev/protocol';
import * as React from 'react';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    NEW_SESSION_COMPOSER_SUGGESTION_KINDS,
    type ComposerReferenceSearchHost,
    type ComposerSuggestionKindId,
} from '@/components/autocomplete/composerSuggestionKinds';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { AgentInput } from '@/components/sessions/agentInput';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { resolveSessionComposerSuggestions } from '@/components/sessions/agentInput/sessionComposerSuggestions';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';
import { projectComposerAttachmentRowItems } from '@/components/sessions/composer/composerAttachmentProjection';
import type { ComposerDraftDocument } from '@/components/sessions/composer/composerDocumentOwner';
import {
    composerAttachmentDraftToView,
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
    placePositionlessComposerReferences,
} from '@/components/sessions/composer/composerScopeAdapters';
import {
    projectPortableAuthoringDocument,
    useAuthoringComposerDocumentOwner,
    type AuthoringComposerCustodyEntry,
} from '@/components/sessions/authoring/authoringComposerCustody';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
// The machine + folder resolver an authoring surface with no Session uses. It is
// the canonical counterpart of `resolveWorkspaceTargetForSession` and is shared
// with New Session so a workflow step and New Session address the same index.
import { resolveNewSessionFileSuggestionScope } from '@/components/sessions/new/modules/resolveNewSessionFileSuggestionScope';
import {
    applyComposerPresentationTransaction,
    notifyComposerPresentationTargetChanged,
    readComposerPresentationSnapshot,
    registerComposerPresentationTarget,
    useStableComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useComposerPresentationInputEffects } from '@/components/sessions/presentation/useComposerPresentationInputEffects';
import { useComposerScopePluginPresentation } from '@/components/sessions/presentation/useComposerScopePluginPresentation';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

const SESSION_AUTHORING_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = [
    'file',
    'vendorPlugin',
    'composerReference',
    'slashCommand',
];

/**
 * Where an authored document's resources, file search and plugin surfaces are
 * addressed from.
 *
 * The Composer ref remains the portable document identity in both arms. A
 * `session` scope captures an existing Session's machine, daemon projection and
 * catalogs; a `machine` scope is the same capability set addressed by the exact
 * Machine and project folder a Workflow already selects, so an ordinary Workflow
 * step composes through this one owner without a Session id being invented.
 */
export type AuthoringComposerScope =
    | Readonly<{ kind: 'session'; sessionId: string; serverId?: string | null }>
    | Readonly<{
        kind: 'machine';
        /** `null` while the host has not resolved a Machine yet. */
        machineId: string | null;
        serverId?: string | null;
        /** The project folder file search is addressed to; may be home-relative. */
        directory?: string | null;
        machineHomeDir?: string | null;
    }>;

export type ScopedAuthoringDocument = Readonly<{
    text: string;
    references: readonly MentionRefV1[];
    attachments: readonly PortableComposerAttachmentV1[];
}>;

export type ScopedAuthoringComposerHandle = Readonly<{ focus: () => void }>;

/**
 * The controlled scope-aware Composer owner shared by portable Workflow
 * documents and the retained one-shot Automation authoring surface.
 *
 * There is exactly one authoring composer: mention/reference suggestions,
 * plugin attachments and contributed composer controls all come from the same
 * owners ordinary Session authoring uses. What differs is only the scope those
 * owners are addressed with, and a capability the scope genuinely cannot serve
 * stays absent rather than being faked.
 */
export const ScopedAuthoringComposer = React.forwardRef<
    ScopedAuthoringComposerHandle,
    Readonly<{
        /**
         * The host's custody of this document. It owns the exact Composer
         * address, the live document and the caret, so the composer can be
         * re-placed — moved into a group, hidden behind another view — without
         * rebuilding anything the portable form cannot express.
         */
        custody: AuthoringComposerCustodyEntry;
        scope: AuthoringComposerScope;
        document: ScopedAuthoringDocument;
        onChangeDocument?: (document: ScopedAuthoringDocument) => void;
        attachmentsEnabled: boolean;
        editable?: boolean;
        placeholder: string;
        voiceAffordance?: React.ComponentProps<typeof AgentInput>['voiceAffordance'];
        /**
         * The accessible name of the actual text input, for a host that mounts
         * several composers (a workflow names each by its step). The input
         * itself carries it; a label on a wrapper view is never read.
         */
        inputAccessibilityLabel?: string;
        submitAccessibilityLabel?: string;
        onSubmit?: () => void;
        isSubmitDisabled?: boolean;
        extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
        onFocus?: () => void;
        onBlur?: () => void;
        agentInputContext?: Readonly<{
            metadata?: React.ComponentProps<typeof AgentInput>['metadata'];
            agentType?: string;
            agentLabel?: string;
            engineLabel?: string;
            permissionMode?: React.ComponentProps<typeof AgentInput>['permissionMode'];
            showStatusPermissionMode?: boolean;
            modelMode?: string | null;
            machineName?: string | null;
            currentPath?: string | null;
            profileId?: string | null;
            onProfileClick?: () => void;
            agentPickerOptions?: React.ComponentProps<typeof AgentInput>['agentPickerOptions'];
            agentPickerSelectedOptionId?: React.ComponentProps<typeof AgentInput>['agentPickerSelectedOptionId'];
            onAgentPickerSelect?: React.ComponentProps<typeof AgentInput>['onAgentPickerSelect'];
            onAgentClick?: () => void;
        }>;
    }>
>((props, forwardedRef) => {
    const { scope } = props;
    const editable = props.editable !== false && props.onChangeDocument !== undefined;
    const composerRef = props.custody.ref;
    const layoutPresented = useLayoutPresentationActive();
    const layoutPresentedRef = React.useRef(layoutPresented);
    layoutPresentedRef.current = layoutPresented;
    const sessionId = scope.kind === 'session' ? scope.sessionId : null;
    const preferredServerId = usePreferredServerIdForSession(
        { serverId: scope.serverId, sessionId: sessionId ?? '' },
        sessionId !== null,
    );
    const sessionMachineTarget = useSessionMachineTarget(sessionId, preferredServerId);
    const serverId = scope.kind === 'session' ? preferredServerId : scope.serverId ?? null;
    const voiceSessionAddress = React.useMemo(
        () => scope.kind === 'session'
            ? normalizeSessionAddress(scope.serverId, scope.sessionId)
            : null,
        [scope.kind, scope.serverId, sessionId],
    );
    const machineId = scope.kind === 'session'
        ? sessionMachineTarget?.machineId ?? null
        : scope.machineId;
    const daemonProjection = useDaemonMergedProjectionInputs({
        machineId,
        serverId,
        enabled: machineId !== null,
    });
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const mountedRef = React.useRef(true);
    const focusedRef = React.useRef(false);
    const editableRef = React.useRef(editable);
    editableRef.current = editable;
    const actionBarLayoutRef = React.useRef<ComposerSnapshotV1['layout']>('wrap');
    const focusRequestRef = React.useRef<(() => void) | null>(null);
    React.useImperativeHandle(forwardedRef, () => ({
        focus: () => focusRequestRef.current?.(),
    }), []);

    const isCurrent = React.useCallback(() => (
        mountedRef.current && (accountLifetime === null || accountLifetime.isCurrent())
    ), [accountLifetime]);
    const onChangeDocumentRef = React.useRef(props.onChangeDocument);
    onChangeDocumentRef.current = props.onChangeDocument;
    const attachmentEntriesRef = React.useRef<ReturnType<typeof useComposerScopePluginPresentation>['attachmentEntriesById']>(null);
    const documentOwner = useAuthoringComposerDocumentOwner({
        custody: props.custody,
        capabilities: {
            text: true,
            references: true,
            attachments: props.attachmentsEnabled,
            submit: editable && props.onSubmit !== undefined,
        },
        createInitialDocument: () => ({
            text: props.document.text,
            structuredInputMentions: composerStructuredMentionsFromReferences({
                references: placePositionlessComposerReferences({
                    text: props.document.text,
                    references: props.document.references,
                }),
                existing: [],
            }),
            composerAttachments: props.document.attachments as readonly ComposerAttachmentDraftV1[],
        }),
        isCurrent,
        onDocumentChange: (next) => {
            if (editableRef.current) onChangeDocumentRef.current?.(projectPortableAuthoringDocument(next));
            notifyComposerPresentationTargetChanged(composerRef);
        },
    });
    const inputEffects = useComposerPresentationInputEffects({ ref: composerRef });
    const referenceHostRef = React.useRef<ComposerReferenceSearchHost | null>(null);
    const referenceHost = React.useMemo<ComposerReferenceSearchHost | null>(() => {
        const projection = daemonProjection.inputs?.pluginProjectionV2 ?? null;
        if (daemonProjection.phase !== 'ready' || machineId === null || projection === null) return null;
        let host: ComposerReferenceSearchHost;
        host = {
            machineId,
            serverId,
            projection,
            isCurrent: () => referenceHostRef.current === host && isCurrent() && focusedRef.current,
        };
        return host;
    }, [daemonProjection.inputs?.pluginProjectionV2, daemonProjection.phase, isCurrent, machineId, serverId]);
    referenceHostRef.current = referenceHost;
    const dropReferenceHost = React.useMemo<ComposerReferenceSearchHost | null>(() => (
        referenceHost ? {
            ...referenceHost,
            isCurrent: () => referenceHostRef.current === referenceHost && isCurrent() && layoutPresentedRef.current,
        } : null
    ), [isCurrent, layoutPresented, referenceHost]);
    const pluginPresentation = useComposerScopePluginPresentation({
        composer: composerRef,
        // A captured Session is a real physical surface and Resource context. A
        // Machine-addressed draft has neither, so it takes the same app/global
        // pair New Session uses rather than borrowing another Session's.
        physicalTarget: sessionId === null ? { kind: 'app' } : { kind: 'session', sessionId },
        resourceContext: sessionId === null ? { kind: 'global' } : { kind: 'session', sessionId },
        machineId,
        serverId,
        projectionPhase: daemonProjection.phase,
        projectionInputs: daemonProjection.inputs,
        accountLifetime,
        isScopeCurrent: isCurrent,
        attachmentsEnabled: props.attachmentsEnabled,
        includeSessionActions: false,
    });
    attachmentEntriesRef.current = pluginPresentation.attachmentEntriesById;

    React.useLayoutEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    React.useEffect(() => {
        // Our own portable projection coming back is not a host edit.
        const current = documentOwner.read().document;
        if (pluginJsonValuesEqual(projectPortableAuthoringDocument(current), props.document)) return;
        documentOwner.replaceDocument({
            text: props.document.text,
            structuredInputMentions: composerStructuredMentionsFromReferences({
                references: placePositionlessComposerReferences({
                    text: props.document.text,
                    references: props.document.references,
                }),
                existing: current.structuredInputMentions,
            }),
            composerAttachments: props.document.attachments as readonly ComposerAttachmentDraftV1[],
        });
    }, [documentOwner, props.document]);

    const readSnapshot = React.useCallback((): ComposerSnapshotV1 => {
        const current = documentOwner.read();
        const lock = inputEffects.readComposerInputLock();
        return {
            revision: current.revision,
            ref: composerRef,
            text: current.document.text,
            references: [...composerReferencesFromStructuredMentions({
                text: current.document.text,
                mentions: current.document.structuredInputMentions,
            })],
            attachments: current.document.composerAttachments.map((attachment) => composerAttachmentDraftToView(
                attachment,
                { entriesById: attachmentEntriesRef.current },
            )),
            layout: actionBarLayoutRef.current,
            capabilities: documentOwner.capabilities,
            state: {
                focused: focusedRef.current,
                editable: editableRef.current && lock?.mode !== 'editAndSubmit',
                submittable: editableRef.current && props.onSubmit !== undefined && lock === null,
                submitting: false,
                running: false,
                ...(lock ? { inputLock: lock } : {}),
            },
        };
    }, [documentOwner, inputEffects.readComposerInputLock, composerRef, props.onSubmit]);
    const commitDocument = React.useCallback((input: Readonly<{
        expectedRevision: number;
        mutation: ComposerPresentationDocumentMutation;
    }>): ComposerTransactionResultV1 => documentOwner.apply(input.expectedRevision, input.mutation), [documentOwner]);
    const target = useStableComposerPresentationTarget(composerRef, {
        readScope: () => accountLifetime?.scope ?? null,
        readRevision: () => documentOwner.read().revision,
        replace: (text, expectedRevision) => {
            if (documentOwner.read().revision !== expectedRevision) return documentOwner.read().revision;
            return documentOwner.replaceDocument({ ...documentOwner.read().document, text });
        },
        readSnapshot,
        isPresented: () => layoutPresented,
        commitDocument,
        ...(props.attachmentsEnabled ? { createAttachmentInstanceId: randomUUID } : {}),
        setComposerDecorations: inputEffects.setComposerDecorations,
        acquireComposerInputLock: inputEffects.acquireComposerInputLock,
        isCurrent,
        focusComposer: () => {
            if (!isCurrent() || focusRequestRef.current === null) return false;
            focusRequestRef.current();
            return true;
        },
    } satisfies ComposerPresentationTarget);
    React.useEffect(() => registerComposerPresentationTarget(composerRef, target), [composerRef, target]);
    React.useEffect(() => notifyComposerPresentationTargetChanged(composerRef), [pluginPresentation.attachmentEntriesById, composerRef]);

    const removeAttachment = React.useCallback((instanceId: string) => {
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

    // File search is addressed per call, so a Machine or folder chosen after the
    // composer mounted starts offering files without a remount.
    const machineFileScope = scope.kind === 'machine' ? scope : null;
    const suggestionKinds = sessionId === null
        ? NEW_SESSION_COMPOSER_SUGGESTION_KINDS
        : SESSION_AUTHORING_SUGGESTION_KINDS;
    const resolveSuggestions = React.useCallback((query: string, signal: AbortSignal) => {
        if (sessionId !== null) {
            return resolveSessionComposerSuggestions(sessionId, query, {
                kinds: SESSION_AUTHORING_SUGGESTION_KINDS,
                signal,
                composerReferenceHost: referenceHost,
            });
        }
        return getSuggestions(null, query, {
            kinds: NEW_SESSION_COMPOSER_SUGGESTION_KINDS,
            serverId,
            workspace: resolveNewSessionFileSuggestionScope({
                targetServerId: serverId,
                selectedMachineId: machineFileScope?.machineId ?? null,
                selectedMachineHomeDir: machineFileScope?.machineHomeDir ?? null,
                selectedPath: machineFileScope?.directory ?? null,
            }),
            signal,
            composerReferenceHost: referenceHost,
        });
    }, [
        machineFileScope?.directory,
        machineFileScope?.machineHomeDir,
        machineFileScope?.machineId,
        referenceHost,
        serverId,
        sessionId,
    ]);

    const current = documentOwner.read().document;
    const attachmentViews = current.composerAttachments.map((attachment) => composerAttachmentDraftToView(
        attachment,
        { entriesById: pluginPresentation.attachmentEntriesById },
    ));
    const attachmentRowItems = projectComposerAttachmentRowItems({
        attachments: attachmentViews,
        ...(editable && inputEffects.composerInputLock?.mode !== 'editAndSubmit'
            ? { onRemove: removeAttachment }
            : {}),
        entriesById: pluginPresentation.attachmentEntriesById ?? undefined,
        renderSurface: pluginPresentation.renderAttachmentSurface,
        resolveInteraction: pluginPresentation.resolveAttachmentInteraction,
    });
    const extraActionChips = [...(props.extraActionChips ?? []), ...pluginPresentation.extraActionChips];
    const context = props.agentInputContext;
    /**
     * The caret, through the composer's own restore seam.
     *
     * A re-placed document keeps its text and references, so leaving the caret
     * behind would still drop the author where they were not typing. The restore
     * generation is the custody entry's, which a freshly mounted input consumes
     * exactly once: resuming a placement restores the caret, while ordinary
     * typing is never interrupted by it.
     */
    const custodySelection = props.custody.readSelection();
    const inputPersistence = React.useMemo(() => ({
        restoreToken: props.custody.selectionRestoreToken,
        ...(custodySelection === null ? {} : { initialSelection: custodySelection }),
        onSelectionChangePersist: (selection: Readonly<{ start: number; end: number }>) => {
            props.custody.writeSelection(selection);
        },
    }), [custodySelection, props.custody]);

    return (
        <PluginContextualResourceStoreProvider>
            {pluginPresentation.beforeComposer}
            <AgentInput
                value={current.text}
                onChangeText={editable ? (text) => documentOwner.replaceDocument({ ...documentOwner.read().document, text }) : undefined}
                structuredInputMentions={current.structuredInputMentions as readonly ComposerStructuredInputMention[]}
                onStructuredInputMentionsChange={editable ? (mentions) => documentOwner.replaceDocument({
                    ...documentOwner.read().document,
                    structuredInputMentions: mentions,
                }) : undefined}
                onComposerFocusChange={(focused) => {
                    focusedRef.current = focused;
                    notifyComposerPresentationTargetChanged(composerRef);
                    if (focused) props.onFocus?.();
                    else props.onBlur?.();
                }}
                onComposerFocusRequestChange={(request) => { focusRequestRef.current = request; }}
                onComposerActionBarLayoutChange={(layout) => {
                    actionBarLayoutRef.current = layout;
                    notifyComposerPresentationTargetChanged(composerRef);
                }}
                composerDecorations={inputEffects.composerDecorations}
                composerInputLock={inputEffects.composerInputLock}
                composerRef={composerRef}
                composerReferenceHost={dropReferenceHost}
                composerFileScope={sessionId !== null
                    ? resolveWorkspaceTargetForSession(voiceSessionAddress ?? sessionId)
                    : resolveNewSessionFileSuggestionScope({
                        targetServerId: serverId,
                        selectedMachineId: machineFileScope?.machineId ?? null,
                        selectedMachineHomeDir: machineFileScope?.machineHomeDir ?? null,
                        selectedPath: machineFileScope?.directory ?? null,
                    })}
                inputPersistence={inputPersistence}
                sessionAddress={voiceSessionAddress}
                {...(sessionId === null ? {} : { sessionId })}
                placeholder={props.placeholder}
                {...(props.inputAccessibilityLabel === undefined
                    ? {}
                    : { inputAccessibilityLabel: props.inputAccessibilityLabel })}
                autocompleteKinds={suggestionKinds}
                autocompleteSuggestions={resolveSuggestions}
                // Absent means authoring only: AgentInput offers no submit path at all.
                {...(!editable || props.onSubmit === undefined ? {} : { onSend: props.onSubmit })}
                submitAccessibilityLabel={props.submitAccessibilityLabel}
                isSendDisabled={props.isSubmitDisabled || inputEffects.composerInputLock !== null}
                disabled={!editable || inputEffects.composerInputLock?.mode === 'editAndSubmit'}
                extraActionChips={extraActionChips}
                attachmentRowItems={attachmentRowItems}
                hasSendableAttachments={attachmentViews.some((attachment) => attachment.availability.status === 'ready')}
                metadata={context?.metadata}
                agentType={context?.agentType}
                agentLabel={context?.agentLabel}
                engineLabel={context?.engineLabel}
                permissionMode={context?.permissionMode}
                showStatusPermissionMode={context?.showStatusPermissionMode}
                modelMode={context?.modelMode ?? undefined}
                machineName={context?.machineName}
                currentPath={context?.currentPath ?? undefined}
                profileId={context?.profileId ?? undefined}
                onProfileClick={context?.onProfileClick}
                agentPickerOptions={context?.agentPickerOptions}
                agentPickerSelectedOptionId={context?.agentPickerSelectedOptionId}
                onAgentPickerSelect={editable ? context?.onAgentPickerSelect : undefined}
                onAgentClick={context?.onAgentClick}
                contentPaddingHorizontal={0}
                panelPresentation="document"
                // A document card's chips wrap under its words at every width (lab editor-P1): a
                // sideways strip would truncate the engine chip on a phone (DESIGN-7 N34).
                autoActionBarLayout="wrap"
                voiceAffordance={props.voiceAffordance}
            />
            {pluginPresentation.afterComposer}
        </PluginContextualResourceStoreProvider>
    );
});

ScopedAuthoringComposer.displayName = 'ScopedAuthoringComposer';
