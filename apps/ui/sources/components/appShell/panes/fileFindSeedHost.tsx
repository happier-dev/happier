import * as React from 'react';
import type { ChatFindSeed, FileFindSeedHostDestination, FileFindSeed as FindSeed } from './fileFindSeedHandoff';
import { useOptionalAppPaneContext } from './AppPaneProvider';
import { useDestinationFocus, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useDestinationFocusSignal } from '@/components/appShell/workspace/destinationInstanceContext';
import { allSignals, useBooleanSignal, type LayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type FileFindSeedHostInput = Readonly<{ findSeed: FindSeed | null; consumeFindSeed: () => void }>;
export type ChatFindSeedHostInput = Readonly<{ findSeed: ChatFindSeed | null; consumeFindSeed: () => void }>;

const noSubscription = () => () => {};

export function ChatFindSeedHost(props: Readonly<{
    sessionId: string;
    serverId: string;
    /** The transcript surface's Find eligibility, followed by subscription (this host adds its destination's focus). */
    eligible: LayoutPresentationSignal;
    children: (input: ChatFindSeedHostInput) => React.ReactNode;
}>): React.ReactNode {
    const handoff = useOptionalAppPaneContext(value => value.fileFindSeedHandoff);
    const instanceKey = useDestinationInstanceKey();
    const destination = React.useMemo(() => ({ sessionId: props.sessionId, serverId: props.serverId }), [props.sessionId, props.serverId]);
    const identity = JSON.stringify([instanceKey, 'chat', props.sessionId, props.serverId]);
    const focus = useDestinationFocusSignal();
    const eligible = React.useMemo(() => allSignals(focus, props.eligible), [focus, props.eligible]);
    const snapshot = React.useCallback(() => eligible.get() ? handoff?.peekChatCurrent(destination) ?? null : null, [destination, eligible, handoff]);
    const take = React.useCallback(() => handoff?.takeChatCurrent(destination) ?? null, [destination, handoff]);
    return props.children(useDestinationFindSeed({ identity, eligible, subscribe: handoff?.subscribe, snapshot, take }));
}

export function FileFindSeedHost(props: Readonly<{
    destination: FileFindSeedHostDestination;
    active: boolean;
    children: (input: FileFindSeedHostInput) => React.ReactNode;
}>): React.ReactNode {
    const handoff = useOptionalAppPaneContext(value => value.fileFindSeedHandoff);
    const focused = useDestinationFocus();
    const instanceKey = useDestinationInstanceKey();
    const destination = React.useMemo(() => props.destination, [props.destination.host, props.destination.id,
        props.destination.path, props.destination.scope.serverId, props.destination.scope.machineId, props.destination.scope.rootPath]);
    const identity = JSON.stringify([instanceKey, destination.host, destination.id, destination.path,
        destination.scope.serverId, destination.scope.machineId, destination.scope.rootPath]);
    const eligible = useBooleanSignal(focused && props.active);
    const snapshot = React.useCallback(() => eligible.get() ? handoff?.peekCurrent(destination) ?? null : null, [destination, eligible, handoff]);
    const take = React.useCallback(() => handoff?.takeCurrent(destination) ?? null, [destination, handoff]);
    return props.children(useDestinationFindSeed({ identity, eligible, subscribe: handoff?.subscribe, snapshot, take }));
}

const never = () => false;

function useDestinationFindSeed<Seed>(params: Readonly<{
    identity: string;
    eligible: LayoutPresentationSignal;
    subscribe?: (listener: () => void) => () => void;
    snapshot: () => Seed | null;
    take: () => Readonly<{ seed: Seed; authority: ServerAccountScopeLifetime }> | null;
}>): Readonly<{ findSeed: Seed | null; consumeFindSeed: () => void }> {
    const { identity, eligible, snapshot, take } = params;
    // Eligibility gates the peek, so the hand-off is re-read when either moves; an unchanged (empty) peek renders nothing.
    const handoffSubscribe = params.subscribe ?? noSubscription;
    const subscribe = React.useCallback((listener: () => void) => {
        const unsubscribeHandoff = handoffSubscribe(listener);
        const unsubscribeEligible = eligible.subscribe(listener);
        return () => { unsubscribeHandoff(); unsubscribeEligible(); };
    }, [eligible, handoffSubscribe]);
    const pending = React.useSyncExternalStore(subscribe, snapshot, () => null);
    const [launch, setLaunch] = React.useState<Readonly<{ identity: string; seed: Seed; authority: ServerAccountScopeLifetime }> | null>(null);

    // Suspense reconnects layout effects for the same mounted destination. Its
    // seed has already left the handoff, so only a different identity clears it.
    React.useLayoutEffect(() => { setLaunch(current => current?.identity === identity ? current : null); }, [identity]);
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
    // Eligibility is a render input only while a launched seed waits for it.
    const launchEligible = React.useSyncExternalStore(launch ? eligible.subscribe : noSubscription, launch ? eligible.get : never, never);
    const findSeed = launchEligible && launch && launch.identity === identity && launch.authority.isCurrent()
        ? launch.seed : null;
    return { findSeed, consumeFindSeed };
}
