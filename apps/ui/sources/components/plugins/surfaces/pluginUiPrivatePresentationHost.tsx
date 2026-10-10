import * as React from 'react';
import { COMPANION_WEB_POINTER_BINDING } from '@/components/companion/interaction/useCompanionPointerDragSession';
import { NativeFloatingFrame } from '@/components/companion/interaction/NativeFloatingFrame';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol';
import type {
    PluginUiInstanceKeyV1,
    PluginUiJsonValueV1,
    PluginUiTargetedContributionSurfaceV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    AccessibilityInfo,
    findNodeHandle,
    Platform,
    StyleSheet,
    View,
    useWindowDimensions,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
    normalizeHappierCodeLanguage,
    resolveHappierDiffViewerRequest,
    type HappierDiffViewerRequest,
    type HappierImageSize,
    type HappierMaterialRole,
    type HappierSceneRenderRequest,
    type HappierSurfaceProps,
} from '@happier-dev/plugin-ui/presentation';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { QRCode } from '@/components/qr/QRCode';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { resolveInlineDiffVirtualizedViewportStyle } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedViewportStyle';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { Icon } from '@/components/ui/icons/Icon';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { VoiceMarkArt } from '@/components/voice/presence/VoiceMark';
import { SceneArt } from '@/components/ui/surfaces/SceneArt';
import { VoiceStatusCell } from '@/components/voice/presence/VoiceStatusCell';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';
import { SetupBlockGrid } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { PluginDictationButton } from './PluginDictationButton';
import type { DictationButtonProps, StatusCellProps, VoiceMarkArtProps, SetupBlockTileProps, SetupBlockGridProps } from '@happier-dev/plugin-ui';
import { SESSION_STORED_IMAGE_HOST } from '@/components/sessions/media/SessionMediaInlineImages';
import type {
    HappierAgentCursorMotionDriver,
    HappierCapsuleHost,
    HappierDisclosureMotionDriver,
} from '@happier-dev/plugin-ui/presentation';
import { reanimatedAgentCursorMotion } from '@/components/ui/motion/reanimatedAgentCursorMotion';
import { CORE_CAPSULE_HOST } from '@/components/ui/status/capsuleHost';
import { reanimatedDisclosureMotion } from '@/components/ui/lists/ExpandableItem';
import { reanimatedCollectionMotion } from '@/components/ui/motion/reanimatedCollectionMotion';
import { Popover } from '@/components/ui/popover/Popover';
import { renderThemeMaterialSurface } from '@/components/ui/glass/GlassSurface';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS } from '@/components/ui/popover/modalAwareFloatingPopoverPortalOptions';
import { Text } from '@/components/ui/text/Text';
import {
    resolvePluginUiIconName,
    type PluginUiIconDirection,
} from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { InstalledPluginBrandMark } from '@/components/plugins/shared/InstalledPluginBrandMark';
import type { HappierUiPalette } from '@happier-dev/plugin-ui/environment';
import type { PluginUiSessionPartPresentation, PluginUiWidgetAreaPresentation } from '@happier-dev/plugin-ui/advanced';
import type { FindSurfaceRegistrationHost } from '@happier-dev/plugin-ui/advanced';
import { createPluginUiPrivateFocusPresentation } from './pluginUiPrivateFocusPresentation';
import type { DragSourceProps, DropTargetProps, ItemProps, NavigationListDestination } from '@happier-dev/plugin-ui';
import type { HappierPageChrome, HappierStateSize, HappierLiveStreamProps } from '@happier-dev/plugin-ui/presentation';
import type { DetailsPaneSlotBinding } from '@/components/appShell/panes/details/DetailsPaneSlot';
import type { usePaneHeaderSlotBinding } from '@/components/appShell/panes/paneHeaderSlot';
import { readPluginUiHostTypography } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { useSetting } from '@/sync/domains/state/storage';
import { createScrollViewNearViewportTracker } from '@/components/widgets/nearViewport';
import type { PluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import {
    useInstalledPluginBrandPresentation,
    type InstalledPluginBrandPresentation,
    type InstalledPluginBrandPresentationInput,
} from '@/components/plugins/shared/installedPluginBrandPresentation';

type PluginUiPrivatePageChrome = HappierPageChrome & Readonly<{
    renderNavigationActions?: (actions: React.ReactNode) => React.ReactNode;
}>;

const MATCHING_PLUGIN_POPOVER_PORTAL_OPTIONS = Object.freeze({
    web: true,
    native: true,
    matchAnchorWidth: true,
    anchorAlign: 'start',
});

function resolvePluginUiPopoverPresentation(input: Readonly<{
    presentation?: 'popover' | 'menu' | 'dropdown' | 'context';
}>) {
    switch (input.presentation) {
        case 'menu':
        case 'context':
            // Match the incumbent ContextMenu disposition: readable rows stay
            // independent of a compact trigger, with the established 320px cap.
            return {
                portal: MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
                maxWidthCap: 320,
            } as const;
        case 'dropdown':
            // Preserve the existing DropdownMenu matching-width contract and cap.
            return {
                portal: MATCHING_PLUGIN_POPOVER_PORTAL_OPTIONS,
                maxWidthCap: 1024,
            } as const;
        case 'popover':
        default:
            return { portal: MATCHING_PLUGIN_POPOVER_PORTAL_OPTIONS } as const;
    }
}

export type PluginUiPresentationBrand = Readonly<{
    displayName: string;
    monochrome?: boolean;
    resource?: Readonly<{ pluginId: string; localId: string }>;
}>;

/** One exact package fact closed over by the app host, never published to an artifact. */
export type PluginUiPrivateBrandTarget = Readonly<{
    displayName: string;
    installedPackage: PluginProjectionInstalledPackageV2;
}>;

/**
 * The private bridge carries the exact public target surface identity to the one app
 * mount owner. It intentionally holds no selected renderer, artifact, origin,
 * controller, cache, or currentness state.
 */
export type PluginUiPrivateTargetedSurfacePresentation = Readonly<{
    surface: PluginUiTargetedContributionSurfaceV1;
    input: PluginUiJsonValueV1;
    instanceKey?: PluginUiInstanceKeyV1;
    fallback?: React.ReactNode;
}>;

type PluginUiPrivateBrandPresentationInput = Omit<InstalledPluginBrandPresentationInput, 'installedPackage'>;

export type PluginDestinationRowInput = NavigationListDestination & Readonly<{
    children: React.ReactNode;
    renderWithSecondaryActions?(actions: Readonly<{
        secondaryActions: NonNullable<ItemProps['secondaryActions']>;
        onSecondaryAction: NonNullable<ItemProps['onSecondaryAction']>;
    }>): React.ReactNode;
}>;

export type PluginUiPrivatePresentationHostOptions = Readonly<{
    renderDragSource?: (input: DragSourceProps) => React.ReactNode;
    renderDropTarget?: (input: DropTargetProps) => React.ReactNode;
    renderLiveStream?: NonNullable<PluginUiPrivatePresentationHost['renderLiveStream']>;
    renderDestinationRow?: (input: PluginDestinationRowInput) => React.ReactNode;
    /** Exact mounted direction for logical icon tokens. */
    direction?: PluginUiIconDirection;
    /** Exact-key lookup only; no enumeration, search, or caller-controlled Resource reference. */
    resolveBrandTarget?: (pluginId: string) => PluginUiPrivateBrandTarget | undefined;
    /** Localized host fallback for an absent exact target or unavailable optional mark. */
    fallbackBrandDisplayName?: string;
    /** Captured mount currentness for the incumbent installed-package brand resolver. */
    brandPresentationInput?: PluginUiPrivateBrandPresentationInput;
    /** The one target-local route through the incumbent physical surface host. */
    renderTargetedSurface?: (input: PluginUiPrivateTargetedSurfacePresentation) => React.ReactNode;
    /** A targeted child falls back locally rather than becoming another parent bridge. */
    targetedSurfaceUnavailableReason?: 'unsupported_nested_targeted_surface';
    /**
     * Renders plugin session parts through the app's one Session implementation. Installed only
     * for same-realm RN/RNW mounts; hosted-web and declarative adapters never receive it.
     */
    renderSessionPart?: (input: PluginUiSessionPartPresentation) => React.ReactNode;
    /**
     * Renders a page's declared widget area through the app's one area owner. Installed only for
     * same-realm RN/RNW mounts; declarative documents reach the same owner through their node.
     */
    renderWidgetArea?: (input: PluginUiWidgetAreaPresentation) => React.ReactNode;
    /**
     * The containing layout/route's current presentation fact. The physical
     * mount and availability are necessary but insufficient for focus.
     */
    isFocusEligible?: () => boolean;
    find?: FindSurfaceRegistrationHost;
    /** The host's configuration-page colour roles for the current theme (`projectPluginUiHostPalette`). */
    palette?: HappierUiPalette;
    resolveMaterialColor?: import('@happier-dev/plugin-ui/advanced').PluginUiPresentationHost['resolveMaterialColor'];
    /** The navigation chrome the mount sits in (title shown, back control, content column). */
    pageChrome?: PluginUiPrivatePageChrome;
    /** The container's state size (`SurfaceStateSizeProvider`): a plugin's unsized states take it. */
    stateSize?: HappierStateSize;
    /** The page's app details pane, when the mount sits in a page that has one (`DetailsPaneSlotHost`). */
    detailsPane?: DetailsPaneSlotBinding;
    /** The pane header of the tab the mount fills (the session sidebar, a phone surface), when it has one. */
    paneHeader?: NonNullable<ReturnType<typeof usePaneHeaderSlotBinding>>;
}>;

type PluginUiPrivateTargetBrandMarkInput = Readonly<{
    target: PluginUiPrivateBrandTarget | undefined;
    fallbackBrandDisplayName: string;
    brandPresentationInput?: PluginUiPrivateBrandPresentationInput;
    size?: HappierImageSize;
    pixelSize?: number;
    showName: boolean;
    externallyLabelled: boolean;
    testID?: string;
}>;

function renderPluginUiPrivateBrandMark(input: Readonly<{
    brand: InstalledPluginBrandPresentation;
    pluginId?: string;
    size?: HappierImageSize;
    pixelSize?: number;
    showName: boolean;
    externallyLabelled: boolean;
    testID?: string;
}>): React.ReactElement {
    const mark = (
        <InstalledPluginBrandMark
            brand={input.brand}
            pluginId={input.pluginId}
            size={input.size}
            pixelSize={input.pixelSize}
            externallyLabelled={input.showName || input.externallyLabelled}
            testID={input.showName && input.testID ? `${input.testID}-mark` : input.testID}
        />
    );
    if (!input.showName) return mark;
    return (
        <View testID={input.testID} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {mark}
            <Text>{input.brand.displayName}</Text>
        </View>
    );
}

function ResolvedPluginUiPrivateTargetBrandMark(props: PluginUiPrivateTargetBrandMarkInput & Readonly<{
    target: PluginUiPrivateBrandTarget;
    brandPresentationInput: PluginUiPrivateBrandPresentationInput;
}>): React.ReactElement {
    const resolved = useInstalledPluginBrandPresentation({
        ...props.brandPresentationInput,
        installedPackage: props.target.installedPackage,
    });
    return renderPluginUiPrivateBrandMark({
        brand: resolved ?? { displayName: props.target.displayName },
        pluginId: props.target.installedPackage.id,
        size: props.size,
        pixelSize: props.pixelSize,
        showName: props.showName,
        externallyLabelled: props.externallyLabelled,
        testID: props.testID,
    });
}

/**
 * The host-private target branch delegates byte acquisition to the incumbent
 * installed-package resolver. No target Resource, raw bytes, cache, or package
 * map becomes visible to the bundled plugin surface.
 */
function PluginUiPrivateTargetBrandMark(props: PluginUiPrivateTargetBrandMarkInput): React.ReactElement {
    if (props.target && props.brandPresentationInput) {
        return <ResolvedPluginUiPrivateTargetBrandMark {...props} target={props.target} brandPresentationInput={props.brandPresentationInput} />;
    }
    return renderPluginUiPrivateBrandMark({
        brand: { displayName: props.target?.displayName ?? props.fallbackBrandDisplayName },
        pluginId: props.target?.installedPackage.id,
        size: props.size,
        pixelSize: props.pixelSize,
        showName: props.showName,
        externallyLabelled: props.externallyLabelled,
        testID: props.testID,
    });
}

/**
 * Thin plugin-surface adapter over the incumbent app DiffViewer. It deliberately
 * owns no parser, cache, or review state: current user settings and the existing
 * inline virtualization policy remain the only decisions.
 */
function PluginUiPrivateDiffViewer(props: HappierDiffViewerRequest): React.ReactElement {
    const configuredWrapLines = useSetting('wrapLinesInDiffs');
    const configuredLineNumbers = useSetting('showLineNumbers');
    const thresholds = useInlineDiffVirtualizationThresholds();
    const { height: windowHeight } = useWindowDimensions();
    const virtualized = resolveInlineDiffVirtualization({
        unifiedDiff: props.unifiedDiff,
        oldText: null,
        newText: null,
        lineThreshold: thresholds.lineThreshold,
        byteThreshold: thresholds.byteThreshold,
    });

    return (
        <View style={virtualized
            ? resolveInlineDiffVirtualizedViewportStyle(resolveInlineDiffVirtualizedMaxHeight(windowHeight))
            : undefined}
        >
            <DiffViewer
                mode="unified"
                unifiedDiff={props.unifiedDiff}
                filePath={props.filePath}
                wrapLines={configuredWrapLines !== false}
                showLineNumbers={configuredLineNumbers !== false}
                virtualized={virtualized}
                testID={props.testID}
            />
        </View>
    );
}

/**
 * Thin plugin-surface adapter over the incumbent app QR renderer. Encoding,
 * error correction, quiet zone, theme colors, and the platform renderer
 * (Skia on native, SVG on web) stay with `@/components/qr`; the adapter owns
 * only the theme projection.
 */
function PluginUiPrivateQRCode(props: Readonly<{ data: string; size: number; testID?: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID} collapsable={false}>
            <QRCode
                data={props.data}
                size={props.size}
                foregroundColor={theme.colors.text.primary}
                backgroundColor={theme.colors.surface.base}
            />
        </View>
    );
}

function createPluginUiPrivatePresentationRenderers(direction?: PluginUiIconDirection) {
    return Object.freeze({
    renderVoiceMarkArt(input: Omit<VoiceMarkArtProps, 'fallback'>) {
        // Only explicit art props: no live energy acquisition or attempt data.
        return <VoiceMarkArt {...input} still={input.still ?? true} presentationOnly />;
    },
    renderScene(input: HappierSceneRenderRequest) {
        return <SceneArt {...input} />;
    },
    renderStatusCell(input: Omit<StatusCellProps, 'label' | 'fallback'> & Readonly<{ presented: boolean }>) {
        return <VoiceStatusCell {...input} />;
    },
    renderSetupBlockTile(input: Omit<SetupBlockTileProps, 'fallback'>) {
        const { icon, ...props } = input;
        return <SetupBlockTile {...props} icon={icon ? resolvePluginUiIconName(icon, direction) : undefined} />;
    },
    renderSetupBlockGrid(input: Omit<SetupBlockGridProps, 'fallback'>) {
        return <SetupBlockGrid {...input} />;
    },
    renderDictationButton(input: Omit<DictationButtonProps, 'fallback'> & Readonly<{ presented: boolean }>) {
        return <PluginDictationButton {...input} />;
    },
    storedImageHost: SESSION_STORED_IMAGE_HOST,
    renderMaterialSurface: renderThemeMaterialSurface,
    renderMarkdown(input: Readonly<{ value: string; selectable: boolean; testID?: string }>) {
        return <MarkdownView markdown={input.value} selectable={input.selectable} testID={input.testID} />;
    },
    renderCodeBlock(input: Readonly<{ code: string; language?: string; selectable: boolean; testID?: string }>) {
        return (
            <CodeBlockView
                code={input.code}
                language={normalizeHappierCodeLanguage(input.language) ?? null}
                selectable={input.selectable}
                showCopyButton={false}
                scrollTestID={input.testID}
            />
        );
    },
    renderDiffViewer(input: HappierDiffViewerRequest) {
        return <PluginUiPrivateDiffViewer {...resolveHappierDiffViewerRequest(input)} />;
    },
    renderPopover(input: Readonly<{
        open: boolean;
        anchorRef: React.RefObject<unknown>;
        followScrollRef?: React.RefObject<unknown>;
        focusReturnRef?: React.RefObject<unknown>;
        initialFocusRef?: React.RefObject<unknown>;
        placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
        presentation?: 'popover' | 'menu' | 'dropdown' | 'context';
        autoFocusOnOpen?: boolean;
        onRequestClose(): void;
        content(controls: Readonly<{
            requestClose(reason: 'selection' | 'escape'): void;
            maxHeight: number;
        }>): React.ReactNode;
    }>) {
        const presentation = resolvePluginUiPopoverPresentation(input);
        return (
            <Popover
                open={input.open}
                anchorRef={input.anchorRef as React.RefObject<any>}
                followScrollRef={input.followScrollRef as React.RefObject<any> | undefined}
                focusReturnRef={input.focusReturnRef as React.RefObject<any> | undefined}
                initialFocusRef={input.initialFocusRef as React.RefObject<any> | undefined}
                placement={input.placement ?? 'auto'}
                autoFocusOnOpen={input.autoFocusOnOpen === true}
                // Portal target selection stays inside the incumbent Popover
                // owner, including its modal-aware web target and native host.
                portal={presentation.portal}
                maxWidthCap={presentation.maxWidthCap}
                onRequestClose={input.onRequestClose}
            >
                {(render) => input.content({ requestClose: render.requestClose, maxHeight: render.maxHeight })}
            </Popover>
        );
    },
    renderIcon(input: Readonly<{
        name: string;
        size: number;
        color?: string;
        accessibilityLabel?: string;
        testID?: string;
    }>) {
        return (
            <Icon
                name={resolvePluginUiIconName(input.name, direction)}
                size={input.size}
                color={input.color}
                accessibilityLabel={input.accessibilityLabel}
                testID={input.testID}
            />
        );
    },
    renderQRCode(input: Readonly<{ data: string; size: number; testID?: string }>) {
        return <PluginUiPrivateQRCode data={input.data} size={input.size} testID={input.testID} />;
    },
    /** A person's mark through the one avatar owner: the generated mark with its monogram, by name. */
    renderAvatar(input: Readonly<{ name: string; size: number; testID?: string }>) {
        return <Avatar id={input.name} title size={input.size} accessibilityLabel={input.name} testID={input.testID} />;
    },
    });
}

const PLUGIN_UI_PRIVATE_PRESENTATION_RENDERERS = createPluginUiPrivatePresentationRenderers();

export type PluginUiPrivatePresentationHost = Readonly<
    typeof PLUGIN_UI_PRIVATE_PRESENTATION_RENDERERS & {
        createScrollActivityTracker(scrollRef: React.RefObject<unknown>, horizontal: boolean): PluginUiScrollActivityTracker;
        /** The host's real type-role styles for same-realm plugin text. */
        typography: ReturnType<typeof readPluginUiHostTypography>;
        /** The host's configuration-page colour roles, when the mount supplies its theme. */
        palette?: HappierUiPalette;
        find?: FindSurfaceRegistrationHost;
        pageChrome?: PluginUiPrivatePageChrome;
        stateSize?: HappierStateSize;
        detailsPane?: DetailsPaneSlotBinding;
        paneHeader?: NonNullable<ReturnType<typeof usePaneHeaderSlotBinding>>;
        renderDestinationRow?: (input: PluginDestinationRowInput) => React.ReactNode;
        renderDragSource?: (input: DragSourceProps) => React.ReactNode;
        renderDropTarget?: (input: DropTargetProps) => React.ReactNode;
        renderLiveStream?: (input: HappierLiveStreamProps) => React.ReactNode;
        /** The Collection transition and peek motion, from the app's motion tokens. */
        collectionMotion: typeof reanimatedCollectionMotion;
        disclosureMotion: HappierDisclosureMotionDriver;
        /** The floating capsules' leaves and the agent cursor's motion: a plugin's capsule is the app's. */
        capsuleHost: HappierCapsuleHost;
        agentCursorMotion: HappierAgentCursorMotionDriver;
        brand?: PluginUiPresentationBrand;
        /** Private exact target lookup; intentionally not part of RenderContext or HostApi. */
        resolveBrandDisplayName?(pluginId: string): string | undefined;
        /** Private exact target renderer; Resource scope remains inside this app host. */
        renderBrandMark?(input: Readonly<{
            pluginId: string;
            size?: HappierImageSize;
            pixelSize?: number;
            showName?: boolean;
            externallyLabelled?: boolean;
            testID?: string;
        }>): React.ReactElement | undefined;
        /** Private target-local composition bridge; never exposed through RenderContext. */
        renderTargetedSurface?(input: PluginUiPrivateTargetedSurfacePresentation): React.ReactNode;
        /** Private reason for a deliberate local targeted-surface fallback. */
        targetedSurfaceUnavailableReason?: 'unsupported_nested_targeted_surface';
        /** Private Session part renderer; the app's one Session implementation draws every part. */
        renderSessionPart?(input: PluginUiSessionPartPresentation): React.ReactNode;
        /** Private widget area renderer; the app's one widget area owner draws everything inside. */
        renderWidgetArea?(input: PluginUiWidgetAreaPresentation): React.ReactNode;
        /** Private physical focus transfer; never part of RenderContext or Host API. */
        focusTarget?(target: unknown): boolean;
    }
>;


type FocusablePresentationTarget = Readonly<{
    focus?: (options?: Readonly<{ preventScroll?: boolean }>) => void;
}>;

function focusPluginUiPrivatePresentationTarget(target: unknown): boolean {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) return false;
    const focus = (target as FocusablePresentationTarget).focus;
    if (typeof focus !== 'function') return false;

    if (Platform.OS === 'web') {
        try {
            focus.call(target, { preventScroll: true });
        } catch {
            try {
                focus.call(target);
            } catch {
                return false;
            }
        }
        // HTMLElement.focus() is allowed to return without throwing when the
        // browser refuses the transfer (for example, a retained subtree hidden
        // with display:none). Only DOM targets have an observable acceptance
        // signal; host/test focusables that are not Nodes keep the structural
        // success contract above.
        if (typeof document !== 'undefined'
            && typeof Node !== 'undefined'
            && target instanceof Node) {
            const activeElement = document.activeElement;
            const accepted = activeElement === target
                || (typeof Element !== 'undefined'
                    && target instanceof Element
                    && activeElement !== null
                    && target.contains(activeElement));
            if (!accepted) return false;
        }
    } else {
        try {
            focus.call(target);
        } catch {
            return false;
        }
    }

    if (Platform.OS !== 'web') {
        try {
            const node = findNodeHandle(target as never);
            if (typeof node === 'number') {
                AccessibilityInfo.setAccessibilityFocus(node);
            }
        } catch {
            // Physical focus already succeeded. A non-native test double or a
            // platform handle that cannot be resolved must not turn that into
            // a second public failure channel.
        }
    }
    return true;
}

/**
 * Build the host-only presentation bindings for one mounted artifact entry.
 *
 * These values are applied to the entry provider only after arbitrary plugin
 * `renderSurface` code returns. They must never be attached to `RenderContext`:
 * an unwrapped raw export is still allowed to render, but is not a portal or
 * renderer owner.
 */
export function createPluginUiPrivatePresentationHost(
    brand: PluginUiPresentationBrand | undefined,
    options?: PluginUiPrivatePresentationHostOptions,
): PluginUiPrivatePresentationHost {
    const presentationRenderers = options?.direction === undefined
        ? PLUGIN_UI_PRIVATE_PRESENTATION_RENDERERS
        : createPluginUiPrivatePresentationRenderers(options.direction);
    const fallbackBrandDisplayName = options?.fallbackBrandDisplayName?.trim();
    const resolveBrandTarget = options?.resolveBrandTarget;
    const targetBrandPresentation = fallbackBrandDisplayName && resolveBrandTarget
        ? {
            resolveBrandDisplayName(pluginId: string): string {
                const normalizedPluginId = pluginId.trim();
                return normalizedPluginId
                    ? resolveBrandTarget(normalizedPluginId)?.displayName ?? fallbackBrandDisplayName
                    : fallbackBrandDisplayName;
            },
            renderBrandMark(input: Readonly<{
                pluginId: string;
                size?: HappierImageSize;
                pixelSize?: number;
                showName?: boolean;
                externallyLabelled?: boolean;
                testID?: string;
            }>): React.ReactElement {
                const normalizedPluginId = input.pluginId.trim();
                const target = normalizedPluginId ? resolveBrandTarget(normalizedPluginId) : undefined;
                return (
                    <PluginUiPrivateTargetBrandMark
                        target={target}
                        fallbackBrandDisplayName={fallbackBrandDisplayName}
                        {...(options?.brandPresentationInput === undefined
                            ? {}
                            : { brandPresentationInput: options.brandPresentationInput })}
                        size={input.size}
                        pixelSize={input.pixelSize}
                        showName={input.showName === true}
                        externallyLabelled={input.externallyLabelled === true}
                        testID={input.testID}
                    />
                );
            },
        }
        : undefined;
    const focusPresentation = createPluginUiPrivateFocusPresentation({
        isFocusEligible: options?.isFocusEligible,
        focusTarget: focusPluginUiPrivatePresentationTarget,
        find: options?.find,
    });
    return Object.freeze({
        ...presentationRenderers,
        createScrollActivityTracker: createScrollViewNearViewportTracker,
        ...(options?.renderDragSource === undefined ? {} : { renderDragSource: options.renderDragSource }),
        ...(options?.renderDropTarget === undefined ? {} : { renderDropTarget: options.renderDropTarget }),
        ...(options?.renderLiveStream ? { renderLiveStream: options.renderLiveStream } : {}),
        typography: readPluginUiHostTypography(),
        ...(options?.palette === undefined ? {} : { palette: options.palette }),
        ...(options?.resolveMaterialColor === undefined ? {} : { resolveMaterialColor: options.resolveMaterialColor }),
        ...(options?.pageChrome === undefined ? {} : { pageChrome: options.pageChrome }),
        ...(options?.stateSize === undefined ? {} : { stateSize: options.stateSize }),
        ...(options?.detailsPane === undefined ? {} : { detailsPane: options.detailsPane }),
        ...(options?.paneHeader === undefined ? {} : { paneHeader: options.paneHeader }),
        ...(options?.renderDestinationRow === undefined ? {} : { renderDestinationRow: options.renderDestinationRow }),
        // The same-realm motion drivers for the Collection's transition and its peek disclosure.
        collectionMotion: reanimatedCollectionMotion,
        // Widened to the contract's driver type: the Disclosure hands `Body` only the motion its own
        // `useMotion` created, so the Reanimated pair stays consistent.
        disclosureMotion: reanimatedDisclosureMotion as unknown as HappierDisclosureMotionDriver,
        capsuleHost: CORE_CAPSULE_HOST,
        // A public FloatingFrame drags through the same web pointer boundary as Happier's companions.
        ...(Platform.OS === 'web' ? { companionPointer: COMPANION_WEB_POINTER_BINDING } : {}),
        ...(Platform.OS !== 'web' ? { companionNativeFrame: NativeFloatingFrame } : {}),
        // Widened like the disclosure: the cursor hands `Pointer`/`Ring` only the motion its own
        // `useMotion` created.
        agentCursorMotion: reanimatedAgentCursorMotion as unknown as HappierAgentCursorMotionDriver,
        ...(brand ? { brand } : {}),
        ...(targetBrandPresentation ?? {}),
        ...(focusPresentation ?? {}),
        ...(options?.renderTargetedSurface === undefined
            ? {}
            : { renderTargetedSurface: options.renderTargetedSurface }),
        ...(options?.targetedSurfaceUnavailableReason === undefined
            ? {}
            : { targetedSurfaceUnavailableReason: options.targetedSurfaceUnavailableReason }),
        ...(options?.renderSessionPart === undefined
            ? {}
            : { renderSessionPart: options.renderSessionPart }),
        ...(options?.renderWidgetArea === undefined
            ? {}
            : { renderWidgetArea: options.renderWidgetArea }),
    });
}
