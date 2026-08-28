import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import NewSessionScreen from '@/app/(app)/new/index';
import { AutomationsGate } from '@/components/automations/gating/AutomationsGate';
import {
    areExactTurnAutomationPrefillsEqual,
    buildExactTurnAutomationRouteParams,
    parseExactTurnAutomationPrefill,
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
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { isSessionRouteHydrationAvailable } from '@/sync/domains/session/sessionRouteHydrationState';
import { storage, useSession } from '@/sync/domains/state/storage';
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
            <NewSessionScreen />
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
    const support = useAutomationsSupport({ scopeKind: 'spawn', serverId: props.observed.sourceServerId });
    const supportRef = React.useRef(support.enabled);
    supportRef.current = support.enabled;
    const [retired, setRetired] = React.useState(false);
    const authority = React.useMemo(() => captureSessionAutomationAuthority({
        session: sourceSession,
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
    }), [props.observed.sourceServerId, props.observed.sourceSessionId, sourceSession, support.enabled]);
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
    if (!areExactTurnAutomationPrefillsEqual(props.observed, current)) {
        return (
            <SurfaceStateCard
                kind="warning"
                title={t('automations.exactTurn.staleTitle')}
                reason={t('automations.exactTurn.staleBody')}
                {...(current ? {
                    action: {
                        label: t('automations.exactTurn.useCurrentTurn'),
                        onPress: () => router.setParams(buildExactTurnAutomationRouteParams(current)),
                    },
                } : {})}
                accessibilitySemantics="alert"
            />
        );
    }
    const identity = `${props.observed.sourceServerId}:${props.observed.sourceSessionId}:${props.observed.sourceTurnId}`;
    return <NewAutomationComposerHost key={identity} params={props.params} observed={props.observed} />;
}

export default function NewAutomationRoute() {
    const params = useLocalSearchParams<RouteParams>();
    const observed = parseExactTurnAutomationPrefill(params);
    return observed
        ? <ExactTurnNewAutomationRoute params={params} observed={observed} />
        : <NewAutomationComposerHost params={params} observed={null} />;
}
