import * as React from 'react';

import type { ProjectsListModel } from './useProjectsListModel';

type ProjectsColumnModelSlot = Readonly<{
    columnActive: boolean;
    getModel: () => ProjectsListModel | null;
    subscribe: (listener: () => void) => () => void;
    publish: (model: ProjectsListModel | null) => void;
}>;

const ProjectsColumnModelContext = React.createContext<ProjectsColumnModelSlot | null>(null);
const NOOP_SUBSCRIBE = () => () => {};
const READ_NULL = () => null;

/**
 * Pure-React bridge that lets a visible `ProjectsColumn` share its live `useProjectsListModel()`
 * output with its sibling `/projects` empty index view without mounting a second copy of the model
 * or retaining any module-level global state.
 */
export function ProjectsColumnModelProvider(props: Readonly<{
    columnActive: boolean;
    children: React.ReactNode;
}>) {
    const stateRef = React.useRef<{
        model: ProjectsListModel | null;
        listeners: Set<() => void>;
    }>({ model: null, listeners: new Set() });

    const slot = React.useMemo<ProjectsColumnModelSlot>(() => ({
        columnActive: props.columnActive,
        getModel: () => stateRef.current.model,
        subscribe: (listener) => {
            stateRef.current.listeners.add(listener);
            return () => {
                stateRef.current.listeners.delete(listener);
            };
        },
        publish: (nextModel) => {
            if (Object.is(stateRef.current.model, nextModel)) return;
            stateRef.current.model = nextModel;
            for (const listener of [...stateRef.current.listeners]) {
                listener();
            }
        },
    }), [props.columnActive]);

    return (
        <ProjectsColumnModelContext.Provider value={slot}>
            {props.children}
        </ProjectsColumnModelContext.Provider>
    );
}

/** Publishes the mounted `ProjectsColumn` model to its sibling index surface during commit. */
export function usePublishProjectsColumnModel(model: ProjectsListModel): void {
    const slot = React.useContext(ProjectsColumnModelContext);
    React.useLayoutEffect(() => {
        slot?.publish(model);
    }, [slot, model]);
    React.useLayoutEffect(() => {
        return () => {
            slot?.publish(null);
        };
    }, [slot]);
}

/** Reads the sibling `ProjectsColumn` model when the shell has mounted the Projects column. */
export function useSharedProjectsColumnModel(): Readonly<{
    columnActive: boolean;
    model: ProjectsListModel | null;
}> {
    const slot = React.useContext(ProjectsColumnModelContext);
    const model = React.useSyncExternalStore(
        slot ? slot.subscribe : NOOP_SUBSCRIBE,
        slot ? slot.getModel : READ_NULL,
        slot ? slot.getModel : READ_NULL,
    );
    return { columnActive: slot?.columnActive ?? false, model };
}
