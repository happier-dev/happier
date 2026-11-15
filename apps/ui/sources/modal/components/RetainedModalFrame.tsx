import * as React from 'react';
import { Platform } from 'react-native';
import { requireReactDOM } from '@/utils/web/reactDomCjs';
import { EscapeLayerProvider, useEscapeLayerScope } from '@/keyboard/escape';
import { ModalBoundaryProvider, useIsInsideModalBoundary, useModalContentViewport } from '../context/ModalBoundaryContext';
import { ModalContentIdProvider, useModalContentId } from '../context/ModalContentIdContext';
import { ModalPortalPlacementProvider, useModalPortalPlacement } from '../portal/ModalPortalTarget';
import { SheetDismissProvider, useSheetDismiss } from './card/sheetDragDismiss';
import { PopoverScrollSourceProvider, usePopoverScrollSourceRef } from '@/components/ui/popover/PopoverScrollSource';
import { ContainedPageScopeProvider, useContainedPageScope } from '@/components/ui/lists/listPresentation';
import { SurfaceFreshnessOnSheetProvider, useSurfaceFreshnessOnSheet } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { PluginSurfaceFocusEligibilityTransfer, useCapturedPluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PaneRegionProvider, usePaneRegion } from '@/components/appShell/panes/paneRegionContext';
import { ScreenBackdropBoundary } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { retainDeep, retainShallow } from '@/sync/domains/state/structuralSharing';
import type { ModalCardFrame } from './card/ModalCardFrame';

/**
 * The facts a presentation shell gives the subtree it presents: its dialog, layer and input scope, and
 * the surface it sits on (a card body, a pane column). A retained body reads them from whichever shell
 * presents it now, never from the page that renders it.
 */
type ShellFacts = Readonly<{
    viewport: ReturnType<typeof useModalContentViewport>;
    inside: ReturnType<typeof useIsInsideModalBoundary>;
    modalId: ReturnType<typeof useModalContentId>;
    escape: ReturnType<typeof useEscapeLayerScope>;
    portal: ReturnType<typeof useModalPortalPlacement>;
    dismiss: ReturnType<typeof useSheetDismiss>;
    scroll: ReturnType<typeof usePopoverScrollSourceRef>;
    contained: ReturnType<typeof useContainedPageScope>;
    onSheet: ReturnType<typeof useSurfaceFreshnessOnSheet>;
    focus: ReturnType<typeof useCapturedPluginSurfaceFocusEligibility>;
    region: ReturnType<typeof usePaneRegion>;
}>;
type Placement<TArgs> = ShellFacts & Readonly<{ args: TArgs }>;

export type RetainedPlacement<TArgs> = Readonly<{
    /** The element a presentation shell renders where the body appears. */
    mount: (args: TArgs) => React.ReactElement;
    /** The one mounted body; render it at a position that outlives every shell. `null` off the web DOM. */
    body: React.ReactNode;
}>;

/**
 * Keeps one body mounted while its presentation moves between shells (a dialog's card and sheet, a
 * page's pane column and its phone dialog). The body renders once, at its owner's stable position, and
 * its DOM host moves into whichever shell is mounted; local state (an open operation, unsubmitted text)
 * survives the move. Without a web DOM each shell renders the body itself.
 */
export function useRetainedPlacement<TArgs>(render: (args: TArgs) => React.ReactNode): RetainedPlacement<TArgs> {
    const [host] = React.useState(() => Platform.OS === 'web' && typeof document !== 'undefined'
        ? document.createElement('div') : null);
    const [placement, setPlacement] = React.useState<Placement<TArgs> | null>(null);
    // The newest mounted shell presents the body. An outgoing shell can stay mounted while it hides or animates
    // out after the next one mounted (a docked pane folding away under the phone's dialog); it neither speaks
    // for the body nor takes its DOM host with it when it finally unmounts.
    const owner = React.useRef<object | null>(null);
    const publish = React.useCallback((next: Placement<TArgs>) => setPlacement(previous => {
        const args = retainDeep(previous?.args, next.args);
        return retainShallow(previous ?? undefined, { ...next, args });
    }), []);
    // With a DOM host the slot never renders the body, so it stays the same element while the body changes.
    const mount = React.useCallback((args: TArgs) => host
        ? <RetainedPlacementSlot host={host} owner={owner} args={args} publish={publish} />
        : <>{render(args)}</>, [host, publish, host ? null : render]);
    if (!host) return { mount, body: null };
    // The portal's React parent and target never change. Only its DOM host moves between shells.
    // Portaling into the shell itself would remount the body whenever that target changes.
    // Every provider renders in every placement, so a shell change never changes the body's tree shape.
    const presented = placement ? <EscapeLayerProvider layer={placement.escape}>
        <ModalContentIdProvider id={placement.modalId}>
            <ModalPortalPlacementProvider placement={placement.portal}>
                <ModalBoundaryProvider viewport={placement.viewport} inside={placement.inside}>
                    <SheetDismissProvider onDismiss={placement.dismiss}>
                        <PopoverScrollSourceProvider scrollSourceRef={placement.scroll}>
                            <PluginSurfaceFocusEligibilityTransfer captured={placement.focus}>
                                <PaneRegionProvider region={placement.region}>
                                    <ContainedPageScopeProvider contained={placement.contained}>
                                        <SurfaceFreshnessOnSheetProvider onSheet={placement.onSheet}>
                                            {/* A presented body never owns the backdrop of the screen that renders it. */}
                                            <ScreenBackdropBoundary>{render(placement.args)}</ScreenBackdropBoundary>
                                        </SurfaceFreshnessOnSheetProvider>
                                    </ContainedPageScopeProvider>
                                </PaneRegionProvider>
                            </PluginSurfaceFocusEligibilityTransfer>
                        </PopoverScrollSourceProvider>
                    </SheetDismissProvider>
                </ModalBoundaryProvider>
            </ModalPortalPlacementProvider>
        </ModalContentIdProvider>
    </EscapeLayerProvider> : null;
    const reactDOM: Pick<typeof import('react-dom'), 'createPortal'> = requireReactDOM();
    return { mount, body: reactDOM.createPortal(presented, host) };
}

function RetainedPlacementSlot<TArgs>(props: Readonly<{
    host: HTMLDivElement;
    owner: React.MutableRefObject<object | null>;
    args: TArgs;
    publish: (placement: Placement<TArgs>) => void;
}>) {
    const slot = React.useRef<HTMLDivElement>(null);
    const [token] = React.useState(() => ({}));
    const viewport = useModalContentViewport();
    const inside = useIsInsideModalBoundary();
    const modalId = useModalContentId();
    const escape = useEscapeLayerScope();
    const portal = useModalPortalPlacement();
    // A shell's dismiss is often a fresh closure each render; the body reaches the current one through one
    // stable function, so re-rendering the shell never republishes (and re-renders) the body.
    const shellDismiss = useSheetDismiss();
    const shellDismissRef = React.useRef(shellDismiss);
    const [stableDismiss] = React.useState(() => () => { shellDismissRef.current?.(); });
    const dismiss = shellDismiss === null ? null : stableDismiss;
    const scroll = usePopoverScrollSourceRef();
    const contained = useContainedPageScope();
    const onSheet = useSurfaceFreshnessOnSheet();
    const focus = useCapturedPluginSurfaceFocusEligibility();
    const region = usePaneRegion();
    const { host, owner, publish, args } = props;
    React.useLayoutEffect(() => {
        owner.current = token;
        host.style.display = 'contents';
        slot.current?.appendChild(host);
        return () => {
            if (owner.current !== token) return;
            owner.current = null;
            host.remove();
        };
    }, [host, owner, token]);
    React.useLayoutEffect(() => { shellDismissRef.current = shellDismiss; }, [shellDismiss]);
    React.useLayoutEffect(() => {
        if (owner.current !== token) return;
        publish({ args, viewport, inside, modalId, escape, portal, dismiss, scroll, contained, onSheet, focus, region });
    }, [owner, token, publish, args, viewport, inside, modalId, escape, portal, dismiss, scroll, contained, onSheet, focus, region]);
    return <div ref={slot} style={{ display: 'contents' }} />;
}

type FrameStyle = React.ComponentProps<typeof ModalCardFrame>['style'];
type FrameArgs = Readonly<{ style: FrameStyle; closeButton: boolean }>;
type Frame = (style?: FrameStyle, closeButton?: boolean) => React.ReactElement;

/** The shell supplies placement and input scope; the modal keeps its one frame and form mounted. */
export function RetainedModalFrame(props: Readonly<{
    frame: Frame;
    children: (frame: Frame) => React.ReactNode;
}>) {
    const { frame } = props;
    const render = React.useCallback((args: FrameArgs) => frame(args.style, args.closeButton), [frame]);
    const retained = useRetainedPlacement(render);
    const mount: Frame = (style, closeButton = true) => retained.mount({ style, closeButton });
    return <>{props.children(mount)}{retained.body}</>;
}
