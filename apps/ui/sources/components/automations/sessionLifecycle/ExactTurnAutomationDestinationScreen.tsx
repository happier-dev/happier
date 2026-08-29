import * as React from 'react';
import { useRouter } from 'expo-router';

import { SelectionListScreen, type SelectionListOption, type SelectionListStep } from '@/components/ui/selectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useActiveServerAccountScope, useAutomations, useSession } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storage';
import { captureSessionAutomationAuthority } from '@/sync/domains/automations/sessionAutomationAuthority';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';

import {
    areExactTurnAutomationPrefillsEqual,
    buildExactTurnAutomationRouteParams,
    readExactActiveParentTurn,
    type ExactTurnAutomationPrefill,
} from './exactTurnAutomationPrefill';

const CREATE_NEW_OPTION_ID = 'create-new';
const EXISTING_OPTION_PREFIX = 'existing:';

function isCompatibleExistingAutomation(
    automation: Readonly<{ targetType: string; linkedExistingSessionId?: string | null }>,
    sourceSessionId: string,
): boolean {
    return automation.targetType !== 'existingSession'
        || (
            typeof automation.linkedExistingSessionId === 'string'
            && automation.linkedExistingSessionId.length > 0
            && automation.linkedExistingSessionId !== sourceSessionId
        );
}

export function ExactTurnAutomationDestinationScreen(props: Readonly<{
    observed: ExactTurnAutomationPrefill;
}>) {
    const router = useRouter();
    const sourceSession = useSession(props.observed.sourceSessionId);
    const activeServer = useActiveServerSnapshot();
    const activeAccountScope = useActiveServerAccountScope();
    const support = useAutomationsSupport({ scopeKind: 'spawn', serverId: props.observed.sourceServerId });
    const supportRef = React.useRef(support.enabled);
    supportRef.current = support.enabled;
    const automations = useAutomations();
    const [loading, setLoading] = React.useState(false);
    const [refreshFailed, setRefreshFailed] = React.useState(false);
    const [refreshGeneration, setRefreshGeneration] = React.useState(0);
    const current = readExactActiveParentTurn(sourceSession);
    const observedIsCurrent = areExactTurnAutomationPrefillsEqual(current, props.observed);
    const accountScopeKey = activeAccountScope ? serverAccountScopeKeySuffix(activeAccountScope) : null;
    const authority = React.useMemo(() => captureSessionAutomationAuthority({
        // Capture-time identity facts only; isCurrent() re-reads live store
        // truth, so the memo must not depend on the render-phase Session
        // object whose identity churns on every transcript update of the
        // running source turn. The Account-scope key (serverId+accountId) is
        // the semantic Account identity: a same-server Account switch rebinds
        // the authority instead of holding the retired lifetime forever.
        session: storage.getState().sessions[props.observed.sourceSessionId] ?? null,
        routeSessionId: props.observed.sourceSessionId,
        routeServerId: props.observed.sourceServerId,
        activeServerId: activeServer.serverId,
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
        activeServer.serverId,
        props.observed.sourceServerId,
        props.observed.sourceSessionId,
        support.enabled,
    ]);

    React.useEffect(() => {
        if (!authority) return;
        let alive = true;
        setLoading(true);
        setRefreshFailed(false);
        void sync.refreshAutomations().catch(() => {
            if (alive && authority.isCurrent()) setRefreshFailed(true);
        }).finally(() => {
            if (alive && authority.isCurrent()) setLoading(false);
        });
        return () => { alive = false; };
    }, [authority, refreshGeneration]);

    const compatible = React.useMemo(() => automations.filter((automation) => (
        isCompatibleExistingAutomation(automation, props.observed.sourceSessionId)
    )), [automations, props.observed.sourceSessionId]);

    const options = React.useMemo<ReadonlyArray<SelectionListOption>>(() => [
        {
            id: CREATE_NEW_OPTION_ID,
            label: t('automations.exactTurn.createNew'),
            subtitle: t('automations.exactTurn.createNewSubtitle'),
            testID: 'exact-turn-automation-create-new',
        },
        ...compatible.map((automation) => ({
            id: `${EXISTING_OPTION_PREFIX}${automation.id}`,
            label: automation.name,
            subtitle: t('automations.exactTurn.addToExistingSubtitle'),
            testID: `exact-turn-automation-existing-${automation.id}`,
        })),
    ], [compatible]);

    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'exact-turn-automation-destination',
        title: t('automations.exactTurn.actionTitle'),
        inputPlaceholder: t('automations.exactTurn.searchPlaceholder'),
        sections: [{
            kind: 'static',
            id: 'destinations',
            options,
            virtualization: 'force',
        }],
    }), [options]);

    const revalidate = React.useCallback(() => {
        if (!authority?.isCurrent()) return false;
        const fresh = readExactActiveParentTurn(
            storage.getState().sessions[props.observed.sourceSessionId],
        );
        return areExactTurnAutomationPrefillsEqual(fresh, props.observed);
    }, [authority, props.observed]);

    if (!authority) {
        return (
            <SurfaceStateCard
                kind="error"
                title={t('common.error')}
                reason={t('automations.exactTurn.unavailable')}
                accessibilitySemantics="alert"
            />
        );
    }

    if (!observedIsCurrent) {
        return (
            <SurfaceStateCard
                testID="exact-turn-automation-stale"
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

    if (loading) {
        return (
            <SurfaceStateCard
                kind="loading"
                title={t('common.loading')}
                accessibilitySemantics="status"
            />
        );
    }

    if (refreshFailed) {
        return (
            <SurfaceStateCard
                testID="exact-turn-automation-refresh-failed"
                kind="warning"
                title={t('common.error')}
                reason={t('automations.exactTurn.unavailable')}
                action={{ label: t('common.retry'), onPress: () => setRefreshGeneration((value) => value + 1) }}
                accessibilitySemantics="alert"
            />
        );
    }

    return (
        <SelectionListScreen
            rootStep={rootStep}
            listAccessibilityLabel={t('automations.exactTurn.destinationA11y')}
            selectedOptionId={null}
            onSelect={(optionId) => {
                if (!revalidate()) return;
                const routeParams = buildExactTurnAutomationRouteParams(props.observed);
                if (optionId === CREATE_NEW_OPTION_ID) {
                    navigateWithBlurOnWeb(() => router.push({ pathname: '/automations/new', params: routeParams }));
                    return;
                }
                if (!optionId.startsWith(EXISTING_OPTION_PREFIX)) return;
                const automationId = optionId.slice(EXISTING_OPTION_PREFIX.length);
                if (!compatible.some((automation) => automation.id === automationId)) return;
                navigateWithBlurOnWeb(() => router.push({
                    pathname: '/automations/edit',
                    params: { id: automationId, ...routeParams },
                }));
            }}
            onRequestClose={() => router.back()}
            keyboardHintsEnabled
            autoFocusInputOnWeb
            testID="exact-turn-automation-destination"
        />
    );
}
