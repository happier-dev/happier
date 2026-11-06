import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { matchesUsageSourceAccountingScope, type UsageSourceV1 } from '@happier-dev/protocol/usage/usageSources';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { resolveExternalSessionBrowseTargetForQualifiedSource } from '@/components/sessions/external/browse/resolveExternalSessionBrowseSourceOptions';
import { useExternalSessionBrowseCandidates, readExternalSessionBrowseCandidateKey } from '@/components/sessions/external/browse/useExternalSessionBrowseCandidates';
import { cancelExternalSessionCandidateOpen, openExternalSessionCandidate, type ExternalSessionCandidateOpenState } from '@/components/sessions/external/browse/openExternalSessionCandidate';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useActiveServerAccountScope, useActiveMachineFacts } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useUsageSourcesController } from './useUsageSources';

/**
 * A page that lists several Sources asks for browsing once: each Source registers while it waits for an
 * explicit browse, and one request opens every waiting Source in the page's own scope. A Source whose
 * root or consent changes later waits again, so the request never reaches a scope the user did not see.
 */
type OutsideBrowseRequests = Readonly<{ request: number; register: (key: string) => () => void }>;
const OutsideBrowseContext = React.createContext<OutsideBrowseRequests | null>(null);

/** Vendor-backed candidate titles require consent or an explicit browse; linking never enables capture. */
export function UsageExternalSessionCandidates(props: Readonly<{
    source: UsageSourceV1;
    lifetime: ServerAccountScopeLifetime;
    online: boolean;
    agentIds?: readonly string[];
    testID: string;
    visible?: boolean;
    children?: (candidates: React.ReactNode) => React.ReactNode;
}>) {
    const presentationActive = useLayoutPresentationActive();
    const projected = useDaemonMergedProjectionInputs({ machineId: props.source.machineId,
        serverId: props.lifetime.scope.serverId, enabled: props.online && props.lifetime.isCurrent() });
    const target = React.useMemo(() => {
        const resolved = projected.phase === 'ready' && props.source.externalSessionSource
            ? resolveExternalSessionBrowseTargetForQualifiedSource({ agent: props.source.agent,
                source: props.source.externalSessionSource, projection: projected.inputs?.pluginProjectionV2 }) : null;
        return resolved && (!props.agentIds?.length || props.agentIds.includes(resolved.agentId)) ? resolved : null;
    }, [projected.phase, projected.inputs, props.source.agent, props.source.externalSessionSource, props.agentIds]);
    // This mounted request is not capture consent. Its scope changes during render,
    // so a new root or consent transition cannot display the previous history.
    const browseScope = React.useMemo(() => ({ target, sourceId: props.source.sourceId,
        machineId: props.source.machineId, lifetime: props.lifetime }), [target, props.source.sourceId,
        props.source.machineId, props.source.root.kind, props.source.root.path, props.source.consent, props.lifetime]);
    const [browseIntent, setBrowseIntent] = React.useState<typeof browseScope | null>(null);
    const historyAllowed = props.source.consent === 'enabled' || browseIntent === browseScope;
    const pageBrowse = React.useContext(OutsideBrowseContext);
    const awaitingBrowse = !!target && !historyAllowed && props.online;
    const pageRegister = pageBrowse?.register;
    const registryKey = `${props.source.machineId}:${props.source.sourceId}`;
    React.useEffect(() => awaitingBrowse ? pageRegister?.(registryKey) : undefined, [awaitingBrowse, pageRegister, registryKey]);
    const handledRequest = React.useRef(pageBrowse?.request ?? 0);
    const pageRequest = pageBrowse?.request ?? 0;
    React.useEffect(() => {
        if (pageRequest === handledRequest.current) return;
        handledRequest.current = pageRequest;
        if (awaitingBrowse && props.lifetime.isCurrent()) setBrowseIntent(browseScope);
    }, [pageRequest]);
    const listing = useExternalSessionBrowseCandidates({ machineId: props.source.machineId,
        serverId: props.lifetime.scope.serverId, providerId: target?.agentId ?? null, source: target?.source ?? null,
        accountLifetime: props.lifetime, enabled: !!target && historyAllowed && props.online && props.lifetime.isCurrent() });
    const state = React.useRef<ExternalSessionCandidateOpenState>({ requestToken: 0, linkingCandidateKey: null });
    const [linking, setLinking] = React.useState<string | null>(null);
    const current = React.useRef({ target, browseScope, historyAllowed });
    current.current = { target, browseScope, historyAllowed };
    React.useEffect(() => {
        cancelExternalSessionCandidateOpen(state.current);
        setLinking(null);
        return () => { cancelExternalSessionCandidateOpen(state.current); };
    }, [browseScope, historyAllowed, presentationActive]);
    const router = useRouter();
    // The page's explicit Browse still reaches offscreen Sources; only their drawn controls defer.
    const render = (candidates: React.ReactNode) => props.children ? props.children(candidates) : candidates;
    if (props.visible === false || !target || !props.lifetime.isCurrent()) return render(null);
    if (!historyAllowed) return render(pageBrowse ? null : <View style={styles.action}><RoundButton size="small" display="inverted"
        title={t('externalSessions.browseTitle')} testID={`${props.testID}.browse`} disabled={!props.online}
        onPress={() => {
            if (current.current.browseScope === browseScope && props.lifetime.isCurrent()) {
                setBrowseIntent(browseScope);
            }
        }} /></View>);
    const outside = listing.candidates.filter(candidate => !candidate.linkedSessionId);
    if (!outside.length) return render(null);
    return render(<View testID={props.testID}>
        <Text accessibilityRole="header">{t('externalSessions.settingsTitle')}</Text>
        {outside.map(candidate => {
            const key = readExternalSessionBrowseCandidateKey(candidate);
            return <View key={key}>
                <Text numberOfLines={1}>{candidate.title ?? candidate.remoteSessionId}</Text>
                <RoundButton size="small" display="inverted" title={t('usage.board.sources.continueInHappier')}
                    testID={`${props.testID}.continue.${key}`} loading={linking === key}
                    disabled={!listing.candidatesAuthoritative || !props.online || linking !== null}
                    onPress={() => { void openExternalSessionCandidate({ candidate, agentId: target.agentId,
                        source: target.source, actionsAllowed: listing.candidatesAuthoritative, offline: !props.online,
                        isSelectionCurrent: () => current.current.browseScope === browseScope && current.current.historyAllowed && props.lifetime.isCurrent(),
                        accountCurrentness: props.lifetime,
                        resolveCurrentTarget: () => props.lifetime.isCurrent() ? { machineId: props.source.machineId,
                            serverId: props.lifetime.scope.serverId, accountId: props.lifetime.scope.accountId } : null,
                        state: state.current, onLinkingChange: setLinking,
                        openSession: sessionId => { router.push(buildScopedSessionRouteHref({ sessionId,
                            serverId: props.lifetime.scope.serverId }) as Parameters<typeof router.push>[0]); },
                    }); }} />
            </View>;
        })}
        {listing.nextCursor ? <View style={styles.action}><RoundButton size="small" display="inverted" title={t('common.next')}
            loading={listing.loadingMore} onPress={() => { void listing.loadMore(); }} /></View> : null}
    </View>);
}

function OutsideMachine(props: Readonly<{ machineId: string; online: boolean; lifetime: ServerAccountScopeLifetime;
    query: UsageQuery; testID: string }>) {
    const { controller, snapshot } = useUsageSourcesController({ machineId: props.machineId, lifetime: props.lifetime });
    React.useEffect(() => { if (controller && props.online) void controller.discover(); }, [controller, props.online]);
    return <View>{snapshot.sources.filter(source => source.externalSessionSource && matchesUsageSourceAccountingScope(source, props.query.sources))
        .map(source => <UsageExternalSessionCandidates key={source.sourceId} source={source} online={props.online}
            agentIds={props.query.agents} lifetime={props.lifetime} testID={`${props.testID}.${source.sourceId}`} />)}</View>;
}

/** The same admitted Source/candidate owners as Sources, restricted to the Work query's scope. */
export function UsageOutsideSessions(props: Readonly<{ serverId: string; query: UsageQuery; testID: string }>) {
    const scope = useActiveServerAccountScope();
    const lifetime = React.useMemo(() => {
        const captured = captureActiveServerAccountScopeLifetime();
        return captured?.scope.serverId === props.serverId ? captured : null;
    }, [scope?.serverId, scope?.accountId, props.serverId]);
    const machines = useActiveMachineFacts();
    useMachineReachabilityRevision();
    const nowMs = useMachinePresenceNowMs(machines);
    // These filters require accounting/session evidence candidates cannot establish; never broaden them.
    if (!lifetime || props.query.session !== null
        || props.query.projects.length || props.query.workspaceIds.length || props.query.modelIds.length || props.query.backendModes.length) return null;
    return <OutsideBrowsePage testID={props.testID}>{machines.filter(machine => !machine.revokedAt &&
        (!props.query.machines.length || props.query.machines.includes(machine.id))).map(machine =>
        <OutsideMachine key={machine.id} machineId={machine.id} online={lifetime.isCurrent() && isMachineSelectableForFleet(lifetime.scope, machine, nowMs)} lifetime={lifetime}
            query={props.query} testID={`${props.testID}.${machine.id}`} />)}</OutsideBrowsePage>;
}

export function OutsideBrowsePage(props: Readonly<{ testID: string; children: React.ReactNode }>) {
    const [waiting, setWaiting] = React.useState<ReadonlySet<string>>(() => new Set());
    const [request, setRequest] = React.useState(0);
    const register = React.useCallback((key: string) => {
        setWaiting(previous => new Set(previous).add(key));
        return () => setWaiting(previous => { const next = new Set(previous); next.delete(key); return next; });
    }, []);
    const requests = React.useMemo(() => ({ request, register }), [request, register]);
    return <View testID={props.testID}>
        {waiting.size > 0 ? <View style={styles.action}><RoundButton size="small" display="inverted"
            title={t('externalSessions.browseTitle')} testID={`${props.testID}.browse`}
            onPress={() => setRequest(count => count + 1)} /></View> : null}
        <OutsideBrowseContext.Provider value={requests}>{props.children}</OutsideBrowseContext.Provider>
    </View>;
}

const styles = StyleSheet.create({ action: { alignSelf: 'flex-start' } });
