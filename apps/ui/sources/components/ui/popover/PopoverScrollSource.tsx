import * as React from 'react';

type PopoverScrollSourceRef = React.RefObject<any> | null;

const PopoverScrollSourceContext = React.createContext<PopoverScrollSourceRef>(null);

export function PopoverScrollSourceProvider(props: Readonly<{
    scrollSourceRef: PopoverScrollSourceRef;
    children: React.ReactNode;
}>) {
    return (
        <PopoverScrollSourceContext.Provider value={props.scrollSourceRef}>
            {props.children}
        </PopoverScrollSourceContext.Provider>
    );
}

export function usePopoverScrollSourceRef(): PopoverScrollSourceRef {
    return React.useContext(PopoverScrollSourceContext);
}

