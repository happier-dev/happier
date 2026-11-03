import type { PopoverAnchor } from '@/components/ui/popover/_types';
import type { CustomModalChromeCardConfig, CustomModalChromeConfig } from '../types';

function areViewportMarginsEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    if (typeof a === 'number' || typeof b === 'number') {
        return typeof a === 'number' && typeof b === 'number' && a === b;
    }
    if (typeof a !== 'object' || typeof b !== 'object') return false;

    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    return aRecord.horizontal === bRecord.horizontal
        && aRecord.vertical === bRecord.vertical;
}

function areDimensionOptionsEqual(
    a: Record<string, unknown> | null | undefined,
    b: Record<string, unknown> | null | undefined,
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.size === b.size
        && a.width === b.width
        && a.maxHeightRatio === b.maxHeightRatio
        && areViewportMarginsEqual(a.viewportMargin, b.viewportMargin);
}

export function areChromeConfigsEqual(
    a: CustomModalChromeConfig | null | undefined,
    b: CustomModalChromeConfig | null,
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'stage' && b.kind === 'stage') return a.testID === b.testID && a.title === b.title;

    if (a.kind === 'card' && b.kind === 'card') {
        return a.header === b.header
            && a.headerInset === b.headerInset
            && a.material === b.material
            && a.title === b.title
            && a.subtitle === b.subtitle
            && a.subtitleLines === b.subtitleLines
            && a.leading === b.leading
            && a.actions === b.actions
            && a.footer === b.footer
            && a.testID === b.testID
            && a.titleTestID === b.titleTestID
            && a.subtitleTestID === b.subtitleTestID
            && a.closeButtonTestID === b.closeButtonTestID
            && a.scrollHost === b.scrollHost
            && a.bodyScroll === b.bodyScroll
            && a.phonePresentation === b.phonePresentation
            && a.anchor === b.anchor
            && areDimensionOptionsEqual(
                (a.dimensions ?? null) as Record<string, unknown> | null,
                (b.dimensions ?? null) as Record<string, unknown> | null,
            );
    }

    return false;
}

export function mergeChromeConfig(
    base: CustomModalChromeConfig | null | undefined,
    override: CustomModalChromeConfig | null | undefined,
): CustomModalChromeConfig | null {
    if (override === undefined) return base ?? null;
    if (override === null) return null;
    if (!base) return override;
    if (base.kind === 'stage' && override.kind === 'stage') {
        return { kind: 'stage', testID: override.testID ?? base.testID, title: override.title ?? base.title };
    }

    if (base.kind === 'card' && override.kind === 'card') {
        const mergedDimensions = (() => {
            if (override.dimensions === undefined) return base.dimensions;
            if (base.dimensions == null) return override.dimensions;
            return {
                ...base.dimensions,
                ...override.dimensions,
            };
        })();

        return {
            kind: 'card',
            material: override.material !== undefined ? override.material : base.material,
            header: override.header !== undefined ? override.header : base.header,
            headerInset: override.headerInset !== undefined ? override.headerInset : base.headerInset,
            leading: override.leading !== undefined ? override.leading : base.leading,
            title: override.title !== undefined ? override.title : base.title,
            subtitle: override.subtitle !== undefined ? override.subtitle : base.subtitle,
            subtitleLines: override.subtitleLines !== undefined ? override.subtitleLines : base.subtitleLines,
            actions: override.actions !== undefined ? override.actions : base.actions,
            footer: override.footer !== undefined ? override.footer : base.footer,
            testID: override.testID !== undefined ? override.testID : base.testID,
            titleTestID: override.titleTestID !== undefined ? override.titleTestID : base.titleTestID,
            subtitleTestID: override.subtitleTestID !== undefined ? override.subtitleTestID : base.subtitleTestID,
            closeButtonTestID: override.closeButtonTestID !== undefined ? override.closeButtonTestID : base.closeButtonTestID,
            scrollHost: override.scrollHost !== undefined ? override.scrollHost : base.scrollHost,
            bodyScroll: override.bodyScroll !== undefined ? override.bodyScroll : base.bodyScroll,
            phonePresentation: override.phonePresentation !== undefined ? override.phonePresentation : base.phonePresentation,
            anchor: override.anchor !== undefined ? override.anchor : base.anchor,
            dimensions: mergedDimensions,
        };
    }

    return override;
}

/** Modal-owned chrome decisions, independent of the content's render lifecycle. */
export function resolveCustomModalPresentation(chrome: CustomModalChromeConfig | null | undefined, deviceType: 'phone' | 'tablet'): Readonly<{
    card: CustomModalChromeCardConfig | null;
    /** The trigger the card hangs from as an anchored popover; null when it is a centred dialog or a phone sheet. */
    anchor: PopoverAnchor | null;
    phoneSheet: boolean;
    phoneFullscreen: boolean;
    placement: 'fullscreen' | 'bottom' | 'center';
    scrollHost: 'body' | 'overlay';
    showBackdrop: boolean;
    motion: 'none' | undefined;
}> {
    const stage = chrome?.kind === 'stage';
    const card = chrome?.kind === 'card' ? chrome : null;
    const phoneSheet = card?.phonePresentation === 'sheet' && deviceType === 'phone';
    const phoneFullscreen = card?.phonePresentation === 'fullscreen' && deviceType === 'phone';
    const anchor = card?.anchor;
    const trigger = anchor?.kind === 'view' ? anchor.ref.current : null;
    // A card can outlive the menu or control that opened it. A missing or removed trigger
    // uses the same centred presentation as a programmatic open.
    const missingTrigger = anchor?.kind === 'view'
        && (trigger == null || ('isConnected' in trigger && trigger.isConnected === false));
    return {
        card, phoneSheet, phoneFullscreen,
        anchor: anchor && !missingTrigger && deviceType !== 'phone' ? anchor : null,
        placement: stage || phoneFullscreen ? 'fullscreen' as const : phoneSheet ? 'bottom' as const : 'center' as const,
        scrollHost: stage || card?.scrollHost === 'bounded' ? 'body' as const : card?.scrollHost ?? 'overlay',
        showBackdrop: !stage,
        motion: stage ? 'none' as const : undefined,
    };
}
