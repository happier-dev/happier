import * as React from 'react';

export type ModalPortalTarget = Element | DocumentFragment | null;

const NO_MODAL_PORTAL_PROVIDER = Symbol('happier.modalPortalTarget.noProvider');
type ModalPortalTargetContextValue = ModalPortalTarget | typeof NO_MODAL_PORTAL_PROVIDER;

const ModalPortalTargetContext = React.createContext<ModalPortalTargetContextValue>(NO_MODAL_PORTAL_PROVIDER);

export function ModalPortalTargetProvider(props: {
    target: ModalPortalTarget;
    children: React.ReactNode;
}) {
    return (
        <ModalPortalTargetContext.Provider value={props.target}>
            {props.children}
        </ModalPortalTargetContext.Provider>
    );
}

export function useModalPortalTarget(): ModalPortalTarget {
    const value = React.useContext(ModalPortalTargetContext);
    return value === NO_MODAL_PORTAL_PROVIDER ? null : value;
}

export function useHasModalPortalTargetProvider(): boolean {
    return React.useContext(ModalPortalTargetContext) !== NO_MODAL_PORTAL_PROVIDER;
}
