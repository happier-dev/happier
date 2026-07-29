import * as React from 'react';

export type InitialPresentationProducerHandle = Readonly<{
    complete: () => void;
    dispose: () => void;
}>;

export type InitialPresentationReadinessBoundary = Readonly<{
    presentationPending: boolean;
    registerProducer: (producerKey: string) => InitialPresentationProducerHandle;
}>;

const InitialPresentationReadinessContext =
    React.createContext<InitialPresentationReadinessBoundary | null>(null);

export const InitialPresentationReadinessProvider = InitialPresentationReadinessContext.Provider;

export function useInitialPresentationReadiness(): InitialPresentationReadinessBoundary | null {
    return React.useContext(InitialPresentationReadinessContext);
}

export function useInitialPresentationProducer(params: Readonly<{
    producerKey: string;
    terminal: boolean;
}>): void {
    const boundary = useInitialPresentationReadiness();
    const handleRef = React.useRef<InitialPresentationProducerHandle | null>(null);

    React.useLayoutEffect(() => {
        if (!boundary?.presentationPending) return undefined;
        const handle = boundary.registerProducer(params.producerKey);
        handleRef.current = handle;
        return () => {
            if (handleRef.current === handle) handleRef.current = null;
            handle.dispose();
        };
    }, [boundary, params.producerKey]);

    React.useLayoutEffect(() => {
        if (!params.terminal) return;
        handleRef.current?.complete();
    }, [boundary, params.producerKey, params.terminal]);
}
