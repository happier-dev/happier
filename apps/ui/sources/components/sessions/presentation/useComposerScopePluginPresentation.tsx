import * as React from 'react';
import { Platform, View } from 'react-native';

import type {
    ComposerAttachmentViewV1} from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import type {
    ComposerRefV1} from '@happier-dev/protocol/plugins/ui/composerRef';
import type {
    ComposerSnapshotV1,
    ComposerSurfaceRoleV1} from '@happier-dev/protocol/plugins/ui/composer';
import type {
    PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import type {
    PluginProjectedComposerRegionEntryV1} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type {
    PluginResourceContextV1,
} from '@happier-dev/protocol/plugins/contributions/v2';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { PluginSurfaceTarget } from '@happier-dev/plugin-sdk/ui';

import type { DaemonMergedProjectionPhase } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { compareOrderedComposerContributions } from '@/components/plugins/actions/pluginComposerPlacement';
export { compareOrderedComposerContributions } from '@/components/plugins/actions/pluginComposerPlacement';
import {
    createComposerControlSurfaceListRootStep,
    createComposerControlSurfaceSplitOptions,
    createPluginContributedActionComposerChips,
    EMPTY_PLUGIN_COMPOSER_ACTION_CHIPS,
    type ComposerControlSurfaceLayoutContent,
    type PluginComposerControlHost,
    type PluginComposerControlSurfacePresentation,
} from '@/components/plugins/actions/pluginContributedActionComposerChips';
import {
    createPluginContributedActionController,
    type PluginContributedActionController,
    type PluginContributedActionCurrentSnapshot,
    type PluginContributedActionDescriptor,
} from '@/components/plugins/actions/pluginContributedActionController';
import {
    usePluginUiClientExecutableRegistrationRevision,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import {
    openPluginContributedAction,
    openPluginContributedActionReference,
} from '@/components/plugins/actions/openPluginContributedAction';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import type { BoundPluginSurfaceMountLifetime } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipPickerSurface } from '@/components/sessions/agentInput/components/AgentInputChipPickerSurface';
import { SelectionList } from '@/components/ui/selectionList';
import type {
    AgentInputAttachmentRowBadge,
    AgentInputExtraActionChip,
    AgentInputStatusRegion,
    ComposerAttachmentCatalogRowDescriptor,
    ComposerAttachmentRowSurfacePresentation,
} from '@/components/sessions/agentInput/agentInputContracts';
import { ComposerControlResourceState } from '@/components/sessions/composer/ComposerControlResourceState';
import type {
    ComposerAttachmentRowInteractionPresentation,
} from '@/components/sessions/composer/composerAttachmentProjection';
import {
    createComposerPresentationTransactionApplier,
    readComposerPresentationSnapshot,
    readSessionComposerPresentationTargetAtAddress,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import {
    ComposerPluginSurface,
    type ComposerPluginSurfaceMountRequest,
} from '@/components/sessions/presentation/ComposerPluginSurface';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import type { FocusReturnRef } from '@/keyboard/focusReturn';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    createPluginUiProjectedActionResolver,
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiComposerAttachmentProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PopoverAnchor } from '@/components/ui/popover';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    CurrentUiContextBridge,
    useCurrentUiContextMountPublisher,
    useOptionalCurrentUiContextReader,
} from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useRetainedPluginSurfaceFocusNode } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
    usePluginLocalizedTextResolver,
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';

export type ComposerScopeProjectionInputs = Pick<
    DaemonMergedProjectionInputs,
    'pluginProjectionById' | 'pluginProjectionV2' | 'pluginUiProjection' | 'composerSurfaceCatalog' | 'composerSurfaceActionInputSelectionFacts'
>;

type ComposerAttachmentPresentationRequest = Readonly<{
    attachment: ComposerAttachmentViewV1;
    catalog: ComposerAttachmentCatalogRowDescriptor;
}>;

type ComposerScopeControlActionInput = Readonly<{
    controller: PluginContributedActionController;
    action: PluginContributionIdentityV1;
    input?: unknown;
    signal: AbortSignal;
}>;

type ComposerScopeContributedActionInput = Readonly<{
    anchor?: PopoverAnchor;
    controller: PluginContributedActionController;
    action: PluginContributedActionDescriptor;
    signal: AbortSignal;
}>;

export type ComposerScopePluginPresentation = Readonly<{
    /** Exact current attachment catalog; retained drafts stay separately owned. */
    attachmentEntriesById: Readonly<Record<string, PluginUiComposerAttachmentProjection>> | null;
    /** Projection-bound localization used by every attachment admission path. */
    localizePluginText: PluginLocalizedTextResolver;
    /** Existing Session adapters borrow this guarded controller; they do not own a second snapshot. */
    actionController: PluginContributedActionController;
    /** Existing Session physical slots consume this exact normalized region projection. */
    composerRegions: readonly PluginProjectedComposerRegionEntryV1[];
    /** Reads the exact current action scope for Session-only presentation adapters. */
    getCurrentActionSnapshot: () => PluginContributedActionCurrentSnapshot | null;
    /** Cancels Session-only adapters when this shared scope retires. */
    scopeSignal: AbortSignal;
    /** Existing Session physical slots delegate the exact mount back to this owner. */
    renderComposerRegion: (region: PluginProjectedComposerRegionEntryV1) => React.ReactNode;
    /** Feed these through the incumbent AgentInput control/overflow owner. */
    extraActionChips: readonly AgentInputExtraActionChip[];
    /** Physical rich-region slots owned by the surrounding Composer screen. */
    beforeComposer: React.ReactNode;
    afterComposer: React.ReactNode;
    /** Items consumed by the incumbent instrument strip, in canonical region order. */
    statusRegions: readonly AgentInputStatusRegion[];
    renderAttachmentSurface: (input: ComposerAttachmentPresentationRequest) => ComposerAttachmentRowSurfacePresentation | undefined;
    resolveAttachmentInteraction: (input: ComposerAttachmentPresentationRequest) => ComposerAttachmentRowInteractionPresentation | undefined;
}>;

export type ComposerScopePluginPresentationParams = Readonly<{
    composer: ComposerRefV1;
    /** Account compositions borrow one Administration-selected plugin supply at a time. */
    contributorPluginId?: string;
    /** Existing exact surface target: app before creation, Session afterward. */
    physicalTarget: PluginSurfaceTarget;
    /** Existing Resource context; New Session must remain global. */
    resourceContext: PluginResourceContextV1;
    machineId: string | null;
    serverId?: string | null;
    projectionPhase: DaemonMergedProjectionPhase;
    projectionInputs: ComposerScopeProjectionInputs | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    /** The scope's document/lifecycle owner remains the source of currentness. */
    isScopeCurrent: () => boolean;
    attachmentsEnabled: boolean;
    /** Existing session Action rows are not copied into non-session composers. */
    includeSessionActions?: boolean;
    onOpenControlAction?: (input: ComposerScopeControlActionInput) => void;
    onOpenContributedAction?: (input: ComposerScopeContributedActionInput) => void;
}>;

const dialogFrameStyle = { minWidth: 280, maxWidth: 720 } as const;
const contentDialogFillStyle = { ...dialogFrameStyle, flex: 1 } as const;

function ComposerScopePluginSurfaceDialog(props: CustomModalInjectedProps & Readonly<{
    title: string;
    layout?: 'content' | 'list' | 'split';
    surfaceKey?: string;
    accessibilityLabel?: string;
    children: React.ReactNode;
}>): React.ReactElement {
    React.useEffect(() => {
        props.setChrome?.({
            kind: 'card',
            title: props.title,
            scrollHost: 'body',
            // A declared layout means the surface owns its scrolling: `content`
            // fills the bounded body and scrolls its own List, as the list and
            // split shells do. Only an undeclared dialog (a chip's preview)
            // lets the modal body scroll for it.
            bodyScroll: props.layout === undefined ? 'auto' : 'none',
        });
        return () => props.setChrome?.(null);
    }, [props.layout, props.setChrome, props.title]);

    const layoutContent: ComposerControlSurfaceLayoutContent = {
        surfaceKey: props.surfaceKey ?? `composer-surface-dialog:${props.title}`,
        label: props.title,
        accessibilityLabel: props.accessibilityLabel ?? props.title,
        renderContent: () => props.children,
    };
    const content = props.layout === 'list'
        ? (
            <SelectionList
                rootStep={createComposerControlSurfaceListRootStep(layoutContent)}
                selectedOptionId={layoutContent.surfaceKey}
                onSelect={() => {
                    // The mounted surface owns its own interaction. The list
                    // shell only provides its semantic scrolling container.
                }}
                onRequestClose={props.onClose}
                optionsHostInlineControls
            />
        )
        : props.layout === 'split'
            ? (
                <AgentInputChipPickerSurface
                    title=""
                    showCloseButton={false}
                    options={createComposerControlSurfaceSplitOptions(layoutContent)}
                    selectedOptionId={layoutContent.surfaceKey}
                    onSelect={() => {
                        // The mounted surface owns its own interaction. The
                        // rail only selects its incumbent detail presentation.
                    }}
                    onRequestClose={props.onClose}
                />
            )
            : props.children;

    return (
        <View style={props.layout === 'content' ? contentDialogFillStyle : dialogFrameStyle}>
            {content}
        </View>
    );
}

/** One identity for an omitted catalog, so the surface renderer (and every region the Session composer shows) stays stable across host renders. */
const EMPTY_COMPOSER_SURFACE_CATALOG: NonNullable<NonNullable<ComposerScopePluginPresentationParams['projectionInputs']>['composerSurfaceCatalog']> = [];

/**
 * Projects one live Composer document through the existing daemon catalog,
 * control, contextual-Resource, and physical surface seams. It does not own a
 * document, projection cache, renderer selection, target, or action executor.
 */
export function useComposerScopePluginPresentation(
    params: ComposerScopePluginPresentationParams,
): ComposerScopePluginPresentation {
    const clientExecutableRegistrationRevision = usePluginUiClientExecutableRegistrationRevision();
    const currentUiContextReader = useOptionalCurrentUiContextReader();
    const currentUiContextPublisher = useCurrentUiContextMountPublisher();
    const retainedDialogFocus = useRetainedPluginSurfaceFocusNode(null);
    const retainedDialogFocusRef = React.useRef(retainedDialogFocus);
    React.useLayoutEffect(() => { retainedDialogFocusRef.current = retainedDialogFocus; }, [retainedDialogFocus]);
    const destinationNavigation = usePluginSurfaceDestinationNavigationBinding();
    const openDestinationSurface = destinationNavigation?.openSurface;
    const isScopeCurrentRef = React.useRef(params.isScopeCurrent);
    isScopeCurrentRef.current = params.isScopeCurrent;
    const scopeIsCurrent = params.isScopeCurrent();
    const physicalTargetRef = React.useRef(params.physicalTarget);
    physicalTargetRef.current = params.physicalTarget;
    const resourceContextRef = React.useRef(params.resourceContext);
    resourceContextRef.current = params.resourceContext;
    const scopeKey = React.useMemo(() => composerRefV1Key(params.composer), [params.composer]);
    const canonicalComposer = React.useMemo(() => params.composer, [scopeKey]);
    // Keyed on the target's values, not its object identity: callers rebuild an equal target on
    // every render, and a new address here re-creates the whole Composer scope (snapshot, surface
    // lifetime, every surface controller), whose committed publication re-renders the caller.
    const physicalTargetSessionId = params.physicalTarget.kind === 'session'
        ? params.physicalTarget.sessionId
        : null;
    const exactSessionAddress = React.useMemo(() => (
        physicalTargetSessionId !== null
        && canonicalComposer.kind === 'session'
        && canonicalComposer.sessionId === physicalTargetSessionId
        && params.serverId
            ? { serverId: params.serverId, sessionId: physicalTargetSessionId }
            : null
    ), [canonicalComposer, physicalTargetSessionId, params.serverId]);
    const readCurrentComposerSnapshot = React.useCallback((): ComposerSnapshotV1 | null => {
        if (canonicalComposer.kind !== 'session') {
            return readComposerPresentationSnapshot(canonicalComposer,
                canonicalComposer.kind === 'discussion' ? params.accountLifetime?.scope ?? null : undefined);
        }
        if (
            !exactSessionAddress
            || canonicalComposer.sessionId !== exactSessionAddress.sessionId
        ) {
            return null;
        }
        return readSessionComposerPresentationTargetAtAddress(exactSessionAddress)?.readSnapshot?.() ?? null;
    }, [canonicalComposer, exactSessionAddress, params.accountLifetime]);
    const physicalTargetKey = physicalTargetSessionId !== null ? `session:${physicalTargetSessionId}` : 'app';
    const resourceContextKey = React.useMemo(() => JSON.stringify(params.resourceContext), [params.resourceContext]);
    const scopeAbort = React.useMemo(() => new AbortController(), [
        params.accountLifetime,
        params.contributorPluginId,
        params.machineId,
        physicalTargetKey,
        params.projectionInputs?.pluginProjectionById,
        params.projectionInputs?.pluginProjectionV2?.generation,
        params.projectionPhase,
        resourceContextKey,
        params.serverId,
        params.isScopeCurrent,
        scopeIsCurrent,
        scopeKey,
    ]);
    React.useEffect(() => () => scopeAbort.abort(), [scopeAbort]);

    const localizePluginText = usePluginLocalizedTextResolver({
        projection: params.projectionPhase === 'ready' ? params.projectionInputs?.pluginUiProjection : null,
    });
    const localizePluginTextRef = React.useRef(localizePluginText);
    localizePluginTextRef.current = localizePluginText;
    const localizeMountedPluginText = React.useCallback<PluginLocalizedTextResolver>(
        (pluginId, value) => localizePluginTextRef.current(pluginId, value),
        [],
    );
    const actionSnapshotRef = React.useRef<PluginContributedActionCurrentSnapshot | null>(null);
    const actionSnapshot = React.useMemo<PluginContributedActionCurrentSnapshot | null>(() => {
        const inputs = params.projectionInputs;
        const projection = inputs?.pluginProjectionV2;
        const generation = projection?.generation;
        if (
            params.projectionPhase !== 'ready'
            || !inputs
            || !projection
            || generation === null
            || generation === undefined
            || !params.machineId
            || !scopeIsCurrent
        ) {
            return null;
        }
        const physicalTarget = physicalTargetRef.current;
        let snapshot!: PluginContributedActionCurrentSnapshot;
        snapshot = {
            pluginProjectionById: inputs.pluginProjectionById,
            pluginUiProjection: inputs.pluginUiProjection,
            localize: localizeMountedPluginText,
            resolveContributedAction: createPluginUiProjectedActionResolver(
                projection.actionsById,
            ),
            host: {
                machineId: params.machineId,
                serverId: params.serverId ?? null,
                ...(physicalTarget.kind === 'session'
                    ? { sessionId: physicalTarget.sessionId }
                    : {}),
                signal: scopeAbort.signal,
                accountLifetime: params.accountLifetime,
                ...(openDestinationSurface ? { openSurface: openDestinationSurface } : {}),
                ...(currentUiContextReader
                    ? { readCurrentUiContext: currentUiContextReader.readCurrentUiContext }
                    : {}),
                isCurrent: () => (
                    actionSnapshotRef.current === snapshot
                    && scopeAbort.signal.aborted === false
                    && isScopeCurrentRef.current()
                    && params.accountLifetime?.isCurrent() !== false
                ),
                currentComposerIntent: () => {
                    if (actionSnapshotRef.current !== snapshot) return null;
                    const composer = readCurrentComposerSnapshot();
                    return composer
                        ? { composer: composer.ref, revision: composer.revision }
                        : null;
                },
            },
        };
        return snapshot;
    }, [
        params.accountLifetime,
        localizeMountedPluginText,
        currentUiContextReader,
        openDestinationSurface,
        scopeKey,
        params.machineId,
        params.projectionInputs,
        params.projectionPhase,
        params.serverId,
        params.isScopeCurrent,
        scopeIsCurrent,
        physicalTargetKey,
        readCurrentComposerSnapshot,
        scopeAbort,
    ]);
    actionSnapshotRef.current = actionSnapshot;
    const actionController = React.useMemo(() => createPluginContributedActionController({
        resolveCurrent: () => actionSnapshotRef.current,
    }), [clientExecutableRegistrationRevision]);
    const getCurrentActionSnapshot = React.useCallback(
        () => actionSnapshotRef.current,
        [],
    );
    const pluginProjection = actionSnapshot?.pluginUiProjection ?? EMPTY_PLUGIN_UI_PROJECTION;
    // Visible controls refresh when their demanded copy arrives. The transaction
    // applier reads that same resolver through a stable callback to retain its mount.
    const pluginProjectionRef = React.useRef(pluginProjection);
    pluginProjectionRef.current = pluginProjection;
    const attachmentEntriesById = actionSnapshot && params.attachmentsEnabled
        ? pluginProjection.composerAttachmentsById
        : null;
    const composerControls = React.useMemo(() => {
        if (!actionSnapshot) return [];
        return Object.values(pluginProjection.composerControlsById)
            .filter(control => !params.contributorPluginId || control.identity.pluginId === params.contributorPluginId)
            .filter((control) => (
                params.attachmentsEnabled || control.definition.interaction.kind !== 'attachmentPicker'
            ))
            .sort(compareOrderedComposerContributions);
    }, [actionSnapshot, params.attachmentsEnabled, params.contributorPluginId, pluginProjection.composerControlsById]);
    const composerRegions = React.useMemo(() => {
        if (!actionSnapshot) return [];
        return Object.values(pluginProjection.composerRegionsById)
            .filter(region => !params.contributorPluginId || region.identity.pluginId === params.contributorPluginId)
            .filter((region) => (
                region.definition.scopes === undefined
                || region.definition.scopes.includes(params.composer.kind)
            ))
            .sort(compareOrderedComposerContributions);
    }, [actionSnapshot, params.composer.kind, params.contributorPluginId, pluginProjection.composerRegionsById]);
    const composerSurfaceCatalog = params.projectionInputs?.composerSurfaceCatalog ?? EMPTY_COMPOSER_SURFACE_CATALOG;
    const physicalCatalog = params.projectionInputs?.composerSurfaceCatalog;
    const physicalCatalogRef = React.useRef(physicalCatalog);
    physicalCatalogRef.current = physicalCatalog;
    const transactionApplier = React.useMemo(() => createComposerPresentationTransactionApplier({
        // Metro lowers spreads to Object.assign: keep this live getter on the
        // target object, not a copied source that would freeze the initial catalog.
        get composerAttachmentsById() { return pluginProjectionRef.current.composerAttachmentsById; },
        localize: localizeMountedPluginText,
        ...(params.composer.kind === 'discussion' || params.composer.kind === 'session'
            ? { scope: params.accountLifetime?.scope ?? null } : {}),
        ...(params.composer.kind === 'session'
            ? { sessionAddress: exactSessionAddress }
            : {}),
    }), [
        exactSessionAddress,
        params.accountLifetime,
        localizeMountedPluginText,
        params.composer.kind,
    ]);
    const hasSurfaceSnapshot = actionSnapshot !== null;
    const surfaceLifetime = React.useMemo<BoundPluginSurfaceMountLifetime | null>(() => {
        const catalog = physicalCatalog;
        if (!hasSurfaceSnapshot) return null;
        const isCurrent = (): boolean => (
            // Acquisition retains this exact canonical catalog only while all
            // physical rows, renderer/origin facts and contributor custody are
            // unchanged. Action invocations keep their separate exact snapshot
            // check; attachment-only delivery cannot retire document watches.
            physicalCatalogRef.current === catalog
            && actionSnapshotRef.current !== null
            && scopeAbort.signal.aborted === false
            && isScopeCurrentRef.current()
            && params.accountLifetime?.isCurrent() !== false
        );
        return Object.freeze({
            isCurrent,
            onRetire: (cancel) => {
                if (!isCurrent()) {
                    cancel();
                    return Object.freeze({ dispose() {} });
                }
                let retired = false;
                const retire = (): void => {
                    if (retired) return;
                    retired = true;
                    cancel();
                };
                scopeAbort.signal.addEventListener('abort', retire, { once: true });
                const accountRetirement = params.accountLifetime?.onRetire(retire);
                return Object.freeze({
                    dispose(): void {
                        scopeAbort.signal.removeEventListener('abort', retire);
                        accountRetirement?.dispose();
                    },
                });
            },
        });
    }, [hasSurfaceSnapshot, params.accountLifetime, physicalCatalog, scopeAbort]);
    // The one qualified-destination owner for the scope this Composer is
    // mounted in. Both the declarative control host below and every physical
    // Composer surface reach navigation through it, so a Composer-origin open
    // and a control-origin open cannot resolve differently. A scope with no
    // enclosing destination owner supplies nothing, so the mounted controller
    // installs no `openSurface` and the method refuses as factually
    // unsupported instead of resolving after doing nothing.
    const renderComposerSurface = React.useCallback((request: ComposerPluginSurfaceMountRequest & Readonly<{
        fallback?: React.ReactNode;
    }>, openSurface: PluginSurfaceOpenHandler | undefined = openDestinationSurface): React.ReactNode => {
        const snapshot = actionSnapshotRef.current;
        const inputs = params.projectionInputs;
        const projection = inputs?.pluginProjectionV2;
        if (
            !snapshot
            || !inputs
            || !projection
            || !surfaceLifetime
            || !surfaceLifetime.isCurrent()
        ) {
            return null;
        }
        const { fallback, ...mountRequest } = request;
        return (
            <ComposerPluginSurface
                scope={params.accountLifetime?.scope}
                key={request.instanceKey}
                request={mountRequest}
                {...(fallback === undefined ? {} : { fallback })}
                physicalTarget={physicalTargetRef.current}
                serverId={snapshot.host.serverId}
                projectionGeneration={projection.generation}
                catalogEntries={composerSurfaceCatalog}
                pluginProjectionById={snapshot.pluginProjectionById}
                pluginProjectionV2={projection}
                pluginUiProjection={inputs.pluginUiProjection}
                actionInputSelectionFacts={inputs.composerSurfaceActionInputSelectionFacts}
                machineId={snapshot.host.machineId ?? null}
                parentLifetime={surfaceLifetime}
                transactionApplier={transactionApplier}
                // The same enclosing owner the declarative control host below
                // uses. Resolving it and not handing it to the physical mount
                // installed no `openSurface` on the surface that actually
                // renders the controls, so an enabled row action — Triage's
                // **View details** — refused every press. Absent owner still
                // means absent method: the prop is omitted rather than passed
                // as `undefined`, so the controller keeps reporting the method
                // as factually unsupported.
                {...(openSurface === undefined
                    ? {}
                    : { openSurface })}
            />
        );
    }, [
        composerSurfaceCatalog,
        openDestinationSurface,
        params.accountLifetime,
        params.projectionInputs?.pluginProjectionV2,
        params.projectionInputs?.composerSurfaceActionInputSelectionFacts,
        physicalTargetKey,
        surfaceLifetime,
        transactionApplier,
    ]);
    const renderAttachmentPickerSurface = React.useCallback((
        identity: PluginContributionIdentityV1,
        occurrenceId: string,
        instanceKey: string,
        openSurface?: PluginSurfaceOpenHandler,
    ): React.ReactNode => {
        if (!params.attachmentsEnabled) return null;
        const snapshot = readCurrentComposerSnapshot();
        if (!snapshot) return null;
        return renderComposerSurface({
            contribution: identity,
            occurrenceId,
            role: 'attachmentPicker',
            input: {
                v: 1,
                role: 'attachmentPicker',
                composer: params.composer,
                attachmentLocalId: identity.localId,
                instances: snapshot.attachments.filter((instance) => (
                    instance.attachment.pluginId === identity.pluginId
                    && instance.attachment.localId === identity.localId
                )),
            },
            instanceKey,
        }, openSurface);
    }, [params.attachmentsEnabled, params.composer, readCurrentComposerSnapshot, renderComposerSurface]);
    const renderControlSurface = React.useCallback((presentation: PluginComposerControlSurfacePresentation, openSurface?: PluginSurfaceOpenHandler): React.ReactNode => {
        if (presentation.kind === 'control') {
            const role: ComposerSurfaceRoleV1 = presentation.role === 'compact'
                ? 'controlCompact'
                : 'controlInteraction';
            return renderComposerSurface({
                contribution: presentation.control.identity,
                occurrenceId: presentation.control.occurrenceId,
                role,
                input: {
                    v: 1,
                    role,
                    composer: params.composer,
                    controlLocalId: presentation.control.identity.localId,
                    state: presentation.state,
                },
                instanceKey: `composer:${role}:${presentation.control.id}`,
                // A compact renderer sits inside the chip's button: when it cannot mount, the host
                // draws the chip's own content instead of its unavailable card.
                ...(presentation.role === 'compact' && presentation.fallback !== undefined
                    ? { fallback: presentation.fallback }
                    : {}),
            }, openSurface);
        }
        if (!params.attachmentsEnabled) return null;
        const attachments = Object.values(pluginProjection.composerAttachmentsById).filter((attachment) => (
            attachment.identity.pluginId === presentation.control.identity.pluginId
            && attachment.identity.localId === presentation.attachmentLocalId
        ));
        if (attachments.length !== 1) return null;
        const attachment = attachments[0]!;
        return renderAttachmentPickerSurface(
            attachment.identity,
            attachment.occurrenceId,
            `composer:attachmentPicker:${attachment.id}`,
            openSurface,
        );
    }, [
        params.attachmentsEnabled,
        params.composer,
        pluginProjection.composerAttachmentsById,
        renderAttachmentPickerSurface,
        renderComposerSurface,
    ]);
    const renderComposerRegion = React.useCallback((region: PluginProjectedComposerRegionEntryV1): React.ReactNode => {
        if (!region.occurrenceId) return null;
        return renderComposerSurface({
            contribution: region.identity,
            occurrenceId: region.occurrenceId,
            role: 'region',
            input: {
                v: 1,
                role: 'region',
                composer: params.composer,
                regionLocalId: region.identity.localId,
            },
            instanceKey: `composer:region:${region.id}`,
        });
    }, [params.composer, renderComposerSurface]);
    const openSurfaceDialog = React.useCallback((input: Readonly<{
        title: string;
        layout?: 'content' | 'list' | 'split';
        surfaceKey?: string;
        accessibilityLabel?: string;
        renderContent: (openSurface: PluginSurfaceOpenHandler | undefined) => React.ReactNode;
        focusReturnRef?: FocusReturnRef;
    }>): void => {
        const lifetime = surfaceLifetime;
        if (!lifetime || !lifetime.isCurrent()) return;
        let modalId: string | null = null;
        const content = input.renderContent(openDestinationSurface === undefined ? undefined : async (request) => {
            const outcome = await openDestinationSurface(request);
            // The destination owner settles navigation. Dismiss this picker
            // only after success; a refusal leaves its recovery controls open.
            if (outcome.ok && modalId) Modal.hide(modalId);
            return outcome;
        });
        if (content === null || content === undefined) return;
        let retiredBeforeShow = false;
        const retirement = lifetime.onRetire(() => {
            retiredBeforeShow = true;
            if (modalId) Modal.hide(modalId);
        });
        modalId = Modal.show({
            component: ComposerScopePluginSurfaceDialog,
            props: {
                title: input.title,
                ...(input.layout === undefined ? {} : { layout: input.layout }),
                ...(input.surfaceKey === undefined ? {} : { surfaceKey: input.surfaceKey }),
                ...(input.accessibilityLabel === undefined ? {} : { accessibilityLabel: input.accessibilityLabel }),
                // ModalProvider lives outside CurrentUiContextProvider and the
                // Composer's focus owner. Carry their existing capabilities
                // into the reparented picker instead of installing a second
                // current-context owner or leaving its Host API unsupported.
                children: React.cloneElement(retainedDialogFocusRef.current, undefined,
                    <CurrentUiContextBridge publisher={currentUiContextPublisher} reader={currentUiContextReader}>
                        {content}
                    </CurrentUiContextBridge>,
                ),
            },
            closeOnBackdrop: true,
            focusReturnRef: input.focusReturnRef,
            onRequestClose: () => retirement.dispose(),
            onHostUnmount: () => retirement.dispose(),
        });
        if (!modalId) {
            retirement.dispose();
            return;
        }
        if (retiredBeforeShow) Modal.hide(modalId);
    }, [currentUiContextPublisher, currentUiContextReader, openDestinationSurface, surfaceLifetime]);
    const renderAttachmentPreviewSurface = React.useCallback((
        input: ComposerAttachmentPresentationRequest,
        openSurface?: PluginSurfaceOpenHandler,
    ): React.ReactNode => {
        if (input.catalog.preview?.kind !== 'surface') return null;
        return renderComposerSurface({
            contribution: input.catalog.identity,
            occurrenceId: input.catalog.occurrenceId,
            role: 'attachmentPreview',
            input: {
                v: 1,
                role: 'attachmentPreview',
                composer: params.composer,
                attachmentLocalId: input.catalog.identity.localId,
                instance: input.attachment,
            },
            instanceKey: `composer:attachmentPreview:${input.attachment.instanceId}`,
        }, openSurface);
    }, [params.composer, renderComposerSurface]);
    const renderAttachmentSurface = React.useCallback((
        input: ComposerAttachmentPresentationRequest,
    ): ComposerAttachmentRowSurfacePresentation | undefined => {
        if (input.catalog.display?.kind !== 'surface') return undefined;
        const renderedContent = renderComposerSurface({
            contribution: input.catalog.identity,
            occurrenceId: input.catalog.occurrenceId,
            role: 'attachmentDisplay',
            input: {
                v: 1,
                role: 'attachmentDisplay',
                composer: params.composer,
                attachmentLocalId: input.catalog.identity.localId,
                instance: input.attachment,
            },
            instanceKey: `composer:attachmentDisplay:${input.attachment.instanceId}`,
            // No fallback is installed on purpose. `AgentInputAttachmentsRow`
            // is the sole owner of this instance's row chrome — label, error
            // feedback and removal — and already renders it around this mount.
            // Handing the mount a second attachment row duplicated both inside
            // the first, so failure keeps the surface host's incumbent
            // body-level unavailable/crash presentation instead.
        });
        if (renderedContent === null || renderedContent === undefined) return undefined;
        return { sizing: input.catalog.display.sizing, renderedContent };
    }, [params.composer, renderComposerSurface]);
    const resolveAttachmentInteraction = React.useCallback((
        input: ComposerAttachmentPresentationRequest,
    ): ComposerAttachmentRowInteractionPresentation | undefined => {
        if (surfaceLifetime?.isCurrent() !== true) return undefined;
        const preview = input.catalog.preview;
        if (preview?.kind === 'surface') {
            if (preview.presentation === 'popover' || (preview.presentation === 'auto' && Platform.OS === 'web')) {
                const renderPreviewPopover: NonNullable<AgentInputAttachmentRowBadge['renderPreviewPopover']> = ({
                    open,
                    anchorRef,
                    onRequestClose,
                }) => {
                    if (!open || surfaceLifetime?.isCurrent() !== true) return null;
                    return (
                        <AgentInputContentPopover
                            open={open}
                            anchorRef={anchorRef}
                            content={() => (
                                surfaceLifetime?.isCurrent() === true
                                    ? renderAttachmentPreviewSurface(input)
                                    : null
                            )}
                            onRequestClose={onRequestClose}
                        />
                    );
                };
                return { renderPreviewPopover };
            }
            return {
                onPress: (context) => {
                    openSurfaceDialog({
                        title: input.attachment.presentation.label,
                        renderContent: (openSurface) => renderAttachmentPreviewSurface(input, openSurface),
                        focusReturnRef: context?.focusReturnRef,
                    });
                },
            };
        }
        if (preview !== undefined || input.catalog.picker === undefined) return undefined;
        return {
            onPress: (context) => {
                openSurfaceDialog({
                    title: input.attachment.presentation.label,
                    renderContent: (openSurface) => renderAttachmentPickerSurface(
                        input.catalog.identity,
                        input.catalog.occurrenceId,
                        `composer:attachmentPicker:${input.attachment.instanceId}`,
                        openSurface,
                    ),
                    focusReturnRef: context?.focusReturnRef,
                });
            },
        };
    }, [
        openSurfaceDialog,
        renderAttachmentPickerSurface,
        renderAttachmentPreviewSurface,
        surfaceLifetime,
    ]);
    const composerControlHost = React.useMemo<PluginComposerControlHost>(() => ({
        scope: params.composer.kind,
        isCurrent: () => surfaceLifetime?.isCurrent() === true,
        localize: localizePluginText,
        renderControlResourceState: ({ control, children }) => {
            const resource = control.definition.state?.resource;
            const snapshot = actionSnapshotRef.current;
            const accountLifetime = snapshot?.host.accountLifetime;
            const machineId = snapshot?.host.machineId;
            if (
                !resource
                || !snapshot
                || !accountLifetime
                || !machineId
                || surfaceLifetime?.isCurrent() !== true
            ) {
                return children(null, null);
            }
            return (
                <ComposerControlResourceState
                    binding={{
                        accountLifetime,
                        pluginId: control.identity.pluginId,
                        machineId,
                        serverId: snapshot.host.serverId ?? null,
                        expectedCallerOccurrenceId: control.occurrenceId,
                        context: resourceContextRef.current,
                    }}
                    resource={resource}
                    signal={scopeAbort.signal}
                    isCurrent={() => (
                        actionSnapshotRef.current === snapshot
                        && surfaceLifetime?.isCurrent() === true
                    )}
                >
                    {children}
                </ComposerControlResourceState>
            );
        },
        openAction: ({ action, input }) => {
            if (surfaceLifetime?.isCurrent() !== true) return;
            if (params.onOpenControlAction) {
                params.onOpenControlAction({
                    controller: actionController,
                    action,
                    ...(input === undefined ? {} : { input }),
                    signal: scopeAbort.signal,
                });
                return;
            }
            fireAndForget(openPluginContributedActionReference({
                controller: actionController,
                action,
                ...(input === undefined ? {} : { input }),
                signal: scopeAbort.signal,
            }), { tag: 'ComposerScopePluginPresentation.openControlAction' });
        },
        // The exact current Composer document decides this, not the control's
        // own enablement: a read-only Session, a blocked operation, or an
        // `editAndSubmit` lock all make the transaction owner return
        // `notEditable`, so a mutating choice must present as disabled.
        canMutateComposer: () => (
            surfaceLifetime?.isCurrent() === true
            && readCurrentComposerSnapshot()?.state.editable === true
        ),
        applyComposer: ({ control, operations }) => {
            if (surfaceLifetime?.isCurrent() !== true) return { status: 'composerUnavailable' };
            const snapshot = readCurrentComposerSnapshot();
            if (!snapshot) return { status: 'composerUnavailable' };
            // The canonical result is returned, not discarded: a conflict or a
            // non-editable draft must not present to the user as an applied
            // selection.
            return transactionApplier.apply({
                ref: params.composer,
                admittedContributor: {
                    identity: control.identity,
                    occurrenceId: control.occurrenceId,
                },
                transaction: {
                    expectedRevision: snapshot.revision,
                    operations,
                },
            });
        },
        openDestination: ({ destination }) => {
            if (surfaceLifetime?.isCurrent() !== true || !destinationNavigation) return;
            fireAndForget(Promise.resolve(destinationNavigation.openSurface({ destination })), {
                tag: 'ComposerScopePluginPresentation.openControlDestination',
            });
        },
        renderSurfaceContent: renderControlSurface,
        openSurfaceDialog: (presentation, options) => {
            openSurfaceDialog({
                // A Resource-produced label is already a resolved runtime
                // string; only the declaration needs the current locale.
                title: presentation.state.label ?? localizePluginText(
                    presentation.control.identity.pluginId,
                    presentation.control.definition.label,
                ),
                layout: presentation.layout,
                surfaceKey: `composer:${presentation.kind}:${presentation.control.id}:dialog`,
                accessibilityLabel: presentation.state.accessibilityLabel,
                renderContent: (openSurface) => renderControlSurface(presentation, openSurface),
                // The control affordance that opened this dialog owns the exact
                // native focus-return target; the incumbent modal owner
                // restores it on dismissal.
                ...(options?.focusReturnRef ? { focusReturnRef: options.focusReturnRef } : {}),
            });
        },
    }), [
        actionController,
        destinationNavigation,
        localizePluginText,
        openSurfaceDialog,
        params.composer,
        params.onOpenControlAction,
        readCurrentComposerSnapshot,
        resourceContextKey,
        renderControlSurface,
        scopeAbort,
        surfaceLifetime,
        transactionApplier,
    ]);
    const openContributedAction = React.useCallback((action: PluginContributedActionDescriptor, anchor?: PopoverAnchor): void => {
        if (surfaceLifetime?.isCurrent() !== true) return;
        if (params.onOpenContributedAction) {
            params.onOpenContributedAction({ controller: actionController, action, signal: scopeAbort.signal, anchor });
            return;
        }
        fireAndForget(openPluginContributedAction({
            controller: actionController,
            action,
            anchor,
            signal: scopeAbort.signal,
        }), { tag: 'ComposerScopePluginPresentation.openContributedAction' });
    }, [actionController, params.onOpenContributedAction, scopeAbort, surfaceLifetime]);
    const extraActionChips = React.useMemo(() => {
        if (!actionSnapshot) return EMPTY_PLUGIN_COMPOSER_ACTION_CHIPS;
        return createPluginContributedActionComposerChips({
            controller: actionController,
            openAction: openContributedAction,
            composerControls,
            composerControlHost,
            includeSessionActions: params.includeSessionActions,
        });
    }, [
        actionController,
        actionSnapshot,
        composerControlHost,
        composerControls,
        openContributedAction,
        params.includeSessionActions,
    ]);
    const beforeComposer = React.useMemo(() => composerRegions
        .filter((region) => region.definition.placement === 'beforeComposer')
        .map((region) => <React.Fragment key={region.id}>{renderComposerRegion(region)}</React.Fragment>),
    [composerRegions, renderComposerRegion]);
    const afterComposer = React.useMemo(() => composerRegions
        .filter((region) => region.definition.placement === 'afterComposer')
        .map((region) => <React.Fragment key={region.id}>{renderComposerRegion(region)}</React.Fragment>),
    [composerRegions, renderComposerRegion]);
    const statusRegions = React.useMemo(() => composerRegions
        .filter((region) => region.definition.placement === 'statusStrip')
        .map((region) => ({
            emphasis: region.definition.emphasis,
            node: <React.Fragment key={region.id}>{renderComposerRegion(region)}</React.Fragment>,
        })),
    [composerRegions, renderComposerRegion]);

    return React.useMemo(() => ({
        attachmentEntriesById,
        localizePluginText,
        actionController,
        composerRegions,
        getCurrentActionSnapshot,
        scopeSignal: scopeAbort.signal,
        renderComposerRegion,
        extraActionChips,
        beforeComposer,
        afterComposer,
        statusRegions,
        renderAttachmentSurface,
        resolveAttachmentInteraction,
    }), [
        afterComposer,
        attachmentEntriesById,
        localizePluginText,
        actionController,
        beforeComposer,
        composerRegions,
        extraActionChips,
        getCurrentActionSnapshot,
        renderAttachmentSurface,
        renderComposerRegion,
        resolveAttachmentInteraction,
        scopeAbort,
        statusRegions,
    ]);
}
