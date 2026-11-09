import * as React from 'react';
import { useDestinationFocus } from '@/components/appShell/workspace/destinationInstanceContext';
import { usePaneRegion } from '@/components/appShell/panes/paneRegionContext';

/** A focused detail lends its existing model to shell chrome; no selection or body state is copied. */
export function createPresentedDetailContext<T>() {
    const Model = React.createContext<T | null>(null);
    const Depth = React.createContext(0);
    function Boundary(props: Readonly<{ children: React.ReactNode }>) {
        const depth = React.useContext(Depth);
        return <Depth.Provider value={depth + 1}>{props.children}</Depth.Provider>;
    }
    type Publisher = Readonly<{ publish: (owner: object, model: T, depth: number) => void; withdraw: (owner: object) => void }>;
    const Publication = React.createContext<Publisher>({ publish: () => {}, withdraw: () => {} });
    function Provider(props: Readonly<{ children: React.ReactNode }>) {
        const [model, setModel] = React.useState<T | null>(null);
        // Embedded detail pages borrow chrome from their containing detail and return it on close.
        const presentations = React.useRef(new Map<object, { model: T; depth: number }>());
        const update = React.useCallback(() => {
            let selected: { model: T; depth: number } | undefined;
            for (const entry of presentations.current.values()) {
                if (!selected || entry.depth >= selected.depth) selected = entry;
            }
            setModel(() => selected?.model ?? null);
        }, []);
        const publish = React.useCallback((owner: object, next: T, depth: number) => {
            presentations.current.delete(owner);
            presentations.current.set(owner, { model: next, depth });
            update();
        }, [update]);
        const withdraw = React.useCallback((owner: object) => {
            presentations.current.delete(owner);
            update();
        }, [update]);
        const publisher = React.useMemo(() => ({ publish, withdraw }), [publish, withdraw]);
        return <Publication.Provider value={publisher}><Model.Provider value={model}>{props.children}</Model.Provider></Publication.Provider>;
    }
    function usePublish(model: T, presented: boolean) {
        const focused = useDestinationFocus();
        // The page chrome belongs to the page: a detail drawn in the side column (a companion's embedded Session)
        // is beside the page, not nested in it, so it never takes the page's chrome.
        const region = usePaneRegion();
        const active = presented && focused && region !== 'side';
        const depth = React.useContext(Depth);
        const publisher = React.useContext(Publication);
        const owner = React.useRef({});
        React.useEffect(() => {
            if (!active) return;
            return () => {
                publisher.withdraw(owner.current);
            };
        }, [active, publisher]);
        React.useEffect(() => {
            if (!active) return;
            publisher.publish(owner.current, model, depth);
        }, [model, active, publisher, depth]);
    }
    return { Provider, Boundary, usePublish, useValue: () => React.useContext(Model) };
}
