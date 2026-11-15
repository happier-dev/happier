import * as React from 'react';

const ModalContentIdContext = React.createContext<string | null>(null);

/** The dialog a subtree belongs to; set by the modal host around each hosted dialog. */
export function ModalContentIdProvider(props: Readonly<{ id: string | null; children: React.ReactNode }>) {
    return <ModalContentIdContext.Provider value={props.id}>{props.children}</ModalContentIdContext.Provider>;
}

export const useModalContentId = () => React.useContext(ModalContentIdContext);
