import * as React from 'react';

/**
 * `both`: popovers opened inside stay within the view's box. `horizontal`: they stay within its width
 * while the window sets their vertical room, so a short panel never cramps a list opened inside it.
 */
export type PopoverBoundaryAxis = 'both' | 'horizontal';

type PopoverBoundary = Readonly<{ ref: React.RefObject<any>; axis: PopoverBoundaryAxis }>;

const PopoverBoundaryContext = React.createContext<PopoverBoundary | null>(null);

export function PopoverBoundaryProvider(props: {
    boundaryRef: React.RefObject<any>;
    axis?: PopoverBoundaryAxis;
    children: React.ReactNode;
}) {
    const axis = props.axis ?? 'both';
    const value = React.useMemo(() => ({ ref: props.boundaryRef, axis }), [props.boundaryRef, axis]);
    return (
        <PopoverBoundaryContext.Provider value={value}>
            {props.children}
        </PopoverBoundaryContext.Provider>
    );
}

/** The nearest declared boundary view, whichever axis it bounds. */
export function usePopoverBoundaryRef() {
    return React.useContext(PopoverBoundaryContext)?.ref ?? null;
}

export function usePopoverBoundary(): PopoverBoundary | null {
    return React.useContext(PopoverBoundaryContext);
}
