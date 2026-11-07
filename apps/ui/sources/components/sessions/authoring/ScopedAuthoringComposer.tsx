import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type {
    ComposerAttachmentDraftV1,
    PortableComposerAttachmentV1,
} from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import type {
    ComposerSnapshotV1,
    ComposerTransactionResultV1} from '@happier-dev/protocol/plugins/ui/composer';
import type {
    MentionRefV1} from '@happier-dev/protocol/runtime/input/mentionRefV1';
import * as React from 'react';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { COMPOSER_HOST_PROJECTION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import {
    NEW_SESSION_COMPOSER_SUGGESTION_KINDS,
    type ComposerReferenceSearchHost,
    type ComposerSuggestionKindId,
} from '@/components/autocomplete/composerSuggestionKinds';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { AgentInput } from '@/components/sessions/agentInput';
import {
    AgentInputDocumentPreview,
    type AgentInputDocumentPreviewReference,
    type AgentInputDocumentPreviewSelection,
} from '@/components/sessions/agentInput/components/AgentInputDocumentPreview';
import { resolveAgentInputEngineOptionId } from '@/components/sessions/agentInput/controls/resolveAgentInputEngineOptionId';
import type { AgentInputControlIntent, AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { resolveSessionComposerSuggestions } from '@/components/sessions/agentInput/sessionComposerSuggestions';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';
import { projectComposerAttachmentRowItems } from '@/components/sessions/composer/composerAttachmentProjection';
import type { ComposerDraftDocument } from '@/components/sessions/composer/composerDocumentOwner';
import { projectComposerDocumentSnapshot } from '@/components/sessions/composer/composerSnapshotProjection';
import {
    composerAttachmentDraftToView,
    composerStructuredMentionsFromReferences,
    placePositionlessComposerReferences,
} from '@/components/sessions/composer/composerScopeAdapters';
import { projectAuthoringDocumentPreview } from '@/components/sessions/authoring/authoringDocumentPreview';
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
    useStableComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useComposerPresentationInputEffects } from '@/components/sessions/presentation/useComposerPresentationInputEffects';
import { useComposerScopePluginPresentation } from '@/components/sessions/presentation/useComposerScopePluginPresentation';
import { randomUUID } from '@/platform/randomUUID';
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

export type ScopedAuthoringComposerProps = Readonly<{
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
        /** A narrow host card asks its chips to wrap when the person's setting is auto (a Workflow step). */
        hostActionBarLayout?: React.ComponentProps<typeof AgentInput>['hostActionBarLayout'];
        /** A long document is clipped at the composer's own collapsed height, with its shared expand toggle (a Workflow step). */
        inputMaxHeight?: React.ComponentProps<typeof AgentInput>['inputMaxHeight'];
        inputExpansion?: React.ComponentProps<typeof AgentInput>['inputExpansion'];
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
        /**
         * The host's editing demand, for a host that places many documents at once. `false`
         * shows this document as its static picture (`AgentInputDocumentPreview`) and mounts no
         * editor, menus or dictation; the document's target and scope projection remain available.
         * Activating the picture asks
         * the host through `onRequestEdit`, and the live composer then opens with the caret where
         * the author pointed. Absent, or without `onRequestEdit`, the composer is always live.
         */
        editing?: boolean;
        onRequestEdit?: () => void;
    }>;

/**
 * The controlled scope-aware Composer owner shared by portable Workflow
 * documents and the retained one-shot Automation authoring surface.
 *
 * There is exactly one authoring composer: mention/reference suggestions,
 * plugin attachments and contributed composer controls all come from the same
 * owners ordinary Session authoring uses. What differs is only the scope those
 * owners are addressed with, and a capability the scope genuinely cannot serve
 * stays absent rather than being faked.
 *
 * A host that places many documents at once (a workflow's steps) gives each its
 * editing demand: only the document being edited mounts the live composer, and
 * every other one is its static picture.
 */
// A host draft edit can rerender every row while leaving each sibling document,
// custody and callbacks unchanged. Keep that work outside the live Composer.
export const ScopedAuthoringComposer = React.memo(React.forwardRef<
    ScopedAuthoringComposerHandle,
    ScopedAuthoringComposerProps
>((props, forwardedRef) => {
    const latestRef = React.useRef(props);
    latestRef.current = props;
    const liveRef = React.useRef<ScopedAuthoringComposerHandle>(null);
    const focusOnMountRef = React.useRef(false);
    const controlOnMountRef = React.useRef<AgentInputControlIntent | null>(null);
    const requestEdit = React.useCallback((selection: AgentInputDocumentPreviewSelection | null, intent?: AgentInputControlIntent) => {
        const current = latestRef.current;
        if (selection !== null) current.custody.writeSelection(selection);
        focusOnMountRef.current = true;
        controlOnMountRef.current = intent ?? null;
        current.onRequestEdit?.();
    }, []);
    const consumeFocusOnMount = React.useCallback(() => {
        const focus = focusOnMountRef.current;
        focusOnMountRef.current = false;
        return focus;
    }, []);
    const consumeControlOnMount = React.useCallback(() => {
        const intent = controlOnMountRef.current;
        controlOnMountRef.current = null;
        return intent;
    }, []);
    React.useImperativeHandle(forwardedRef, () => ({
        focus: () => {
            if (liveRef.current) liveRef.current.focus();
            else requestEdit(null);
        },
    }), [requestEdit]);
    return <ScopedAuthoringComposerOwner {...props} ref={liveRef} onRequestPreviewEdit={requestEdit}
        consumeFocusOnMount={consumeFocusOnMount} consumeControlOnMount={consumeControlOnMount} />;
}));

ScopedAuthoringComposer.displayName = 'ScopedAuthoringComposer';

/**
 * The picture of a document that is not being edited. Custody's exact document is used while
 * it is the same document the host holds (its echo), so a duplicated token keeps
 * its exact chip; a host edit since then (undo, an agent's rewrite) is placed from
 * the portable form exactly as the live composer would adopt it. Attachment
 * availability comes from the scope projection independently of editing demand.
 */
function projectAuthoringComposerPreviewDocument(
    custody: AuthoringComposerCustodyEntry,
    document: ScopedAuthoringDocument,
): Readonly<{ text: string; references: readonly AgentInputDocumentPreviewReference[] }> {
    const retained = custody.readDocument();
    const exact = retained !== null && pluginJsonValuesEqual(projectPortableAuthoringDocument(retained), document) ? retained : null;
    return projectAuthoringDocumentPreview(document, exact);
}

/**
 * The plugin regions' frame around a document's composer, shared by the live row and its
 * picture so the regions, their Resource store and their place never change on activation.
 */
function PluginComposerRegions(props: Readonly<{
    before: React.ReactNode;
    after: React.ReactNode;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <PluginContextualResourceStoreProvider>
            {props.before}
            {props.children}
            {props.after}
        </PluginContextualResourceStoreProvider>
    );
}

/** Document/scope custody remains mounted; only the heavy input follows editing demand. */
const ScopedAuthoringComposerOwner = React.forwardRef<
    ScopedAuthoringComposerHandle,
    ScopedAuthoringComposerProps & Readonly<{
        consumeFocusOnMount: () => boolean;
        consumeControlOnMount: () => AgentInputControlIntent | null;
        onRequestPreviewEdit: (selection: AgentInputDocumentPreviewSelection | null, intent?: AgentInputControlIntent) => void;
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
    // Account authority follows the retained document, not a remounted input.
    const accountCurrentness = props.custody.captureAccountCurrentness();
    const accountLifetime = 'scope' in accountCurrentness ? accountCurrentness : null;
    const daemonProjection = useDaemonMergedProjectionInputs({
        sections: COMPOSER_HOST_PROJECTION_SECTIONS,
        accountLifetime,
        machineId,
        serverId,
        enabled: machineId !== null && accountCurrentness.isCurrent(),
    });
    const mountedRef = React.useRef(true);
    const focusedRef = React.useRef(false);
    const editableRef = React.useRef(editable);
    editableRef.current = editable;
    const actionBarLayoutRef = React.useRef<ComposerSnapshotV1['layout']>('wrap');
    const focusRequestRef = React.useRef<(() => void) | null>(null);
    const controlRequestRef = React.useRef<((intent: AgentInputControlIntent) => void) | null>(null);
    const editing = !(props.editing === false && props.onRequestEdit !== undefined && editable);
    React.useImperativeHandle(forwardedRef, () => ({
        focus: () => {
            if (focusRequestRef.current) focusRequestRef.current();
            else props.onRequestPreviewEdit(null);
        },
    }), [props.onRequestPreviewEdit]);
    // Opened from its picture: the input is mounted by now (child effects run first), so the
    // author lands in it, at the caret custody restores.
    const { consumeFocusOnMount, consumeControlOnMount } = props;
    React.useEffect(() => {
        if (!editing) { focusedRef.current = false; return; }
        if (consumeFocusOnMount()) focusRequestRef.current?.();
        const intent = consumeControlOnMount();
        if (intent !== null) controlRequestRef.current?.(intent);
    }, [editing, consumeFocusOnMount, consumeControlOnMount]);

    const isCurrent = React.useCallback(() => (
        mountedRef.current && accountCurrentness.isCurrent()
    ), [accountCurrentness]);
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
            pluginUiProjection: daemonProjection.inputs!.pluginUiProjection,
            isCurrent: () => referenceHostRef.current === host && isCurrent() && focusedRef.current,
        };
        return host;
    }, [daemonProjection.inputs?.pluginProjectionV2, daemonProjection.inputs?.pluginUiProjection, daemonProjection.phase, isCurrent, machineId, serverId]);
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
        props.custody.synchronizeDocument(props.document);
    }, [props.custody, props.document]);

    const readSnapshot = React.useCallback((): ComposerSnapshotV1 => {
        const lock = inputEffects.readComposerInputLock();
        const selection = props.custody.readSelection();
        return projectComposerDocumentSnapshot({ owner: documentOwner,
            attachmentCatalog: { entriesById: attachmentEntriesRef.current },
            presentation: {
                layout: actionBarLayoutRef.current,
                ...(selection === null ? {} : { selection }),
                focused: focusedRef.current,
                editable: editableRef.current && lock?.mode !== 'editAndSubmit',
                submittable: editableRef.current && props.onSubmit !== undefined && lock === null,
                submitting: false,
                running: false,
                ...(lock ? { inputLock: lock } : {}),
            },
        });
    }, [documentOwner, inputEffects.readComposerInputLock, composerRef, props.custody, props.onSubmit]);
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
        readAttachmentComposition: () => attachmentEntriesRef.current === null ? null : ({
            composerAttachmentsById: attachmentEntriesRef.current,
            localize: pluginPresentation.localizePluginText,
        }),
        ...(props.attachmentsEnabled ? { createAttachmentInstanceId: randomUUID } : {}),
        setComposerDecorations: inputEffects.setComposerDecorations,
        acquireComposerInputLock: inputEffects.acquireComposerInputLock,
        isCurrent,
        focusComposer: () => {
            if (!isCurrent() || !editableRef.current) return false;
            if (focusRequestRef.current !== null) focusRequestRef.current();
            else props.onRequestPreviewEdit(null);
            return true;
        },
    } satisfies ComposerPresentationTarget);
    React.useEffect(() => props.custody.registerPresentationTarget(target), [props.custody, target]);
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
    const hostExtraActionChips = props.extraActionChips;
    const extraActionChips = React.useMemo(
        () => [...(hostExtraActionChips ?? []), ...pluginPresentation.extraActionChips],
        [hostExtraActionChips, pluginPresentation.extraActionChips],
    );
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

    if (!editing) {
        const preview = projectAuthoringComposerPreviewDocument(props.custody, props.document);
        const engineLabel = context?.engineLabel ?? context?.agentLabel;
        const engineOptions = context?.agentPickerOptions ?? [];
        const engineOptionId = resolveAgentInputEngineOptionId({
            options: engineOptions, selectedOptionId: context?.agentPickerSelectedOptionId, agentType: context?.agentType,
        });
        const selectedOption = engineOptions.find((option) => option.id === engineOptionId);
        const engineIcon = React.isValidElement<Record<string, unknown>>(selectedOption?.icon)
            ? React.cloneElement(selectedOption.icon, { size: 16 }) : undefined;
        return <PluginComposerRegions before={pluginPresentation.beforeComposer} after={pluginPresentation.afterComposer}>
            <AgentInputDocumentPreview value={preview.text} references={preview.references} placeholder={props.placeholder}
                {...(props.inputAccessibilityLabel === undefined ? {} : { inputAccessibilityLabel: props.inputAccessibilityLabel })}
                engine={context !== undefined && engineLabel !== undefined
                    ? { agentId: context.agentType ?? null, label: engineLabel, ...(engineIcon === undefined ? {} : { icon: engineIcon }) } : null}
                extraActionChips={extraActionChips} attachmentRowItems={attachmentRowItems}
                dictation={props.voiceAffordance === 'dictation'} onActivate={props.onRequestPreviewEdit}
                {...(props.hostActionBarLayout === undefined ? {} : { hostActionBarLayout: props.hostActionBarLayout })} />
        </PluginComposerRegions>;
    }

    return (
        <PluginComposerRegions before={pluginPresentation.beforeComposer} after={pluginPresentation.afterComposer}>
            <AgentInput
                statusRegions={pluginPresentation.statusRegions}
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
                onComposerControlRequestChange={(request) => { controlRequestRef.current = request; }}
                {...(props.hostActionBarLayout === undefined ? {} : { hostActionBarLayout: props.hostActionBarLayout })}
                {...(props.inputMaxHeight === undefined ? {} : { inputMaxHeight: props.inputMaxHeight })}
                {...(props.inputExpansion === undefined ? {} : { inputExpansion: props.inputExpansion })}
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
                voiceAffordance={props.voiceAffordance}
            />
        </PluginComposerRegions>
    );
});

ScopedAuthoringComposerOwner.displayName = 'ScopedAuthoringComposerOwner';
