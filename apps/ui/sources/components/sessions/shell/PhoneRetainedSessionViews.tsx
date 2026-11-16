import * as React from 'react';
import { useLocalSearchParams, usePathname } from 'expo-router';

import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useOptionalWorkspaceNavigation, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import type { WorkspaceTab } from '@/components/appShell/workspace/workspaceState';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';

/**
 * The Session route layout's qualified address when its native screen keeps presented Sessions mounted
 * (a phone's stack, where the workspace tracks tabs but does not host them); null when the layout keys a
 * single Session view by its address instead.
 */
const SessionRouteRetainedAddressContext = React.createContext<SessionAddress | null>(null);
export const SessionRouteRetainedAddressProvider = SessionRouteRetainedAddressContext.Provider;
export function useSessionRouteRetainedAddress(): SessionAddress | null {
    return React.useContext(SessionRouteRetainedAddressContext);
}

type RetainedSession = Readonly<{
    key: string;
    address: SessionAddress;
    target: DestinationRef;
    pathname: string;
}>;
type RetainedSessions = ReadonlyMap<string, RetainedSession>;

const selectPhoneTabs = (workspace: WorkspaceNavigationContextValue | null): Readonly<Record<string, WorkspaceTab>> | null =>
    workspace?.phone ? workspace.state.tabs : null;

function listsSession(tabs: Readonly<Record<string, WorkspaceTab>>, address: SessionAddress): boolean {
    for (const tab of Object.values(tabs)) {
        if (tab.target.kind === 'session' && tab.target.params.id === address.sessionId
            && areServerProfileIdentifiersEquivalent(tab.target.params.serverId, address.serverId)) return true;
    }
    return false;
}

/** The route's own query (strings only), qualified with the layout's exact address. */
function readSessionTarget(params: Readonly<Record<string, unknown>>, address: SessionAddress): DestinationRef {
    const strings: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) if (typeof value === 'string') strings[key] = value;
    return { kind: 'session', params: { ...strings, id: address.sessionId, serverId: address.serverId } };
}

function sameTarget(left: DestinationRef, right: DestinationRef): boolean {
    const leftKeys = Object.keys(left.params);
    return left.kind === right.kind && leftKeys.length === Object.keys(right.params).length
        && leftKeys.every(key => left.params[key] === right.params[key]);
}

/**
 * The presented Session plus the Sessions presented before it that the phone's workspace still lists as tabs.
 * This is the retention rule web tabs follow (`SplitCanvasHost`): a layer from its first presentation while it
 * stays listed. Returns `previous` when nothing changed, so a render that changes nothing adjusts no state.
 */
function retainSessions(previous: RetainedSessions, current: RetainedSession,
    tabs: Readonly<Record<string, WorkspaceTab>> | null): RetainedSessions {
    let changed = false;
    const next = new Map<string, RetainedSession>();
    for (const [key, member] of previous) {
        if (key === current.key) {
            const kept = member.pathname === current.pathname && sameTarget(member.target, current.target) ? member : current;
            changed ||= kept !== member;
            next.set(key, kept);
        } else if (tabs && listsSession(tabs, member.address)) {
            next.set(key, member);
        } else {
            changed = true;
        }
    }
    if (!next.has(current.key)) {
        next.set(current.key, current);
        changed = true;
    }
    return changed ? next : previous;
}

/**
 * The Session route's body on a phone's stack. Switching to another Session keeps the screen (one Expo route),
 * so every Session presented there stays mounted while its tab is listed: going back to one shows its
 * retained view (scroll, draft, focus) instead of rebuilding it. Each body gets its own params, focus and
 * visibility from a stack-owned destination instance; hidden ones withdraw through the presentation owner.
 */
export function PhoneRetainedSessionViews(props: Readonly<{ address: SessionAddress; body: React.ReactElement }>): React.ReactElement {
    // Outside any destination instance, these are the Expo route's own query and path.
    const params = useLocalSearchParams();
    const pathname = usePathname();
    const screenFocused = useOptionalScreenIsFocused();
    const tabs = useOptionalWorkspaceNavigation(selectPhoneTabs);
    const currentKey = sessionAddressKey(props.address);
    const current: RetainedSession = {
        key: currentKey,
        address: props.address,
        target: readSessionTarget(params, props.address),
        pathname,
    };
    const [retained, setRetained] = React.useState<RetainedSessions>(() => new Map([[currentKey, current]]));
    const next = retainSessions(retained, current, tabs);
    if (next !== retained) setRetained(next);
    return <>
        {[...next.values()].map(member => <PhoneRetainedSession key={member.key} member={member}
            active={member.key === currentKey} focused={member.key === currentKey && screenFocused} body={props.body} />)}
    </>;
}

const PhoneRetainedSession = React.memo(function PhoneRetainedSession(props: Readonly<{
    member: RetainedSession;
    active: boolean;
    focused: boolean;
    body: React.ReactElement;
}>) {
    return <RetainedPanelSurface isActive={props.active} mode="flow" suspendWhenHidden>
        <DestinationInstanceHost stackOwned tabId={`phone-session:${props.member.key}`} ref={props.member.target}
            pathname={props.member.pathname} focused={props.focused} visible={props.active}>
            {props.body}
        </DestinationInstanceHost>
    </RetainedPanelSurface>;
});
