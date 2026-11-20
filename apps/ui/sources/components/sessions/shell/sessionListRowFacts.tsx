import * as React from 'react';

import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { CollectionRowOrder } from '@/components/ui/lists/collection/CollectionList';
import { useCollectionListExtensions, type CollectionListExtensions } from '@/components/ui/lists/collection/useCollectionListExtensions';

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
    /**
     * The open Session. Opening another one is a change to two rows (and the row above each, which drops
     * its separator), so it reaches rows here rather than through `extraData`, which redrew every cell.
     */
    selection: SessionListRowSelection;
}>;

export type SessionListRowSelection = Readonly<{
    sessionId: string | null;
    serverId: string | null;
    /** An unscoped selection (no Home in the route) marks a row only when its id is unique in the list. */
    unscopedSelectionIsUnique: boolean;
}>;

type SessionListRowSessionAddress = Readonly<{ sessionId: string; serverId?: string | null }>;
const SESSION_EXTENSION_FACTS = new Map([['branch', (branch: string) => branch]]);

function isSelectedSessionRow(selection: SessionListRowSelection, row: SessionListRowSessionAddress): boolean {
    return selection.sessionId !== null && selection.sessionId === row.sessionId
        && (selection.serverId === null || selection.serverId === (row.serverId ?? null));
}

type SessionListRowFactsWithExtensions = SessionListRowFacts & Readonly<{
    pluginDetails: CollectionListExtensions<string>['details'] | undefined;
}>;
type SessionListRowFactsSource = Readonly<{
    get: () => SessionListRowFactsWithExtensions;
    subscribe: (listener: () => void) => () => void;
}>;

const SessionListRowFactsContext = React.createContext<SessionListRowFactsSource | null>(null);

/**
 * Hands the list-wide lookups to mounted rows as one stable source: rows rendered in this pass read the
 * current facts, mounted rows hear about a change after commit and render only if their own entry moved.
 */
export function SessionListRowFactsProvider(props: React.PropsWithChildren<Readonly<{ value: SessionListRowFacts }>>) {
    const { details } = useCollectionListExtensions('sessionWork', SESSION_EXTENSION_FACTS);
    const value = React.useMemo(() => ({
        ...props.value, pluginDetails: details.length ? details : undefined,
    }), [props.value, details]);
    const [owner] = React.useState(() => {
        let current = value;
        const listeners = new Set<() => void>();
        return {
            source: {
                get: () => current,
                subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            } satisfies SessionListRowFactsSource,
            assign: (next: SessionListRowFactsWithExtensions) => { current = next; },
            notify: () => { for (const listener of [...listeners]) listener(); },
        };
    });
    owner.assign(value);
    React.useLayoutEffect(owner.notify, [owner, value]);
    return <SessionListRowFactsContext.Provider value={owner.source}>{props.children}</SessionListRowFactsContext.Provider>;
}

function useSessionListRowFactsSource(): SessionListRowFactsSource {
    const source = React.useContext(SessionListRowFactsContext);
    if (source === null) throw new Error('Session list rows render inside SessionListRowFactsProvider');
    return source;
}

/** One reader's selection of the facts; it renders only when `equal` says the selection changed. */
function useSessionListRowFactsSelection<T>(select: (facts: SessionListRowFactsWithExtensions) => T, equal: (left: T, right: T) => boolean): T {
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
    Omit<SessionListRowViewModelBoundaryProps, 'pluginDetails' | 'reachableSessionDisplay' | 'selectedSessionId' | 'selectedSessionServerId'
        | 'unscopedSelectionIsUnique' | keyof SessionListSelectedRowContextInput> & {
        item: SessionRowItem;
        rowContextChoices: SessionListRowContextChoices;
    }
>): React.ReactElement {
    const { rowContextChoices, ...boundaryProps } = props;
    const { item } = props;
    // This row's own entries: a facts change for other rows (or an equal rebuild) does not render it.
    const selected = useSessionListRowFactsSelection(React.useCallback((facts: SessionListRowFactsWithExtensions) => {
        const { projectDisplayByKey, groupProjectByGroupKey } = facts.projectHeaderViewModelState;
        // Only the selected row sees the selection: the other rows' inputs stay equal when it moves.
        const own = facts.selection.sessionId === item.sessionId;
        return {
            pluginDetails: facts.pluginDetails,
            selectedSessionId: own ? facts.selection.sessionId : null,
            selectedSessionServerId: own ? facts.selection.serverId : null,
            unscopedSelectionIsUnique: own && facts.selection.unscopedSelectionIsUnique,
            ...selectSessionListRowContextInput(item, { ...rowContextChoices, projectDisplayByKey, groupProjectByGroupKey }),
            reachableSessionDisplay: (item.serverId ? facts.reachableSessionDisplayByKey.get(
                sessionAddressKey({ serverId: item.serverId, sessionId: item.sessionId }),
            ) : undefined) ?? facts.reachableSessionDisplayById.get(item.sessionId),
        };
    }, [item, rowContextChoices]), areShallowEqual);
    return <SessionListRowViewModelBoundary {...boundaryProps} {...selected} />;
}

/**
 * A list cell's row order: whether the row below it is the selected Session (the cell then drops its
 * separator) is read from the row facts, so only the cell above the old and the new selection redraws.
 */
export function SessionListRowOrderWithFacts(props: React.PropsWithChildren<Readonly<{
    followed: boolean;
    next: SessionListRowSessionAddress | null;
}>>): React.ReactElement {
    const { next } = props;
    const precedesSelected = useSessionListRowFactsSelection(
        React.useCallback((facts: SessionListRowFacts) => next !== null && isSelectedSessionRow(facts.selection, next), [next]),
        Object.is,
    );
    return <CollectionRowOrder followed={props.followed} precedesSelected={precedesSelected}>{props.children}</CollectionRowOrder>;
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
