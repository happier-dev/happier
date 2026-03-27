import * as React from 'react';

const ModalBoundaryContext = React.createContext(false);

export type ModalBoundaryProviderProps = Readonly<{
    children: React.ReactNode;
}>;

export function ModalBoundaryProvider(props: ModalBoundaryProviderProps) {
    return (
        <ModalBoundaryContext.Provider value={true}>
            {props.children}
        </ModalBoundaryContext.Provider>
    );
}

export function useIsInsideModalBoundary(): boolean {
    return React.useContext(ModalBoundaryContext);
}

