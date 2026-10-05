import * as React from 'react';
import type { ChatFindSeed, FileFindSeedHostDestination, FileFindSeed as FindSeed } from './fileFindSeedHandoff';
import { useOptionalAppPaneContext } from './AppPaneProvider';
import { useDestinationFocus, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type FileFindSeedHostInput = Readonly<{ findSeed: FindSeed | null; consumeFindSeed: () => void }>;
export type ChatFindSeedHostInput = Readonly<{ findSeed: ChatFindSeed | null; consumeFindSeed: () => void }>;

const noSubscription = () => () => {};

export function ChatFindSeedHost(props: Readonly<{
    sessionId: string;
    serverId: string;
    active: boolean;
    children: (input: ChatFindSeedHostInput) => React.ReactNode;
}>): React.ReactNode {
    const handoff = useOptionalAppPaneContext()?.fileFindSeedHandoff;
    const focused = useDestinationFocus();
    const instanceKey = useDestinationInstanceKey();
    const destination = React.useMemo(() => ({ sessionId: props.sessionId, serverId: props.serverId }), [props.sessionId, props.serverId]);
    const identity = JSON.stringify([instanceKey, 'chat', props.sessionId, props.serverId]);
    const eligible = focused && props.active;
    const snapshot = React.useCallback(() => eligible ? handoff?.peekChatCurrent(destination) ?? null : null, [destination, eligible, handoff]);
    const take = React.useCallback(() => handoff?.takeChatCurrent(destination) ?? null, [destination, handoff]);
    return props.children(useDestinationFindSeed({ identity, eligible, subscribe: handoff?.subscribe, snapshot, take }));
}

export function FileFindSeedHost(props: Readonly<{
    destination: FileFindSeedHostDestination;
    active: boolean;
    children: (input: FileFindSeedHostInput) => React.ReactNode;
}>): React.ReactNode {
    const handoff = useOptionalAppPaneContext()?.fileFindSeedHandoff;
    const focused = useDestinationFocus();
    const instanceKey = useDestinationInstanceKey();
    const destination = React.useMemo(() => props.destination, [props.destination.host, props.destination.id,
        props.destination.path, props.destination.scope.serverId, props.destination.scope.machineId, props.destination.scope.rootPath]);
    const identity = JSON.stringify([instanceKey, destination.host, destination.id, destination.path,
        destination.scope.serverId, destination.scope.machineId, destination.scope.rootPath]);
    const eligible = focused && props.active;
    const snapshot = React.useCallback(() => eligible ? handoff?.peekCurrent(destination) ?? null : null, [destination, eligible, handoff]);
    const take = React.useCallback(() => handoff?.takeCurrent(destination) ?? null, [destination, handoff]);
    return props.children(useDestinationFindSeed({ identity, eligible, subscribe: handoff?.subscribe, snapshot, take }));
}

function useDestinationFindSeed<Seed>(params: Readonly<{
    identity: string;
    eligible: boolean;
    subscribe?: (listener: () => void) => () => void;
    snapshot: () => Seed | null;
    take: () => Readonly<{ seed: Seed; authority: ServerAccountScopeLifetime }> | null;
}>): Readonly<{ findSeed: Seed | null; consumeFindSeed: () => void }> {
    const { identity, eligible, snapshot, take } = params;
    const pending = React.useSyncExternalStore(params.subscribe ?? noSubscription, snapshot, () => null);
    const [launch, setLaunch] = React.useState<Readonly<{ identity: string; seed: Seed; authority: ServerAccountScopeLifetime }> | null>(null);

    // The mounted destination retains launch input while its content loads lazily.
    React.useLayoutEffect(() => { setLaunch(null); }, [identity]);
    React.useLayoutEffect(() => {
        if (!pending) return;
        const taken = take();
        if (taken) setLaunch({ identity, ...taken });
    }, [identity, pending, take]);
    React.useEffect(() => {
        if (!launch) return;
        const retirement = launch.authority.onRetire(() => { setLaunch((current) => current === launch ? null : current); });
        return () => retirement.dispose();
    }, [launch]);
    const consumeFindSeed = React.useCallback(() => { setLaunch((current) => current === launch ? null : current); }, [launch]);
    const findSeed = eligible && launch && launch.identity === identity && launch.authority.isCurrent()
        ? launch.seed : null;
    return { findSeed, consumeFindSeed };
}
