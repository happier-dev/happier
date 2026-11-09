import * as React from 'react';

import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';

import type { MachinePageTabEntry } from './machinePageTabs';
import { machinePageTabEntryKey } from './machinePageTabQuery';
import type { MachinePageTabBodyProps, MachinePageTabParams } from './machinePageTabQuery';
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
    /**
     * The active body draws its own scroller and fills the height the page gives it, instead of sitting in the
     * page's scroll. It is then the only body: the other tabs are not kept beneath it, since the page's change of
     * scroller remounts them anyway when the page returns to its own scroll.
     */
    scrollOwned?: boolean;
}>) {
    const { entry: activeEntry, params: activeParams } = props.active;
    // The params each opened tab was last shown with, for this machine only.
    const scope = `${props.body.serverId}\u0000${props.body.machineId}`;
    const retained = React.useRef<{ scope: string; params: Map<string, MachinePageTabParams> }>({ scope, params: new Map() });
    if (retained.current.scope !== scope) retained.current = { scope, params: new Map() };
    const activeKey = machinePageTabEntryKey(activeEntry);
    retained.current.params.set(activeKey, activeParams);
    const opened = retained.current.params;
    // A linked plugin page the catalog does not list yet still mounts, so its own state can say why.
    const tabs = props.tabs.some(entry => machinePageTabEntryKey(entry) === activeKey) ? props.tabs : [...props.tabs, activeEntry];
    return (
        <>
            {tabs.map(entry => {
                const key = machinePageTabEntryKey(entry);
                if (props.scrollOwned === true && key !== activeKey) return null;
                const params = opened.get(key);
                if (!params) return null;
                return (
                    <RetainedTabBody
                        key={key}
                        entry={entry}
                        params={params}
                        active={key === activeKey}
                        scrollOwned={props.scrollOwned === true}
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
    scrollOwned: boolean;
    body: TabBodyBase;
    barAccessoryShown: boolean;
}>) {
    const Body = props.entry.Body;
    const online = useMachinePageOnline(props.body.serverId, props.body.machineId);
    return (
        <RetainedPanelSurface mode={props.scrollOwned ? 'flow' : 'content'} isActive={props.active}
            suspendWhenHidden={props.entry.suspendWhenHidden}
            testID={`machine-page-tab-body.${machinePageTabEntryKey(props.entry)}`}>
            <Body {...props.body} online={online} params={props.params} barAccessoryShown={props.barAccessoryShown} />
        </RetainedPanelSurface>
    );
});
