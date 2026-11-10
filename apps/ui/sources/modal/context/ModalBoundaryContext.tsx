import * as React from 'react';
import { HappierItemGroupSelectionContext } from '@happier-dev/plugin-ui/presentation';

import { ItemGroupRowPositionBoundary } from '@/components/ui/lists/ItemGroupRowPosition';

const ModalBoundaryContext = React.createContext(false);
export type ModalContentViewport = Readonly<{ width: number; height: number; bottomInset: number }>;
const ModalContentViewportContext = React.createContext<ModalContentViewport | null>(null);

export type ModalBoundaryProviderProps = Readonly<{
    children: React.ReactNode;
    viewport?: ModalContentViewport | null;
    inside?: boolean;
}>;

/**
 * A modal's content mounts inside its opener's React tree, so it ends the opener's item group here:
 * rows in a dialog never read the selection count, radio group or corners of the group that opened it
 * (a Home hub group with no selectable row left the palette's active row without its fill).
 */
export function ModalBoundaryProvider(props: ModalBoundaryProviderProps) {
    return (
        <ModalBoundaryContext.Provider value={props.inside ?? true}>
            <ModalContentViewportContext.Provider value={props.viewport ?? null}>
                <HappierItemGroupSelectionContext.Provider value={null}>
                    <ItemGroupRowPositionBoundary>
                        {props.children}
                    </ItemGroupRowPositionBoundary>
                </HappierItemGroupSelectionContext.Provider>
            </ModalContentViewportContext.Provider>
        </ModalBoundaryContext.Provider>
    );
}

export function useIsInsideModalBoundary(): boolean {
    return React.useContext(ModalBoundaryContext);
}

/** The host's measured content bounds and bottom inset it has not already consumed. */
export function useModalContentViewport(): ModalContentViewport | null {
    return React.useContext(ModalContentViewportContext);
}
