import * as React from 'react';
import { Platform } from 'react-native';
import { requireReactDOM } from '@/utils/web/reactDomCjs';
import { EscapeLayerProvider, useEscapeLayerScope } from '@/keyboard/escape';
import { ModalBoundaryProvider, useIsInsideModalBoundary, useModalContentViewport } from '../context/ModalBoundaryContext';
import { ModalPortalTargetProvider, useModalLayerZIndex, useModalPortalTarget } from '../portal/ModalPortalTarget';
import { SheetDismissProvider, useSheetDismiss } from './card/sheetDragDismiss';
import { PopoverScrollSourceProvider, usePopoverScrollSourceRef } from '@/components/ui/popover/PopoverScrollSource';
import { retainDeep, retainShallow } from '@/sync/domains/state/structuralSharing';
import type { ModalCardFrame } from './card/ModalCardFrame';

type FrameStyle = React.ComponentProps<typeof ModalCardFrame>['style'];
type Frame = (style?: FrameStyle, closeButton?: boolean) => React.ReactElement;
type Placement = Readonly<{
    style: FrameStyle;
    closeButton: boolean;
    viewport: ReturnType<typeof useModalContentViewport>;
    inside: boolean;
    escape: ReturnType<typeof useEscapeLayerScope>;
    target: ReturnType<typeof useModalPortalTarget>;
    layer: ReturnType<typeof useModalLayerZIndex>;
    dismiss: ReturnType<typeof useSheetDismiss>;
    scroll: ReturnType<typeof usePopoverScrollSourceRef>;
}>;

/** The shell supplies placement and input scope; the modal keeps its one frame and form mounted. */
export function RetainedModalFrame(props: Readonly<{
    frame: Frame;
    children: (frame: Frame) => React.ReactNode;
}>) {
    const [host] = React.useState(() => Platform.OS === 'web' && typeof document !== 'undefined'
        ? document.createElement('div') : null);
    const [placement, setPlacement] = React.useState<Placement | null>(null);
    const publish = React.useCallback((next: Placement) => setPlacement(previous => {
        const style = retainDeep(previous?.style, next.style);
        return retainShallow(previous ?? undefined, { ...next, style });
    }), []);
    if (!host) return <>{props.children(props.frame)}</>;
    const mount: Frame = (style, closeButton = true) => <ModalFrameMount host={host}
        style={style} closeButton={closeButton} publish={publish} />;
    // The portal's React parent and target never change. Only its DOM host moves between shells.
    // Portaling into the shell itself would remount the form whenever that target changes.
    const body = placement ? <ModalPortalTargetProvider target={placement.target}
        {...(placement.layer === null ? {} : { layerZIndex: placement.layer })}>
        <ModalBoundaryProvider viewport={placement.viewport} inside={placement.inside}>
            <SheetDismissProvider onDismiss={placement.dismiss}>
                <PopoverScrollSourceProvider scrollSourceRef={placement.scroll}>
                    {props.frame(placement.style, placement.closeButton)}
                </PopoverScrollSourceProvider>
            </SheetDismissProvider>
        </ModalBoundaryProvider>
    </ModalPortalTargetProvider> : null;
    const scopedBody = placement?.escape ? <EscapeLayerProvider layer={placement.escape}>{body}</EscapeLayerProvider> : body;
    const reactDOM: Pick<typeof import('react-dom'), 'createPortal'> = requireReactDOM();
    return <>{props.children(mount)}{reactDOM.createPortal(scopedBody, host)}</>;
}

function ModalFrameMount(props: Readonly<{
    host: HTMLDivElement;
    style: FrameStyle;
    closeButton: boolean;
    publish: (placement: Placement) => void;
}>) {
    const slot = React.useRef<HTMLDivElement>(null);
    const viewport = useModalContentViewport();
    const inside = useIsInsideModalBoundary();
    const escape = useEscapeLayerScope();
    const target = useModalPortalTarget();
    const layer = useModalLayerZIndex();
    const dismiss = useSheetDismiss();
    const scroll = usePopoverScrollSourceRef();
    React.useLayoutEffect(() => {
        props.host.style.display = 'contents';
        slot.current?.appendChild(props.host);
        return () => { props.host.remove(); };
    }, [props.host]);
    React.useLayoutEffect(() => {
        props.publish({ style: props.style, closeButton: props.closeButton, viewport, inside, escape, target, layer, dismiss, scroll });
    }, [props.publish, props.style, props.closeButton, viewport, inside, escape, target, layer, dismiss, scroll]);
    return <div ref={slot} style={{ display: 'contents' }} />;
}
