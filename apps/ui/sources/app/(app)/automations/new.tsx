import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import NewSessionScreen from '@/app/(app)/new/index';
import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import {
    areExactTurnAutomationPrefillsEqual,
    buildExactTurnAutomationRouteParams,
    parseExactTurnAutomationPrefillRoute,
    readExactActiveParentTurn,
    type ExactTurnAutomationPrefill,
} from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { createAutomationEditorTriggerClientId } from '@/sync/domains/automations/automationEditorDraft';
import { captureSessionAutomationAuthority } from '@/sync/domains/automations/sessionAutomationAuthority';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { isSessionRouteHydrationAvailable } from '@/sync/domains/session/sessionRouteHydrationState';
import { storage, useActiveServerAccountScope, useSession } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { storeTempData } from '@/utils/sessions/tempDataStore';

/**
 * Direct plural-create host. The incumbent New Session screen remains the one
 * recipe/target composer; this route seeds its durable draft once and mounts it
 * in place instead of redirecting to a second Automation authoring surface.
 */
type RouteParams = Readonly<{
    draftId?: string;
    dataId?: string;
    automation?: string;
    sourceSessionId?: string;
    sourceTurnId?: string;
    sourceServerId?: string;
}>;

function NewAutomationComposerHost(props: Readonly<{
    params: RouteParams;
    observed: ExactTurnAutomationPrefill | null;
    exactTurnRetargetRequest?: ExactTurnAutomationPrefill | null;
}>) {
    const router = useRouter();
    const [seed] = React.useState(() => {
        if (props.params.dataId && props.params.automation === '1') return null;
        const automationDraft = {
            enabled: true,
            name: '',
            description: '',
            triggers: props.observed ? [{
                clientId: createAutomationEditorTriggerClientId(),
                definition: {
                    kind: 'sessionLifecycle' as const,
                    enabled: true,
                    event: 'parentTurnCompleted' as const,
                    scope: {
                        kind: 'exactTurn' as const,
                        sourceSessionId: props.observed.sourceSessionId,
                        sourceTurnId: props.observed.sourceTurnId,
                    },
                    consumption: 'once' as const,
                },
            }] : [],
        };
        return {
            draftId: resolveNewSessionDraftRouteIdentity({ routeDraftId: props.params.draftId }).draftId,
            dataId: storeTempData({ automationDraft }),
        };
    });
    React.useEffect(() => {
        if (!seed) return;
        router.setParams({ automation: '1', draftId: seed.draftId, dataId: seed.dataId });
    }, [router, seed]);

    if (seed && (
        props.params.automation !== '1'
        || props.params.draftId !== seed.draftId
        || props.params.dataId !== seed.dataId
    )) {
        return null;
    }
    return (
        <AutomationsGate>
            <NewSessionScreen automationExactTurnRetarget={props.exactTurnRetargetRequest ?? null} />
        </AutomationsGate>
    );
}

function ExactTurnNewAutomationRoute(props: Readonly<{
    params: RouteParams;
    observed: ExactTurnAutomationPrefill;
}>) {
    const router = useRouter();
    const hydration = useHydrateSessionForRoute(
        props.observed.sourceSessionId,
        'NewAutomationRoute.hydrateExactTurnSource',
        { serverId: props.observed.sourceServerId },
    );
    const sourceSession = useSession(props.observed.sourceSessionId);
    const activeAccountScope = useActiveServerAccountScope();
    const support = useAutomationsSupport({ scopeKind: 'spawn', serverId: props.observed.sourceServerId });
    const supportRef = React.useRef(support.enabled);
    supportRef.current = support.enabled;
    const [retired, setRetired] = React.useState(false);
    // The mounted exact-turn binding is established at mount and changes only
    // through the explicit adopt-current-turn action. Route params remain URL
    // truth but are never the mutation owner for the mounted composer draft.
    const [binding, setBinding] = React.useState<ExactTurnAutomationPrefill>(props.observed);
    const [retargetRequest, setRetargetRequest] = React.useState<ExactTurnAutomationPrefill | null>(null);
    const accountScopeKey = activeAccountScope ? serverAccountScopeKeySuffix(activeAccountScope) : null;
    const authority = React.useMemo(() => captureSessionAutomationAuthority({
        // Capture-time identity facts only; isCurrent() re-reads live store
        // truth. Keying the memo on the render-phase Session object would
        // rebuild the authority (and resubscribe its retire binding) on every
        // transcript update of the running source turn. The Account-scope key
        // (serverId+accountId) is the semantic Account identity, so a
        // same-server Account switch rebinds instead of staying retired.
        session: storage.getState().sessions[props.observed.sourceSessionId] ?? null,
        routeSessionId: props.observed.sourceSessionId,
        routeServerId: props.observed.sourceServerId,
        activeServerId: getActiveServerSnapshot().serverId,
        automationsEnabled: support.enabled,
        accountLifetime: captureActiveServerAccountScopeLifetime(),
        readCurrent: () => ({
            session: storage.getState().sessions[props.observed.sourceSessionId] ?? null,
            routeSessionId: props.observed.sourceSessionId,
            routeServerId: props.observed.sourceServerId,
            activeServerId: getActiveServerSnapshot().serverId,
            automationsEnabled: supportRef.current,
        }),
    }), [
        accountScopeKey,
        props.observed.sourceServerId,
        props.observed.sourceSessionId,
        support.enabled,
    ]);
    React.useEffect(() => {
        setRetired(false);
        return authority?.accountLifetime.onRetire(() => setRetired(true)).dispose;
    }, [authority]);
    if (!isSessionRouteHydrationAvailable(hydration)) return <ActivitySpinner size="small" />;
    const current = readExactActiveParentTurn(sourceSession);
    const serverMatches = sourceSession?.serverId === props.observed.sourceServerId
        && getActiveServerSnapshot().serverId === props.observed.sourceServerId;
    if (!serverMatches || !authority?.isCurrent() || retired) {
        return (
            <SurfaceStateCard
                kind="error"
                title={t('common.error')}
                reason={t('automations.exactTurn.unavailable')}
                accessibilitySemantics="alert"
            />
        );
    }
    if (!areExactTurnAutomationPrefillsEqual(binding, current)) {
        return (
            <SurfaceStateCard
                testID="new-automation-exact-turn-stale"
                kind="warning"
                title={t('automations.exactTurn.staleTitle')}
                reason={t('automations.exactTurn.staleBody')}
                {...(current ? {
                    action: {
                        label: t('automations.exactTurn.useCurrentTurn'),
                        onPress: () => {
                            // Explicit adoption: the binding and the composer's
                            // incumbent automation-draft owner are the mutation
                            // owners; params are updated as URL truth only.
                            setBinding(current);
                            setRetargetRequest(current);
                            router.setParams(buildExactTurnAutomationRouteParams(current));
                        },
                    },
                } : {})}
                accessibilitySemantics="alert"
            />
        );
    }
    // The composer's continuity owner (session draft repository + one tempData
    // seed) is keyed by source identity only. Turn retargets flow through the
    // explicit retarget request into the incumbent draft owner, never through
    // a remount key.
    const composerIdentity = `${binding.sourceServerId}:${binding.sourceSessionId}`;
    return (
        <NewAutomationComposerHost
            key={composerIdentity}
            params={props.params}
            observed={binding}
            exactTurnRetargetRequest={retargetRequest}
        />
    );
}

export default function NewAutomationRoute() {
    const params = useLocalSearchParams<RouteParams>();
    const route = parseExactTurnAutomationPrefillRoute(params);
    if (route.kind === 'invalid') {
        // A partial exact-turn intent must surface explicitly instead of
        // silently composing a plain automation without the requested trigger.
        return (
            <AutomationsGate>
                <Stack.Screen options={{ title: t('automations.create.createButtonTitle'), headerBackTitle: t('common.back') }} />
                <SurfaceStateCard
                    testID="new-automation-exact-turn-invalid"
                    kind="error"
                    title={t('common.error')}
                    reason={t('automations.exactTurn.unavailable')}
                    accessibilitySemantics="alert"
                />
            </AutomationsGate>
        );
    }
    return route.kind === 'valid'
        ? <ExactTurnNewAutomationRoute params={params} observed={route.prefill} />
        : <NewAutomationComposerHost params={params} observed={null} />;
}
