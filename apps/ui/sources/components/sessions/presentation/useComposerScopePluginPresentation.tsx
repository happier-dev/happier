import * as React from 'react';
import { Platform, View } from 'react-native';

import type {
    ComposerAttachmentViewV1,
    ComposerRefV1,
    ComposerSnapshotV1,
    ComposerSurfaceRoleV1,
    PluginContributionIdentityV1,
    PluginProjectedComposerRegionEntryV1,
    PluginResourceContextV1,
} from '@happier-dev/protocol';
import type { PluginSurfaceTarget } from '@happier-dev/plugin-sdk/ui';

import type { DaemonMergedProjectionPhase } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    createComposerControlSurfaceListRootStep,
    createComposerControlSurfaceSplitOptions,
    createPluginContributedActionComposerChips,
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
import type { BoundPluginSurfaceMountLifetime } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipPickerSurface } from '@/components/sessions/agentInput/components/AgentInputChipPickerSurface';
import { SelectionList } from '@/components/ui/selectionList';
import type {
    AgentInputAttachmentRowBadge,
    AgentInputExtraActionChip,
    ComposerAttachmentCatalogRowDescriptor,
    ComposerAttachmentRowSurfacePresentation,
} from '@/components/sessions/agentInput/agentInputContracts';
import { ComposerControlResourceState } from '@/components/sessions/composer/ComposerControlResourceState';
import type {
    ComposerAttachmentRowInteractionPresentation,
} from '@/components/sessions/composer/composerAttachmentProjection';
import {
    composerPresentationTargetKey,
    createComposerPresentationTransactionApplier,
    readComposerPresentationSnapshot,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import {
    ComposerPluginSurface,
    type ComposerPluginSurfaceMountRequest,
} from '@/components/sessions/presentation/ComposerPluginSurface';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    createPluginUiProjectedActionResolver,
    normalizePluginUiProjection,
    type PluginUiComposerAttachmentProjection,
} from '@/sync/domains/plugins/ui/projection';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';

export type ComposerScopeProjectionInputs = Pick<
    DaemonMergedProjectionInputs,
    'pluginProjectionById' | 'pluginProjectionV2' | 'composerSurfaceCatalog'
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
    controller: PluginContributedActionController;
    action: PluginContributedActionDescriptor;
    signal: AbortSignal;
}>;

type OrderedComposerContribution = Readonly<{
    id: string;
    definition: Readonly<{ order?: number }>;
}>;

/**
 * Composer declarations are admitted as maps for identity lookup. Their visual
 * projection is a separate host-owned ordering concern: authored rank first,
 * then the qualified contribution id so map insertion order cannot leak into
 * the control rail or before/after region slots.
 */
function compareOrderedComposerContributions(
    left: OrderedComposerContribution,
    right: OrderedComposerContribution,
): number {
    return (left.definition.order ?? 0) - (right.definition.order ?? 0)
        || left.id.localeCompare(right.id);
}

export type ComposerScopePluginPresentation = Readonly<{
    /** Exact current attachment catalog; retained drafts stay separately owned. */
    attachmentEntriesById: Readonly<Record<string, PluginUiComposerAttachmentProjection>> | null;
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
    renderAttachmentSurface: (input: ComposerAttachmentPresentationRequest) => ComposerAttachmentRowSurfacePresentation | undefined;
    resolveAttachmentInteraction: (input: ComposerAttachmentPresentationRequest) => ComposerAttachmentRowInteractionPresentation | undefined;
}>;

export type ComposerScopePluginPresentationParams = Readonly<{
    composer: ComposerRefV1;
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
            bodyScroll: props.layout === 'content' || props.layout === undefined ? 'auto' : 'none',
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

    return <View style={{ minWidth: 280, maxWidth: 720 }}>{content}</View>;
}

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
    const isScopeCurrentRef = React.useRef(params.isScopeCurrent);
    isScopeCurrentRef.current = params.isScopeCurrent;
    const physicalTargetRef = React.useRef(params.physicalTarget);
    physicalTargetRef.current = params.physicalTarget;
    const resourceContextRef = React.useRef(params.resourceContext);
    resourceContextRef.current = params.resourceContext;
    const scopeKey = React.useMemo(() => composerPresentationTargetKey(params.composer), [params.composer]);
    const physicalTargetKey = React.useMemo(() => (
        params.physicalTarget.kind === 'session'
            ? `session:${params.physicalTarget.sessionId}`
            : 'app'
    ), [params.physicalTarget]);
    const resourceContextKey = React.useMemo(() => JSON.stringify(params.resourceContext), [params.resourceContext]);
    const scopeAbort = React.useMemo(() => new AbortController(), [
        params.accountLifetime,
        params.machineId,
        physicalTargetKey,
        params.projectionInputs?.pluginProjectionById,
        params.projectionInputs?.pluginProjectionV2?.generation,
        params.projectionPhase,
        resourceContextKey,
        params.serverId,
        params.isScopeCurrent,
        scopeKey,
    ]);
    React.useEffect(() => () => scopeAbort.abort(), [scopeAbort]);

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
            || !params.isScopeCurrent()
        ) {
            return null;
        }
        const physicalTarget = physicalTargetRef.current;
        let snapshot!: PluginContributedActionCurrentSnapshot;
        snapshot = {
            pluginProjectionById: inputs.pluginProjectionById,
            pluginUiProjection: normalizePluginUiProjection(projection),
            resolveContributedAction: createPluginUiProjectedActionResolver(
                projection.actionsById,
            ),
            host: {
                machineId: params.machineId,
                serverId: params.serverId ?? null,
                expectedGeneration: generation,
                ...(physicalTarget.kind === 'session'
                    ? { sessionId: physicalTarget.sessionId }
                    : {}),
                signal: scopeAbort.signal,
                accountLifetime: params.accountLifetime,
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
                    const composer = readComposerPresentationSnapshot(params.composer);
                    return composer
                        ? { composer: composer.ref, revision: composer.revision }
                        : null;
                },
            },
        };
        return snapshot;
    }, [
        params.accountLifetime,
        currentUiContextReader,
        scopeKey,
        params.machineId,
        params.projectionInputs,
        params.projectionPhase,
        params.serverId,
        params.isScopeCurrent,
        physicalTargetKey,
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
    const pluginProjection = React.useMemo(() => normalizePluginUiProjection(
        actionSnapshot ? params.projectionInputs?.pluginProjectionV2 ?? null : null,
    ), [actionSnapshot, params.projectionInputs?.pluginProjectionV2]);
    const attachmentEntriesById = actionSnapshot && params.attachmentsEnabled
        ? pluginProjection.composerAttachmentsById
        : null;
    const composerControls = React.useMemo(() => {
        if (!actionSnapshot) return [];
        return Object.values(pluginProjection.composerControlsById)
            .filter((control) => (
                params.attachmentsEnabled || control.definition.interaction.kind !== 'attachmentPicker'
            ))
            .sort(compareOrderedComposerContributions);
    }, [actionSnapshot, params.attachmentsEnabled, pluginProjection.composerControlsById]);
    const composerRegions = React.useMemo(() => {
        if (!actionSnapshot) return [];
        return Object.values(pluginProjection.composerRegionsById)
            .filter((region) => (
                region.definition.scopes === undefined
                || region.definition.scopes.includes(params.composer.kind)
            ))
            .sort(compareOrderedComposerContributions);
    }, [actionSnapshot, params.composer.kind, pluginProjection.composerRegionsById]);
    const composerSurfaceCatalog = params.projectionInputs?.composerSurfaceCatalog ?? [];
    const transactionApplier = React.useMemo(() => createComposerPresentationTransactionApplier({
        composerAttachmentsById: pluginProjection.composerAttachmentsById,
    }), [pluginProjection.composerAttachmentsById]);
    const surfaceLifetime = React.useMemo<BoundPluginSurfaceMountLifetime | null>(() => {
        const snapshot = actionSnapshot;
        if (!snapshot) return null;
        const isCurrent = (): boolean => (
            actionSnapshotRef.current === snapshot
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
    }, [actionSnapshot, params.accountLifetime, scopeAbort]);
    // The one qualified-destination owner for the scope this Composer is
    // mounted in. Both the declarative control host below and every physical
    // Composer surface reach navigation through it, so a Composer-origin open
    // and a control-origin open cannot resolve differently.
    const destinationNavigation = usePluginSurfaceDestinationNavigationBinding();
    const openDestinationSurface = destinationNavigation?.openSurface;
    const renderComposerSurface = React.useCallback((request: ComposerPluginSurfaceMountRequest): React.ReactNode => {
        const snapshot = actionSnapshotRef.current;
        const projection = params.projectionInputs?.pluginProjectionV2;
        if (
            !snapshot
            || !projection
            || !surfaceLifetime
            || !surfaceLifetime.isCurrent()
            || String(projection.generation) !== String(snapshot.host.expectedGeneration)
        ) {
            return null;
        }
        return (
            <ComposerPluginSurface
                key={request.instanceKey}
                request={request}
                physicalTarget={physicalTargetRef.current}
                serverId={snapshot.host.serverId}
                projectionGeneration={projection.generation}
                catalogEntries={composerSurfaceCatalog}
                pluginProjectionById={snapshot.pluginProjectionById}
                pluginProjectionV2={projection}
                machineId={snapshot.host.machineId ?? null}
                parentLifetime={surfaceLifetime}
                transactionApplier={transactionApplier}
            />
        );
    }, [
        composerSurfaceCatalog,
        params.projectionInputs?.pluginProjectionV2,
        physicalTargetKey,
        surfaceLifetime,
        transactionApplier,
    ]);
    const renderAttachmentPickerSurface = React.useCallback((
        identity: PluginContributionIdentityV1,
        immutableGenerationId: string,
        instanceKey: string,
    ): React.ReactNode => {
        if (!params.attachmentsEnabled) return null;
        const snapshot = readComposerPresentationSnapshot(params.composer);
        if (!snapshot) return null;
        return renderComposerSurface({
            contribution: identity,
            immutableGenerationId,
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
        });
    }, [params.attachmentsEnabled, params.composer, renderComposerSurface]);
    const renderControlSurface = React.useCallback((presentation: PluginComposerControlSurfacePresentation): React.ReactNode => {
        if (presentation.kind === 'control') {
            const role: ComposerSurfaceRoleV1 = presentation.role === 'compact'
                ? 'controlCompact'
                : 'controlInteraction';
            return renderComposerSurface({
                contribution: presentation.control.identity,
                immutableGenerationId: presentation.control.immutableGenerationId,
                role,
                input: {
                    v: 1,
                    role,
                    composer: params.composer,
                    controlLocalId: presentation.control.identity.localId,
                    state: presentation.state,
                },
                instanceKey: `composer:${role}:${presentation.control.id}`,
            });
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
            attachment.immutableGenerationId,
            `composer:attachmentPicker:${attachment.id}`,
        );
    }, [
        params.attachmentsEnabled,
        params.composer,
        pluginProjection.composerAttachmentsById,
        renderAttachmentPickerSurface,
        renderComposerSurface,
    ]);
    const renderComposerRegion = React.useCallback((region: PluginProjectedComposerRegionEntryV1): React.ReactNode => {
        if (!region.immutableGenerationId) return null;
        return renderComposerSurface({
            contribution: region.identity,
            immutableGenerationId: region.immutableGenerationId,
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
        content: React.ReactNode;
    }>): void => {
        const lifetime = surfaceLifetime;
        if (!lifetime || !lifetime.isCurrent()) return;
        let modalId: string | null = null;
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
                children: input.content,
            },
            closeOnBackdrop: true,
            onRequestClose: () => retirement.dispose(),
            onHostUnmount: () => retirement.dispose(),
        });
        if (!modalId) {
            retirement.dispose();
            return;
        }
        if (retiredBeforeShow) Modal.hide(modalId);
    }, [surfaceLifetime]);
    const renderAttachmentPreviewSurface = React.useCallback((
        input: ComposerAttachmentPresentationRequest,
    ): React.ReactNode => {
        if (input.catalog.preview?.kind !== 'surface') return null;
        return renderComposerSurface({
            contribution: input.catalog.identity,
            immutableGenerationId: input.catalog.immutableGenerationId,
            role: 'attachmentPreview',
            input: {
                v: 1,
                role: 'attachmentPreview',
                composer: params.composer,
                attachmentLocalId: input.catalog.identity.localId,
                instance: input.attachment,
            },
            instanceKey: `composer:attachmentPreview:${input.attachment.instanceId}`,
        });
    }, [params.composer, renderComposerSurface]);
    const renderAttachmentSurface = React.useCallback((
        input: ComposerAttachmentPresentationRequest,
    ): ComposerAttachmentRowSurfacePresentation | undefined => {
        if (input.catalog.display?.kind !== 'surface') return undefined;
        const renderedContent = renderComposerSurface({
            contribution: input.catalog.identity,
            immutableGenerationId: input.catalog.immutableGenerationId,
            role: 'attachmentDisplay',
            input: {
                v: 1,
                role: 'attachmentDisplay',
                composer: params.composer,
                attachmentLocalId: input.catalog.identity.localId,
                instance: input.attachment,
            },
            instanceKey: `composer:attachmentDisplay:${input.attachment.instanceId}`,
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
                onPress: () => {
                    const content = renderAttachmentPreviewSurface(input);
                    if (content === null || content === undefined) return;
                    openSurfaceDialog({ title: input.attachment.presentation.label, content });
                },
            };
        }
        if (preview !== undefined || input.catalog.picker === undefined) return undefined;
        return {
            onPress: () => {
                const content = renderAttachmentPickerSurface(
                    input.catalog.identity,
                    input.catalog.immutableGenerationId,
                    `composer:attachmentPicker:${input.attachment.instanceId}`,
                );
                if (content === null || content === undefined) return;
                openSurfaceDialog({ title: input.attachment.presentation.label, content });
            },
        };
    }, [
        openSurfaceDialog,
        renderAttachmentPickerSurface,
        renderAttachmentPreviewSurface,
        surfaceLifetime,
    ]);
    const destinationNavigation = usePluginSurfaceDestinationNavigationBinding();
    const composerControlHost = React.useMemo<PluginComposerControlHost>(() => ({
        scope: params.composer.kind,
        isCurrent: () => surfaceLifetime?.isCurrent() === true,
        renderControlResourceState: ({ control, children }) => {
            const resource = control.definition.state?.resource;
            const snapshot = actionSnapshotRef.current;
            const accountLifetime = snapshot?.host.accountLifetime;
            const machineId = snapshot?.host.machineId;
            const expectedGeneration = snapshot?.host.expectedGeneration;
            if (
                !resource
                || !snapshot
                || !accountLifetime
                || !machineId
                || expectedGeneration === null
                || expectedGeneration === undefined
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
                        expectedGeneration: String(expectedGeneration),
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
                input: input ?? null,
                signal: scopeAbort.signal,
            }), { tag: 'ComposerScopePluginPresentation.openControlAction' });
        },
        applyComposer: ({ control, operations }) => {
            if (surfaceLifetime?.isCurrent() !== true) return;
            const snapshot = readComposerPresentationSnapshot(params.composer);
            if (!snapshot) return;
            transactionApplier.apply({
                ref: params.composer,
                admittedContributor: {
                    identity: control.identity,
                    immutableGenerationId: control.immutableGenerationId,
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
        openSurfaceDialog: (presentation) => {
            const content = renderControlSurface(presentation);
            if (content === null || content === undefined) return;
            openSurfaceDialog({
                title: presentation.state.label ?? (
                    typeof presentation.control.definition.label === 'string'
                        ? presentation.control.definition.label
                        : presentation.control.definition.label.fallback
                ),
                layout: presentation.layout,
                surfaceKey: `composer:${presentation.kind}:${presentation.control.id}:dialog`,
                accessibilityLabel: presentation.state.accessibilityLabel,
                content,
            });
        },
    }), [
        actionController,
        destinationNavigation,
        openSurfaceDialog,
        params.composer,
        params.onOpenControlAction,
        resourceContextKey,
        renderControlSurface,
        scopeAbort,
        surfaceLifetime,
        transactionApplier,
    ]);
    const openContributedAction = React.useCallback((action: PluginContributedActionDescriptor): void => {
        if (surfaceLifetime?.isCurrent() !== true) return;
        if (params.onOpenContributedAction) {
            params.onOpenContributedAction({ controller: actionController, action, signal: scopeAbort.signal });
            return;
        }
        fireAndForget(openPluginContributedAction({
            controller: actionController,
            action,
            signal: scopeAbort.signal,
        }), { tag: 'ComposerScopePluginPresentation.openContributedAction' });
    }, [actionController, params.onOpenContributedAction, scopeAbort, surfaceLifetime]);
    const extraActionChips = React.useMemo(() => {
        if (!actionSnapshot) return [];
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

    return React.useMemo(() => ({
        attachmentEntriesById,
        actionController,
        composerRegions,
        getCurrentActionSnapshot,
        scopeSignal: scopeAbort.signal,
        renderComposerRegion,
        extraActionChips,
        beforeComposer,
        afterComposer,
        renderAttachmentSurface,
        resolveAttachmentInteraction,
    }), [
        afterComposer,
        attachmentEntriesById,
        actionController,
        beforeComposer,
        composerRegions,
        extraActionChips,
        getCurrentActionSnapshot,
        renderAttachmentSurface,
        renderComposerRegion,
        resolveAttachmentInteraction,
        scopeAbort,
    ]);
}
