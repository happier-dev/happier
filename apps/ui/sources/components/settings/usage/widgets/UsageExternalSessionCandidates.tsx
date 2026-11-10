import * as React from 'react';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { matchesUsageSourceAccountingScope, type UsageSourceV1 } from '@happier-dev/protocol/usage/usageSources';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
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
import { useCurrentUiContextCommandBridge, useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

/**
 * A page that lists several Sources asks for browsing once: each Source registers while it waits for an
 * explicit browse, and one request opens every waiting Source in the page's own scope. A Source whose
 * root or consent changes later waits again, so the request never reaches a scope the user did not see.
 */
type OutsideBrowseRequest = Readonly<{ revision: number; callerContext?: ActionExecutorContext }>;
type OutsideBrowseRequests = Readonly<{ request: OutsideBrowseRequest; register: (key: string) => () => void;
    /** A Source that may wait for Browse once its Agent projection answers: the page holds the button's row meanwhile. */
    expect: (key: string) => () => void }>;
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
    const commandBridge = useCurrentUiContextCommandBridge();
    const projected = useDaemonMergedProjectionInputs({ machineId: props.source.machineId,
        serverId: props.lifetime.scope.serverId, enabled: props.online && props.lifetime.isCurrent(),
        sections: DAEMON_AGENT_CATALOG_SECTIONS });
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
    const [browseIntent, setBrowseIntent] = React.useState<Readonly<{ scope: typeof browseScope; callerContext?: ActionExecutorContext }> | null>(null);
    const historyAllowed = props.source.consent === 'enabled' || browseIntent?.scope === browseScope;
    const pageBrowse = React.useContext(OutsideBrowseContext);
    const awaitingBrowse = !!target && !historyAllowed && props.online;
    const pageRegister = pageBrowse?.register;
    const registryKey = `${props.source.machineId}:${props.source.sourceId}`;
    React.useEffect(() => awaitingBrowse ? pageRegister?.(registryKey) : undefined, [awaitingBrowse, pageRegister, registryKey]);
    // Before the paint: a Source whose browse target is still being read may wait for Browse, so the page holds the
    // button's row from its first frame instead of the button pushing the sources down when the projection answers (R142).
    const mayAwaitBrowse = !!props.source.externalSessionSource && !historyAllowed && props.online
        && (projected.phase === 'idle' || projected.phase === 'loading');
    const pageExpect = pageBrowse?.expect;
    React.useLayoutEffect(() => mayAwaitBrowse ? pageExpect?.(registryKey) : undefined, [mayAwaitBrowse, pageExpect, registryKey]);
    const handledRequest = React.useRef(pageBrowse?.request);
    const pageRequest = pageBrowse?.request;
    React.useEffect(() => {
        if (pageRequest === handledRequest.current) return;
        handledRequest.current = pageRequest;
        if (awaitingBrowse && props.lifetime.isCurrent()) setBrowseIntent({ scope: browseScope, callerContext: pageRequest?.callerContext });
    }, [pageRequest]);
    const listing = useExternalSessionBrowseCandidates({ machineId: props.source.machineId,
        serverId: props.lifetime.scope.serverId, providerId: target?.agentId ?? null, source: target?.source ?? null,
        accountLifetime: props.lifetime, callerContext: browseIntent?.scope === browseScope ? browseIntent.callerContext : undefined,
        enabled: !!target && historyAllowed && props.online && props.lifetime.isCurrent() });
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
    const visible = props.visible !== false && !!target && props.lifetime.isCurrent();
    const outside = visible && historyAllowed ? listing.candidates.filter(candidate => !candidate.linkedSessionId) : [];
    const canContinue = listing.candidatesAuthoritative && props.online && linking === null;
    const commands = useCurrentUiContextLocalCommands([
        ...(visible && !historyAllowed && !pageBrowse && props.online ? [{ key: 'browse', title: t('externalSessions.browseTitle'),
            invoke: (_input, context) => {
                if (current.current.browseScope !== browseScope || !props.lifetime.isCurrent()) return false;
                setBrowseIntent({ scope: browseScope, callerContext: context });
            } }] : []),
        ...(listing.candidatesAuthoritative && props.online && target ? outside.map(candidate => ({ key: `continue:${readExternalSessionBrowseCandidateKey(candidate)}`,
            title: `${t('usage.board.sources.continueInHappier')}: ${candidate.title ?? candidate.remoteSessionId}`,
            invoke: async (_input, context) => {
                const outcome = await openExternalSessionCandidate({ candidate, agentId: target.agentId,
                    source: target.source, actionsAllowed: listing.candidatesAuthoritative, offline: !props.online,
                    isSelectionCurrent: () => current.current.browseScope === browseScope && current.current.historyAllowed && props.lifetime.isCurrent(),
                    accountCurrentness: props.lifetime, actionContext: context, commandBridge,
                    resolveCurrentTarget: () => props.lifetime.isCurrent() ? { machineId: props.source.machineId,
                        serverId: props.lifetime.scope.serverId, accountId: props.lifetime.scope.accountId } : null,
                    state: state.current, onLinkingChange: setLinking,
                    openSession: sessionId => { router.push(buildScopedSessionRouteHref({ sessionId,
                        serverId: props.lifetime.scope.serverId }) as Parameters<typeof router.push>[0]); },
                });
                return outcome === 'opened' ? { ok: true as const } : { ok: false as const, code: 'unavailable' as const };
            } })) : []),
        ...(outside.length && listing.nextCursor && !listing.loadingMore ? [{ key: 'next',
            title: `${t('externalSessions.settingsTitle')}: ${t('common.next')}`, invoke: async (_input, context) => { await listing.loadMore(context); } }] : []),
    ], { contextKey: JSON.stringify([props.source.machineId, props.source.sourceId, props.source.root, props.source.consent]) });
    // The page's explicit Browse still reaches offscreen Sources; only their drawn controls defer.
    const render = (candidates: React.ReactNode) => props.children ? props.children(candidates) : candidates;
    if (!visible) return render(null);
    if (!historyAllowed) return render(pageBrowse ? null : <View style={styles.action}><RoundButton size="small" display="inverted"
        title={t('externalSessions.browseTitle')} testID={`${props.testID}.browse`} disabled={!props.online}
        onPress={() => { void commands.invoke('browse'); }} /></View>);
    if (!outside.length) return render(null);
    return render(<View testID={props.testID}>
        <Text accessibilityRole="header">{t('externalSessions.settingsTitle')}</Text>
        {outside.map(candidate => {
            const key = readExternalSessionBrowseCandidateKey(candidate);
            return <View key={key}>
                <Text numberOfLines={1}>{candidate.title ?? candidate.remoteSessionId}</Text>
                <RoundButton size="small" display="inverted" title={t('usage.board.sources.continueInHappier')}
                    testID={`${props.testID}.continue.${key}`} loading={linking === key}
                    disabled={!canContinue}
                    onPress={() => { void commands.invoke(`continue:${key}`); }} />
            </View>;
        })}
        {listing.nextCursor ? <View style={styles.action}><RoundButton size="small" display="inverted" title={t('common.next')}
            loading={listing.loadingMore} onPress={() => { void commands.invoke('next'); }} /></View> : null}
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
    const [expected, setExpected] = React.useState<ReadonlySet<string>>(() => new Set());
    const [request, setRequest] = React.useState<OutsideBrowseRequest>({ revision: 0 });
    const register = React.useCallback((key: string) => {
        setWaiting(previous => new Set(previous).add(key));
        return () => setWaiting(previous => { const next = new Set(previous); next.delete(key); return next; });
    }, []);
    const expect = React.useCallback((key: string) => {
        setExpected(previous => new Set(previous).add(key));
        return () => setExpected(previous => { const next = new Set(previous); next.delete(key); return next; });
    }, []);
    const requests = React.useMemo(() => ({ request, register, expect }), [request, register, expect]);
    const commands = useCurrentUiContextLocalCommands(waiting.size > 0 ? [{ key: 'browse',
        title: t('externalSessions.browseTitle'), invoke: (_input, context) => setRequest(previous => ({ revision: previous.revision + 1,
            callerContext: context })) }] : []);
    return <View testID={props.testID}>
        {/* The row is held at the button's drawn height while a Source may still wait for Browse; never an empty control. */}
        {waiting.size > 0 || expected.size > 0 ? <View testID={`${props.testID}.browseRow`} style={styles.action}>
            {waiting.size > 0 ? <RoundButton size="small" display="inverted"
                title={t('externalSessions.browseTitle')} testID={`${props.testID}.browse`}
                onPress={() => { void commands.invoke('browse'); }} /> : null}
        </View> : null}
        <OutsideBrowseContext.Provider value={requests}>{props.children}</OutsideBrowseContext.Provider>
    </View>;
}

const styles = StyleSheet.create({ action: { alignSelf: 'flex-start', minHeight: HAPPIER_PAGE_METRICS.smallControlHeightPx } });
