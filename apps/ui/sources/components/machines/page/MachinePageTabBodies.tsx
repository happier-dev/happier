import * as React from 'react';

import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';

import type { MachinePageTabEntry } from './machinePageTabs';
import type { MachinePageTabBodyProps, MachinePageTabId, MachinePageTabParams } from './machinePageTabQuery';

import { useMachinePageOnline } from './useMachinePageTarget';

type TabBodyBase = Omit<MachinePageTabBodyProps, 'params' | 'barAccessoryShown' | 'online'>;

/**
 * The machine page's tab bodies under the tab bar, then the block that closes a tab's root (the page's Ask an agent).
 * A tab, once opened, stays mounted while another tab shows: hidden, it takes no space, focus or screen-reader
 * attention, and its presentation work (live vitals demand, the embedded composer) stops through the retained
 * surface's presentation fact. Returning to it shows the same tree, with the params it was left on, instead of
 * rebuilding it. The route stays the only owner of which tab is open; another machine starts over.
 */
export function MachinePageTabBodies(props: Readonly<{
    tabs: readonly MachinePageTabEntry[];
    active: Readonly<{ entry: MachinePageTabEntry; params: MachinePageTabParams }>;
    body: TabBodyBase;
    /** Whether a wide page draws the tabs' accessories in the tab bar (each body then leaves its own out). */
    barAccessoriesInBar: boolean;
    footer: React.ReactNode;
    footerShown: boolean;
}>) {
    const { entry: activeEntry, params: activeParams } = props.active;
    // The params each opened tab was last shown with, for this machine only.
    const scope = `${props.body.serverId}\u0000${props.body.machineId}`;
    const retained = React.useRef<{ scope: string; params: Map<MachinePageTabId, MachinePageTabParams> }>({ scope, params: new Map() });
    if (retained.current.scope !== scope) retained.current = { scope, params: new Map() };
    retained.current.params.set(activeEntry.id, activeParams);
    const opened = retained.current.params;
    return (
        <>
            {props.tabs.map(entry => {
                const params = opened.get(entry.id);
                if (!params) return null;
                return (
                    <RetainedTabBody
                        key={entry.id}
                        entry={entry}
                        params={params}
                        active={entry.id === activeEntry.id}
                        body={props.body}
                        barAccessoryShown={props.barAccessoriesInBar && entry.BarAccessory !== undefined}
                    />
                );
            })}
            <RetainedPanelSurface mode="content" isActive={props.footerShown} testID="machine-page-tab-footer">
                {props.footer}
            </RetainedPanelSurface>
        </>
    );
}

const RetainedTabBody = React.memo(function RetainedTabBody(props: Readonly<{
    entry: MachinePageTabEntry;
    params: MachinePageTabParams;
    active: boolean;
    body: TabBodyBase;
    barAccessoryShown: boolean;
}>) {
    const Body = props.entry.Body;
    const online = useMachinePageOnline(props.body.serverId, props.body.machineId);
    return (
        <RetainedPanelSurface mode="content" isActive={props.active}
            suspendWhenHidden={props.entry.suspendWhenHidden}
            testID={`machine-page-tab-body.${props.entry.id}`}>
            <Body {...props.body} online={online} params={props.params} barAccessoryShown={props.barAccessoryShown} />
        </RetainedPanelSurface>
    );
});
