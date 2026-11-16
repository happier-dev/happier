import * as React from 'react';

import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { SessionListHeaderItem } from './sessionListHeaderItem';
import type { SessionListProjectHeaderViewModelState } from './sessionListProjectHeaderViewModels';
import {
    SessionListRowViewModelBoundary,
    type SessionListRowViewModelBoundaryProps,
} from './SessionListRowViewModelBoundary';
import {
    selectSessionListRowContextInput,
    type SessionListRowContextInput,
    type SessionListSelectedRowContextInput,
    type SessionReachableDisplay,
} from './sessionListRowViewModels';

/**
 * List-wide lookups that mounted rows read their own entry from: where each Session runs and the
 * Project display index. Any Session joining, leaving or changing replaces these maps.
 *
 * Mounted recycler cells redraw whenever the list's `extraData` changes, so carrying these maps there
 * redrew every mounted row (and its recycler container) for a change to one row. Delivered here, a map
 * change reaches each mounted row as a context read, and only the rows whose own entry changed redraw.
 */
export type SessionListRowFacts = Readonly<{
    reachableSessionDisplayById: ReadonlyMap<string, SessionReachableDisplay>;
    reachableSessionDisplayByKey: ReadonlyMap<string, SessionReachableDisplay>;
    projectHeaderViewModelState: SessionListProjectHeaderViewModelState;
}>;

type SessionListRowFactsSource = Readonly<{
    get: () => SessionListRowFacts;
    subscribe: (listener: () => void) => () => void;
}>;

const SessionListRowFactsContext = React.createContext<SessionListRowFactsSource | null>(null);

/**
 * Hands the list-wide lookups to mounted rows as one stable source: rows rendered in this pass read the
 * current facts, mounted rows hear about a change after commit and render only if their own entry moved.
 */
export function SessionListRowFactsProvider(props: React.PropsWithChildren<Readonly<{ value: SessionListRowFacts }>>) {
    const [owner] = React.useState(() => {
        let current = props.value;
        const listeners = new Set<() => void>();
        return {
            source: {
                get: () => current,
                subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            } satisfies SessionListRowFactsSource,
            assign: (next: SessionListRowFacts) => { current = next; },
            notify: () => { for (const listener of [...listeners]) listener(); },
        };
    });
    owner.assign(props.value);
    React.useLayoutEffect(owner.notify, [owner, props.value]);
    return <SessionListRowFactsContext.Provider value={owner.source}>{props.children}</SessionListRowFactsContext.Provider>;
}

function useSessionListRowFactsSource(): SessionListRowFactsSource {
    const source = React.useContext(SessionListRowFactsContext);
    if (source === null) throw new Error('Session list rows render inside SessionListRowFactsProvider');
    return source;
}

/** One reader's selection of the facts; it renders only when `equal` says the selection changed. */
function useSessionListRowFactsSelection<T>(select: (facts: SessionListRowFacts) => T, equal: (left: T, right: T) => boolean): T {
    const source = useSessionListRowFactsSource();
    const last = React.useRef<{ value: T } | null>(null);
    const getSnapshot = () => {
        const next = select(source.get());
        if (last.current && equal(last.current.value, next)) return last.current.value;
        last.current = { value: next };
        return next;
    };
    return React.useSyncExternalStore(source.subscribe, getSnapshot, getSnapshot);
}

function areShallowEqual<T extends Readonly<Record<string, unknown>>>(left: T, right: T): boolean {
    if (left === right) return true;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => Object.is(left[key], right[key]));
}

type SessionRowItem = Extract<SessionListIndexItem, { type: 'session' }>;

/** The row's Project-context choices: the per-row lookups come from the row facts. */
export type SessionListRowContextChoices = Omit<SessionListRowContextInput, 'projectDisplayByKey' | 'groupProjectByGroupKey'>;

/** A Session row that reads its own reachable display and Project context from the row facts. */
export function SessionListSessionRowWithFacts(props: Readonly<
    Omit<SessionListRowViewModelBoundaryProps, 'reachableSessionDisplay' | keyof SessionListSelectedRowContextInput> & {
        item: SessionRowItem;
        rowContextChoices: SessionListRowContextChoices;
    }
>): React.ReactElement {
    const { rowContextChoices, ...boundaryProps } = props;
    const { item } = props;
    // This row's own entries: a facts change for other rows (or an equal rebuild) does not render it.
    const selected = useSessionListRowFactsSelection(React.useCallback((facts: SessionListRowFacts) => {
        const { projectDisplayByKey, groupProjectByGroupKey } = facts.projectHeaderViewModelState;
        return {
            ...selectSessionListRowContextInput(item, { ...rowContextChoices, projectDisplayByKey, groupProjectByGroupKey }),
            reachableSessionDisplay: (item.serverId ? facts.reachableSessionDisplayByKey.get(
                sessionAddressKey({ serverId: item.serverId, sessionId: item.sessionId }),
            ) : undefined) ?? facts.reachableSessionDisplayById.get(item.sessionId),
        };
    }, [item, rowContextChoices]), areShallowEqual);
    return <SessionListRowViewModelBoundary {...boundaryProps} {...selected} />;
}

const selectProjectHeaderViewModelByGroupKey = (facts: SessionListRowFacts) => facts.projectHeaderViewModelState.projectHeaderViewModelByGroupKey;

/** A group header that reads the Project header view models from the row facts. */
export function SessionListHeaderItemWithFacts(
    props: Omit<React.ComponentProps<typeof SessionListHeaderItem>, 'projectHeaderViewModelByGroupKey'>,
): React.ReactElement {
    const projectHeaderViewModelByGroupKey = useSessionListRowFactsSelection(selectProjectHeaderViewModelByGroupKey, Object.is);
    return (
        <SessionListHeaderItem
            {...props}
            projectHeaderViewModelByGroupKey={projectHeaderViewModelByGroupKey}
        />
    );
}
