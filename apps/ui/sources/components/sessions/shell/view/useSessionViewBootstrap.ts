import { useAppPaneScope, type AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import type { PaneScopeState } from '@/components/appShell/panes/model/appPaneReducer';
import { useWarmRepositoryDirectoryCacheOnSessionOpen } from '@/hooks/session/files/useWarmRepositoryDirectoryCacheOnSessionOpen';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';

export type UseSessionViewBootstrapInput = Readonly<{
    sessionId: string;
    serverId?: string | null;
    paneScopeId: string;
    sessionPath: string | null;
    sessionAccepted: boolean;
}>;

export type SessionViewPaneFacts = Readonly<{ details: ReturnType<typeof buildDetailsWorkspaceStateView> }>;
const paneFactsByDetails = new WeakMap<PaneScopeState['details'], SessionViewPaneFacts>();
/**
 * The pane facts the Session view reads: its Details workspace (the Board's visibility and the
 * presentation commands' press-time reads). A side-tab or bottom change keeps the same value; the
 * URL mirror reads the whole scope in its own leaf (`SessionPaneUrlSyncHost`).
 */
function selectSessionViewPaneFacts(scope: PaneScopeState | null): SessionViewPaneFacts | null {
    if (!scope) return null;
    let facts = paneFactsByDetails.get(scope.details);
    if (!facts) {
        facts = { details: buildDetailsWorkspaceStateView(scope.details) };
        paneFactsByDetails.set(scope.details, facts);
    }
    return facts;
}

export type UseSessionViewBootstrapResult = Readonly<{
    pane: Omit<AppPaneScopeApi, 'scopeState'> & { scopeState: SessionViewPaneFacts | null };
    machineReachable: boolean;
    machineReachability: 'reachable' | 'unreachable' | 'unknown';
}>;

export function useSessionViewBootstrap(input: UseSessionViewBootstrapInput): UseSessionViewBootstrapResult {
    const pane = useAppPaneScope(input.paneScopeId, selectSessionViewPaneFacts);
    const {
        machineReachable,
        machineOnline,
        machineReachability: observedMachineReachability,
    } = useSessionMachineReachability(input.sessionId, input.serverId);
    const machineReachability = observedMachineReachability
        ?? (machineReachable ? 'reachable' : 'unreachable');

    // Surface activation (visible/focused/anchored marks) belongs to the Session view's presence
    // leaf: a tab switch must not render this bootstrap's host.
    useWarmRepositoryDirectoryCacheOnSessionOpen({
        sessionId: input.sessionId,
        sessionPath: input.sessionAccepted ? input.sessionPath : null,
        machineOnline: input.sessionAccepted ? machineOnline : false,
    });

    return {
        pane,
        machineReachable,
        machineReachability,
    };
}
