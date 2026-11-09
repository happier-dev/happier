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

const SessionListRowFactsContext = React.createContext<SessionListRowFacts | null>(null);

export const SessionListRowFactsProvider = SessionListRowFactsContext.Provider;

function useSessionListRowFacts(): SessionListRowFacts {
    const facts = React.useContext(SessionListRowFactsContext);
    if (facts === null) throw new Error('Session list rows render inside SessionListRowFactsProvider');
    return facts;
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
    const facts = useSessionListRowFacts();
    const { rowContextChoices, ...boundaryProps } = props;
    const { item } = props;
    const reachableSessionDisplay = (item.serverId ? facts.reachableSessionDisplayByKey.get(
        sessionAddressKey({ serverId: item.serverId, sessionId: item.sessionId }),
    ) : undefined) ?? facts.reachableSessionDisplayById.get(item.sessionId);
    const { projectDisplayByKey, groupProjectByGroupKey } = facts.projectHeaderViewModelState;
    return (
        <SessionListRowViewModelBoundary
            {...boundaryProps}
            {...selectSessionListRowContextInput(item, { ...rowContextChoices, projectDisplayByKey, groupProjectByGroupKey })}
            reachableSessionDisplay={reachableSessionDisplay}
        />
    );
}

/** A group header that reads the Project header view models from the row facts. */
export function SessionListHeaderItemWithFacts(
    props: Omit<React.ComponentProps<typeof SessionListHeaderItem>, 'projectHeaderViewModelByGroupKey'>,
): React.ReactElement {
    const facts = useSessionListRowFacts();
    return (
        <SessionListHeaderItem
            {...props}
            projectHeaderViewModelByGroupKey={facts.projectHeaderViewModelState.projectHeaderViewModelByGroupKey}
        />
    );
}
