import * as React from 'react';
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
    View,
    useWindowDimensions,
} from 'react-native';

import {
    normalizeHappierCodeLanguage,
    resolveHappierDiffViewerRequest,
    type HappierDiffViewerRequest,
    type HappierImageSize,
} from '@happier-dev/plugin-ui/presentation';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { resolveInlineDiffVirtualizedViewportStyle } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedViewportStyle';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { Icon } from '@/components/ui/icons/Icon';
import { Popover } from '@/components/ui/popover/Popover';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS } from '@/components/ui/popover/modalAwareFloatingPopoverPortalOptions';
import { Text } from '@/components/ui/text/Text';
import {
    resolvePluginUiIconName,
    type PluginUiIconDirection,
} from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { InstalledPluginBrandMark } from '@/components/plugins/shared/InstalledPluginBrandMark';
import { useSetting } from '@/sync/domains/state/storage';
import {
    useInstalledPluginBrandPresentation,
    type InstalledPluginBrandPresentation,
    type InstalledPluginBrandPresentationInput,
} from '@/components/plugins/shared/installedPluginBrandPresentation';

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

export type PluginUiPrivatePresentationHostOptions = Readonly<{
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
     * The containing layout/route's current presentation fact. The physical
     * mount and availability are necessary but insufficient for focus.
     */
    isFocusEligible?: () => boolean;
}>;

type PluginUiPrivateTargetBrandMarkInput = Readonly<{
    target: PluginUiPrivateBrandTarget | undefined;
    fallbackBrandDisplayName: string;
    brandPresentationInput?: PluginUiPrivateBrandPresentationInput;
    size?: HappierImageSize;
    showName: boolean;
    externallyLabelled: boolean;
    testID?: string;
}>;

function renderPluginUiPrivateBrandMark(input: Readonly<{
    brand: InstalledPluginBrandPresentation;
    size?: HappierImageSize;
    showName: boolean;
    externallyLabelled: boolean;
    testID?: string;
}>): React.ReactElement {
    const mark = (
        <InstalledPluginBrandMark
            brand={input.brand}
            size={input.size}
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
        size: props.size,
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
        size: props.size,
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

function createPluginUiPrivatePresentationRenderers(direction?: PluginUiIconDirection) {
    return Object.freeze({
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
    });
}

const PLUGIN_UI_PRIVATE_PRESENTATION_RENDERERS = createPluginUiPrivatePresentationRenderers();

export type PluginUiPrivatePresentationHost = Readonly<
    typeof PLUGIN_UI_PRIVATE_PRESENTATION_RENDERERS & {
        brand?: PluginUiPresentationBrand;
        /** Private exact target lookup; intentionally not part of RenderContext or HostApi. */
        resolveBrandDisplayName?(pluginId: string): string | undefined;
        /** Private exact target renderer; Resource scope remains inside this app host. */
        renderBrandMark?(input: Readonly<{
            pluginId: string;
            size?: HappierImageSize;
            showName?: boolean;
            externallyLabelled?: boolean;
            testID?: string;
        }>): React.ReactElement | undefined;
        /** Private target-local composition bridge; never exposed through RenderContext. */
        renderTargetedSurface?(input: PluginUiPrivateTargetedSurfacePresentation): React.ReactNode;
        /** Private reason for a deliberate local targeted-surface fallback. */
        targetedSurfaceUnavailableReason?: 'unsupported_nested_targeted_surface';
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
                        showName={input.showName === true}
                        externallyLabelled={input.externallyLabelled === true}
                        testID={input.testID}
                    />
                );
            },
        }
        : undefined;
    const focusPresentation = options?.isFocusEligible
        ? {
            focusTarget(target: unknown): boolean {
                return options.isFocusEligible?.() === true
                    && focusPluginUiPrivatePresentationTarget(target);
            },
        }
        : undefined;
    return Object.freeze({
        ...presentationRenderers,
        ...(brand ? { brand } : {}),
        ...(targetBrandPresentation ?? {}),
        ...(focusPresentation ?? {}),
        ...(options?.renderTargetedSurface === undefined
            ? {}
            : { renderTargetedSurface: options.renderTargetedSurface }),
        ...(options?.targetedSurfaceUnavailableReason === undefined
            ? {}
            : { targetedSurfaceUnavailableReason: options.targetedSurfaceUnavailableReason }),
    });
}
