import * as React from 'react';
import { useAppShellPluginUiDeclarationSources } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { useOptionalBotsRosterRuntime } from '@/components/sessions/bots/BotsRosterRuntime';
import {
    commitCompactAppDestinationSources, readCommittedCompactAppDestinations, isCompactDestinationSourcePublished,
    subscribeCompactAppDestinations, type AppDestinationActivationOwners, type AppBuiltinDestinationAvailability,
    type CompactAppDestinationSources, type CompactAppDestination,
} from './compactAppDestinationCatalog';

function useAppBuiltinDestinationAvailability(owners: AppDestinationActivationOwners): AppBuiltinDestinationAvailability {
    // The external-session feature decision also controls the Sessions list source condition.
    const externalSessions = useFeatureDecision('sessions.direct')?.state === 'enabled';
    const inbox = useInboxAvailable();
    const discussions = useFeatureDecision('sessions.conversations')?.state === 'enabled';
    const bots = useFeatureDecision('bots')?.state === 'enabled';
    const search = useFeatureDecision('search')?.state === 'enabled';
    // Listed while discoverable, including a local-policy disablement whose repair it leads to.
    const workflows = useWorkflowsDestinationAccess().discoverable;
    const friends = useFriendsEnabled();
    // The roster opens from the app-wide runtime (rail anchor or sheet); an explicit owner overrides it.
    const botsRosterRuntime = useOptionalBotsRosterRuntime();
    const botsRoster = (owners.openBotsRoster ?? botsRosterRuntime?.open) !== undefined;
    return React.useMemo(
        () => ({ externalSessions, inbox, discussions, workflows, friends, bots, botsRoster, search }),
        [externalSessions, friends, inbox, discussions, workflows, bots, botsRoster, search],
    );
}

/** Source admission is shared by row readers and the workspace's initial-readiness gate. */
function useCompactDestinationSource(owners: AppDestinationActivationOwners) {
    const { projection, accountLifetime, ready } = useAppShellPluginUiDeclarationSources();
    const locale = usePreferredLanguage();
    const builtins = useAppBuiltinDestinationAvailability(owners);
    const source = React.useMemo<CompactAppDestinationSources>(() => ({ projection, accountLifetime, ready, locale, builtins }),
        [projection, accountLifetime, ready, locale, builtins]);
    const subscribe = React.useCallback((listener: () => void) => subscribeCompactAppDestinations(source, listener), [source]);
    const read = React.useCallback(() => readCommittedCompactAppDestinations(source), [source]);
    const readReady = React.useCallback(() => isCompactDestinationSourcePublished(source), [source]);
    React.useEffect(() => { commitCompactAppDestinationSources(source); }, [source]);
    return { source, subscribe, read, readReady };
}

/** Initial Account readiness is consumed by the workspace/deep-link admission gate. */
export function useCompactAppDestinationCatalog(owners: AppDestinationActivationOwners = {}): Readonly<{
    destinations: readonly CompactAppDestination[];
    ready: boolean;
    accountLifetime: CompactAppDestinationSources['accountLifetime'];
}> {
    const { source, subscribe, read, readReady } = useCompactDestinationSource(owners);
    const destinations = React.useSyncExternalStore(subscribe, read, read);
    const admittedLifetime = React.useRef<typeof source.accountLifetime | undefined>(undefined);
    // An admitted Account retains its rows while later declarations publish.
    // Exact-source bookkeeping must not wake the shell when those rows are equal.
    const ready = readReady() || (source.ready !== false && admittedLifetime.current === source.accountLifetime);
    const [, refreshAdmission] = React.useReducer((value: number) => value + 1, 0);
    React.useLayoutEffect(() => {
        // A first navigator must not paint blank or consume its deep link before this
        // Account's exact catalog is admitted. A mounted Account retains its rows;
        // its later publications use the passive producer above.
        if (admittedLifetime.current === source.accountLifetime) return;
        commitCompactAppDestinationSources(source);
        if (readReady()) admittedLifetime.current = source.accountLifetime;
        // uSES subscribes passively on mount. Flush only changed first admission
        // before paint; retained rows need no readiness-only subscription.
        if (destinations !== read() || ready !== readReady()) refreshAdmission();
    }, [destinations, read, readReady, ready, source]);
    return { destinations, ready, accountLifetime: source.accountLifetime };
}

/** Row consumers do not subscribe to publication readiness. */
export function useCompactAppDestinations(owners: AppDestinationActivationOwners = {}): readonly CompactAppDestination[] {
    const { subscribe, read } = useCompactDestinationSource(owners);
    return React.useSyncExternalStore(subscribe, read, read);
}
