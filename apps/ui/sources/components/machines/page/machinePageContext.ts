import * as React from 'react';

import type { PageColumn } from '@/components/ui/layout/contentWidthMode';

import type { useManagedEnrolledMachine } from '@/components/settings/machines/managed/ManagedMachineSections';

import { useMachinePagePresenceTarget, type MachinePageTarget, type MachinePagePresenceTarget } from './useMachinePageTarget';

/**
 * What the machine page reads once and its Overview shows: the resolved machine, its managed record
 * (when Happier created it), and the page's refresh. Tab bodies of other plans need only their props.
 */
export type MachinePageState = Readonly<{
    target: MachinePageTarget;
    managedEnrolled: ReturnType<typeof useManagedEnrolledMachine>;
    /** Bumped by the page's refresh; sections that load their own data reload when it changes. */
    refreshKey: number;
    /** Reloads what the Overview shows (the unavailable banner's Retry and pull-to-refresh). */
    reload(): Promise<void>;
}>;

export const MachinePageStateContext = React.createContext<MachinePageState | null>(null);

export function useMachinePageState(): Omit<MachinePageState, 'target'> & Readonly<{ target: MachinePagePresenceTarget }> {
    const state = React.useContext(MachinePageStateContext);
    if (!state) throw new Error('useMachinePageState must be used inside MachinePageScreen');
    const target = useMachinePagePresenceTarget(state.target);
    return React.useMemo(() => ({ ...state, target }), [state, target]);
}

/**
 * The machine page's column, as All machines: the two doors' index and the page keep one edge, and the tabs'
 * tables, charts and maps get the room the lab draws them at. A page that draws its own scroller takes it too.
 */
export const MACHINE_PAGE_COLUMN: PageColumn = 'wide';

/**
 * What a page that draws its own virtualized scroller takes from the machine page: the page's header and tabs, which
 * lead that scroller, and the page's pull-to-refresh. Absent while the page's one `ItemList` scrolls, and for a body
 * rendered on its own.
 */
export type MachinePageListHost = Readonly<{ chrome: React.ReactElement; refreshControl: React.ReactElement }>;

export const MachinePageListHostContext = React.createContext<MachinePageListHost | null>(null);

export function useMachinePageListHost(): MachinePageListHost | null {
    return React.useContext(MachinePageListHostContext);
}
