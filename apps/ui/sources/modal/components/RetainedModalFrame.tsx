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
import { SurfacePlanesTransfer, useContainingSurfacePlanes } from '@/components/ui/glass/GlassSurface';
import { FloatingOverlayPhonePanelContext, FloatingOverlaySheetContext } from '@/components/ui/overlays/FloatingOverlay';
import { PhoneSheetPushContext } from '@/components/ui/popover/phoneSheetPush';
import { PhonePushedViewContext } from '@/components/ui/popover/phonePushedView';
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
    planes: ReturnType<typeof useContainingSurfacePlanes>;
    /** A floating sheet's body (a phone popover sheet), its push stack and the pushed view it stands in. */
    onFloatingSheet: boolean;
    /** A phone panel's body (`Popover` `phonePresentation="panel"`): its surface wears the sheet's coat. */
    onPhonePanel: boolean;
    pushStack: React.ContextType<typeof PhoneSheetPushContext>;
    pushedView: React.ContextType<typeof PhonePushedViewContext>;
}>;
type Placement<TArgs> = ShellFacts & Readonly<{ args: TArgs }>;

export type RetainedPlacement<TArgs> = Readonly<{
    /** A web shell still presents this body, including an outgoing transition's slot. */
    hasPlacement: boolean;
    /** The element a presentation shell renders where the body appears. */
    mount: (args: TArgs, publishArgsRef?: React.Ref<(args: TArgs) => void>) => React.ReactElement;
    /** The one mounted body; render it at a position that outlives every shell. `null` off the web DOM. */
    body: React.ReactNode;
}>;

/**
 * Keeps one body mounted while its presentation moves between shells (a dialog's card and sheet, a
 * page's pane column and its phone dialog). The body renders once, at its owner's stable position, and
 * its DOM host moves into whichever shell is mounted; local state (an open operation, unsubmitted text)
 * survives the move. Without a web DOM each shell renders the body itself.
 */
export function useRetainedPlacement<TArgs>(
    render: (args: TArgs) => React.ReactNode,
    /**
     * Retire the body when its last shell unmounts while this holds (a popover that closed). Otherwise the body
     * outlives a gap between shells (a pane folding into a later dialog, a popover pushing into a phone sheet).
     */
    options?: Readonly<{ retireWithoutShell?: boolean }>,
): RetainedPlacement<TArgs> {
    const [host] = React.useState(() => Platform.OS === 'web' && typeof document !== 'undefined'
        && typeof document.createElement === 'function'
        ? document.createElement('div') : null);
    const [placement, setPlacement] = React.useState<Placement<TArgs> | null>(null);
    // The newest mounted shell presents the body. An outgoing shell can stay mounted while it hides or animates
    // out after the next one mounted (a docked pane folding away under the phone's dialog); it neither speaks
    // for the body nor takes its DOM host with it when it finally unmounts.
    const owner = React.useRef<object | null>(null);
    // A shell can take focus for itself before the body moves into it (a pane activating as an overlay for a
    // frame while a phone sheet still holds the body): the field it blurred is the one to give focus back to.
    React.useEffect(() => {
        if (!host) return;
        const onFocusOut = (event: FocusEvent) => {
            const next = event.relatedTarget;
            if (!(next instanceof Node) || !host.contains(next)) blurredByMove = event.target as Element;
        };
        host.addEventListener('focusout', onFocusOut);
        return () => host.removeEventListener('focusout', onFocusOut);
    }, [host]);
    const lastPublication = React.useRef<Placement<TArgs> | null>(null);
    const publish = React.useCallback((next: Placement<TArgs>) => {
        const previous = lastPublication.current;
        const args = retainDeep(previous?.args, next.args);
        const publication = retainShallow(previous ?? undefined, { ...next, args });
        if (publication === previous) return;
        lastPublication.current = publication;
        setPlacement(publication);
    }, []);
    // With a DOM host the slot never renders the body, so it stays the same element while the body changes.
    const retireWithoutShell = React.useRef(false);
    retireWithoutShell.current = options?.retireWithoutShell === true;
    const retire = React.useCallback(() => {
        if (!retireWithoutShell.current || lastPublication.current === null) return;
        lastPublication.current = null;
        setPlacement(null);
    }, []);
    const mount = React.useCallback<RetainedPlacement<TArgs>['mount']>((args, publishArgsRef) => host
        ? <RetainedPlacementSlot host={host} owner={owner} args={args}
            publishArgsRef={publishArgsRef} publish={publish} retire={retire} />
        : <>{render(args)}</>, [host, publish, retire, host ? null : render]);
    if (!host) return { mount, body: null, hasPlacement: false };
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
                                            <SurfacePlanesTransfer planes={placement.planes}>
                                                <FloatingOverlaySheetContext.Provider value={placement.onFloatingSheet}>
                                                <FloatingOverlayPhonePanelContext.Provider value={placement.onPhonePanel}>
                                                    <PhoneSheetPushContext.Provider value={placement.pushStack}>
                                                        <PhonePushedViewContext.Provider value={placement.pushedView}>
                                                            {/* A presented body never owns the backdrop of the screen that renders it. */}
                                                            <ScreenBackdropBoundary>{render(placement.args)}</ScreenBackdropBoundary>
                                                        </PhonePushedViewContext.Provider>
                                                    </PhoneSheetPushContext.Provider>
                                                </FloatingOverlayPhonePanelContext.Provider>
                                                </FloatingOverlaySheetContext.Provider>
                                            </SurfacePlanesTransfer>
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
    return { mount, body: reactDOM.createPortal(presented, host), hasPlacement: placement !== null };
}

/**
 * The element focus last left a retained body from, or that a moving host blurred. One record for every retained
 * body: bodies nest (a Run's review card inside its retained step), both move in one commit, and whichever host
 * leaves first takes the focused element with it, so the inner host sees focus already gone (QA-DESIGN-R3 R2).
 * The element regains focus when the host that now holds it is placed, but only while focus is nowhere or on
 * that host's own shell: focus a person moved to another control stays there.
 */
let blurredByMove: Element | null = null;

function restoreFocusBlurredByMove(host: HTMLElement): void {
    const target = blurredByMove;
    if (!target || !host.contains(target) || !host.isConnected) return;
    blurredByMove = null;
    const active = document.activeElement;
    if (active === target) return;
    // A shell that placed focus on itself (a dialog taking focus as it opened) yields to the moved field.
    const unclaimed = !active || active === document.body || active.contains(host);
    if (unclaimed) (target as HTMLElement).focus?.({ preventScroll: true });
}

function RetainedPlacementSlot<TArgs>(props: Readonly<{
    host: HTMLDivElement;
    owner: React.MutableRefObject<object | null>;
    args: TArgs;
    publishArgsRef?: React.Ref<(args: TArgs) => void>;
    publish: (placement: Placement<TArgs>) => void;
    retire: () => void;
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
    const planes = useContainingSurfacePlanes();
    const onFloatingSheet = React.useContext(FloatingOverlaySheetContext);
    const onPhonePanel = React.useContext(FloatingOverlayPhonePanelContext);
    const pushStack = React.useContext(PhoneSheetPushContext);
    const pushedView = React.useContext(PhonePushedViewContext);
    const { host, owner, publish, retire, args } = props;
    React.useLayoutEffect(() => {
        owner.current = token;
        host.style.display = 'contents';
        // Moving the host blurs whatever the body had focused. Give that element focus back once it is in a
        // placed shell again: the shell's own focus placement sees focus already inside it and keeps it (J18).
        const active = document.activeElement;
        if (active && host.contains(active)) blurredByMove = active;
        slot.current?.appendChild(host);
        restoreFocusBlurredByMove(host);
        return () => {
            if (owner.current !== token) return;
            owner.current = null;
            const leaving = document.activeElement;
            if (leaving && host.contains(leaving)) blurredByMove = leaving;
            host.remove();
            retire();
        };
    }, [host, owner, token, retire]);
    React.useLayoutEffect(() => { shellDismissRef.current = shellDismiss; }, [shellDismiss]);
    const publishArgs = React.useCallback((nextArgs: TArgs) => {
        if (owner.current !== token) return;
        publish({ args: nextArgs, viewport, inside, modalId, escape, portal, dismiss, scroll, contained, onSheet, focus, region,
            planes, onFloatingSheet, onPhonePanel, pushStack, pushedView });
    }, [owner, token, publish, viewport, inside, modalId, escape, portal, dismiss, scroll, contained, onSheet, focus, region,
        planes, onFloatingSheet, onPhonePanel, pushStack, pushedView]);
    React.useImperativeHandle(props.publishArgsRef, () => publishArgs, [publishArgs]);
    React.useLayoutEffect(() => publishArgs(args), [args, publishArgs]);
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
