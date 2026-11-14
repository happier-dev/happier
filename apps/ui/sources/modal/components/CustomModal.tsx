import React from 'react';
import { BaseModal } from './BaseModal';
import { RetainedModalFrame } from './RetainedModalFrame';
import {
    CustomModalConfig,
    type CustomModalChromeCardConfig,
    type CustomModalChromeConfig,
    type CustomModalDismissReason,
} from '../types';
import { ModalCardFrame } from './card/ModalCardFrame';
import { useModalCardDimensions } from './card/useModalCardDimensions';
import { Popover } from '@/components/ui/popover/Popover';
import { POPOVER_PREFERRED_ROOM_PX } from '@/components/ui/popover/popoverPreferredRoom';
import type { PopoverAnchor } from '@/components/ui/popover/_types';
import { useDeviceType } from '@/utils/platform/responsive';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { areChromeConfigsEqual, mergeChromeConfig, resolveCustomModalPresentation } from './customModalChrome';
import { ModalCommands } from './ModalCommands';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { t } from '@/text';
import { MODAL_Z_INDEX } from '@/components/ui/overlays/overlayLayers';
import { ModalLayerZIndexProvider } from '@/modal/portal/ModalPortalTarget';

interface CustomModalProps {
    config: CustomModalConfig;
    onClose: () => void;
    showBackdrop?: boolean;
    visible: boolean;
    zIndexBase?: number;
}

function isPromiseLikeDismissDecision(value: unknown): value is PromiseLike<boolean | void> {
    return typeof value === 'object'
        && value !== null
        && 'then' in value
        && typeof value.then === 'function';
}


export function CustomModal({ config, onClose, showBackdrop = true, visible, zIndexBase }: CustomModalProps) {
    const Component = config.component;
    const dismissible = config.dismissible !== false;
    const dismissalPendingRef = React.useRef(false);
    const [chromeOverride, setChromeOverride] = React.useState<CustomModalChromeConfig | null | undefined>(undefined);
    const effectiveChrome = chromeOverride === undefined ? config.chrome : chromeOverride;
    const deviceType = useDeviceType();
    const presentation = resolveCustomModalPresentation(effectiveChrome, deviceType, config.phonePresentation);
    const chrome = presentation.card;
    const insets = useChromeSafeAreaInsets();
    const accessibilityLabel = config.accessibilityLabel
        ?? (typeof effectiveChrome?.title === 'string' ? effectiveChrome.title : undefined);

    const completeDismiss = React.useCallback((notifyRequestClose: boolean) => {
        if (notifyRequestClose) {
            try {
                config.onRequestClose?.();
            } catch {
                // A legacy dismissal observer cannot prevent closure.
            }
        }
        onClose();
    }, [config.onRequestClose, onClose]);

    const requestDismiss = React.useCallback((reason: CustomModalDismissReason, notifyRequestClose: boolean) => {
        const dismissalGuard = config.onDismissRequest;
        if (!dismissalGuard) {
            completeDismiss(notifyRequestClose);
            return true;
        }
        if (dismissalPendingRef.current) {
            return false;
        }

        let decision: boolean | void | PromiseLike<boolean | void>;
        try {
            decision = dismissalGuard(reason);
        } catch {
            // A guard error leaves the modal open.
            return false;
        }

        if (!isPromiseLikeDismissDecision(decision)) {
            if (decision !== false) {
                completeDismiss(notifyRequestClose);
                return true;
            }
            return false;
        }

        dismissalPendingRef.current = true;
        return Promise.resolve(decision)
            .then((allowed) => {
                if (allowed !== false) {
                    completeDismiss(notifyRequestClose);
                    return true;
                }
                return false;
            })
            .catch(() => {
                // A rejected guard leaves the modal open without an unhandled rejection.
                return false;
            })
            .finally(() => {
                dismissalPendingRef.current = false;
            });
    }, [completeDismiss, config.onDismissRequest]);

    const handleSharedDismiss = React.useCallback(() => {
        if (!dismissible) {
            return false;
        }
        return requestDismiss('shared', true);
    }, [dismissible, requestDismiss]);

    const handleComponentClose = React.useCallback(() => {
        requestDismiss('action', dismissible);
    }, [dismissible, requestDismiss]);

    const setChrome = React.useCallback((nextChrome: CustomModalChromeConfig | null) => {
        // Null retires the content's own override: the card returns to the chrome it was opened with (its title,
        // size and presentation), so a step that cleans up on unmount never leaves the next step an untitled card.
        if (nextChrome === null) {
            setChromeOverride(undefined);
            return;
        }
        setChromeOverride((prevOverride) => {
            const prevEffective = prevOverride === undefined ? (config.chrome ?? null) : prevOverride;
            const nextEffective = mergeChromeConfig(prevEffective, nextChrome);
            if (areChromeConfigsEqual(prevEffective, nextEffective)) {
                return prevOverride;
            }
            return nextEffective;
        });
    }, [config.chrome]);

    // Card chrome is derived from the modal content's own render output, so applying it must not
    // feed back into that render. Holding the content element identity stable lets React skip the
    // content subtree whenever only chrome state changed; without that, a consumer whose chrome
    // dependencies are not referentially stable republishes on every applied chrome and the
    // publish cycle never closes.
    // A dialog has no navigation chrome: a page shown in it keeps its own title and actions rather than
    // publishing them to the route behind the scrim, where nobody can reach them.
    const content = React.useMemo(() => (
        <NavigationTitleChromeProvider showsTitle={false}>
            <Component {...config.props} onClose={handleComponentClose} setChrome={setChrome} />
        </NavigationTitleChromeProvider>
    ), [Component, config.props, handleComponentClose, setChrome]);

    const { phoneSheet, phoneFullscreen } = presentation;
    // A card hung from its trigger closes like every popover (outside press, Escape, its own Done), so it draws no ×.
    const renderModal = (sharedDismiss: () => void) => {
        const frame = (style?: React.ComponentProps<typeof ModalCardFrame>['style'], closeButton = true) => <ModalCardFrame
            framed={chrome !== null}
            material={chrome?.material}
            header={chrome?.header}
            headerInset={chrome?.headerInset}
            leading={chrome?.leading}
            leadingPlacement={chrome?.leadingPlacement}
            title={chrome?.title}
            subtitle={chrome?.subtitle}
            subtitleLines={chrome?.subtitleLines}
            actions={chrome?.actions}
            footer={chrome?.footer}
            testID={chrome?.testID}
            titleTestID={chrome?.titleTestID}
            subtitleTestID={chrome?.subtitleTestID}
            closeButtonTestID={chrome?.closeButtonTestID}
            scrollHost={chrome?.scrollHost}
            bodyScroll={chrome?.bodyScroll ?? 'none'}
            dimensions={chrome?.dimensions}
            presentation={phoneFullscreen ? 'fullscreen' : phoneSheet ? 'sheet' : 'card'}
            safeAreaInsets={phoneFullscreen ? insets : undefined}
            sheetBottomInset={phoneSheet ? insets.bottom : undefined}
            onClose={chrome && dismissible && closeButton ? sharedDismiss : undefined}
            style={style}
        >
            {content}
        </ModalCardFrame>;
        return <RetainedModalFrame frame={frame}>{retainedFrame => {
            if (presentation.anchor) {
                return <AnchoredModalCard anchor={presentation.anchor} visible={visible} accessibilityLabel={accessibilityLabel} zIndexBase={zIndexBase ?? MODAL_Z_INDEX}
                    dimensions={chrome?.dimensions} picker={presentation.card?.anchorRole === 'picker'} focusReturnRef={config.focusReturnRef} onRequestClose={sharedDismiss} frame={retainedFrame} />;
            }
            return (
                <BaseModal
                    visible={visible}
                    onClose={sharedDismiss}
                    accessibilityLabel={accessibilityLabel}
                    testID={effectiveChrome?.kind === 'stage' ? effectiveChrome.testID : undefined}
                    focusReturnRef={config.focusReturnRef}
                    // A captured opener can vanish as it opens the modal (a menu or picker row); return to the control
                    // that held focus when the modal activated instead of the page.
                    focusReturnFallback={effectiveChrome ? 'activation-time' : undefined}
                    closeOnBackdrop={config.closeOnBackdrop ?? true}
                    showBackdrop={showBackdrop && presentation.showBackdrop}
                    motion={presentation.motion}
                    zIndexBase={zIndexBase}
                    webPortalTarget={config.webPortalTarget ?? null}
                    webPlacement={config.webPlacement}
                    placement={presentation.placement}
                    scrollHost={presentation.scrollHost}
                >
                    {effectiveChrome?.kind === 'stage' ? content : retainedFrame()}
                </BaseModal>
            );
        }}</RetainedModalFrame>;
    };
    return <ModalCommands bridge={config.commandBridge} commands={dismissible
        ? [{ key: 'close', title: t('common.close'), invoke: handleSharedDismiss }] : []}>
        {invoke => renderModal(() => { void invoke('close'); })}
    </ModalCommands>;
}

/** The window gap an anchored card keeps, as the other anchored panels do. */
const ANCHORED_CARD_EDGE_PADDING_PX = 8;

/**
 * The same card, hung from the control that opened it (a Share button, a ⋯): it opens below that control,
 * flips above when the room is there, and stays inside the window. No scrim; an outside press, Escape or its
 * own close dismiss it through the shared handler, and focus returns to the trigger.
 */
function AnchoredModalCard(props: Readonly<{
    anchor: PopoverAnchor;
    visible: boolean;
    accessibilityLabel: string | undefined;
    dimensions: CustomModalChromeCardConfig['dimensions'];
    /** A value picker (`anchorRole: 'picker'`): it takes the room on its field's side instead of sliding over it. */
    picker: boolean;
    focusReturnRef: CustomModalConfig['focusReturnRef'];
    onRequestClose: () => void;
    /** Its place in the dialog stack: a card opened from inside another dialog lays out above that dialog. */
    zIndexBase: number;
    frame: (style: React.ComponentProps<typeof ModalCardFrame>['style'], closeButton: boolean) => React.ReactElement;
}>) {
    // The card's own bound (its width and its height ceiling) is the popover's cap, so it reads at the size it has as a dialog.
    const dimensions = useModalCardDimensions(props.dimensions);
    return <ModalLayerZIndexProvider layerZIndex={props.zIndexBase}><Popover
        open={props.visible}
        anchor={props.anchor}
        accessibilityLabel={props.accessibilityLabel}
        focusReturnRef={props.focusReturnRef ?? undefined}
        autoFocusOnOpen
        placement="bottom"
        placementMinSpace={POPOVER_PREFERRED_ROOM_PX}
        // A designed card keeps its size: it opens below its control, above it when only that side holds it, and
        // otherwise slides inside the window rather than cramping into the leftover room and hiding its actions.
        // A picker is a list with nothing below it to hide: it takes the room on its field's side and scrolls there.
        fit={props.picker ? 'shrink' : 'shift'}
        maxHeightCap={dimensions.maxHeight}
        maxWidthCap={dimensions.width + 2 * ANCHORED_CARD_EDGE_PADDING_PX}
        edgePadding={ANCHORED_CARD_EDGE_PADDING_PX}
        // Opens toward the open side: a trigger on the left (a rail's "+") never hangs the card over the sidebar.
        // A dialog mounts on the body, as every modal does (`resolveModalWebPortalTarget`), never in a screen's popover
        // host: there its layer is the dialog stack's, so a card opened from inside another dialog stacks above it.
        portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'auto' }}
        onRequestClose={props.onRequestClose}
    >
        {({ maxHeight, maxWidth }) => (
            // What the card opens (a dropdown, a menu) stacks above the card itself.
            <ModalLayerZIndexProvider layerZIndex={props.zIndexBase + 1}>
                {props.frame({ maxHeight, width: Math.min(dimensions.width, maxWidth), maxWidth }, false)}
            </ModalLayerZIndexProvider>
        )}
    </Popover></ModalLayerZIndexProvider>;
}
