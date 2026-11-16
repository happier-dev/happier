import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ExternalSessionsSettingsView } from '@/components/settings/externalSessions/ExternalSessionsSettingsView';
import { ExternalSessionsBrowseRouteGate } from '@/components/sessions/external/browse/ExternalSessionsBrowseRouteGate';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    isMachineAdministrationCandidateSelectable,
    machineAdministrationTargetsEqual,
    readMachineAdministrationTargetRouteParams,
} from '@/sync/domains/machines/administration/targetSelection';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

const ExternalSessionsSettingsRouteContent = React.memo(function ExternalSessionsSettingsRouteContent() {
    const params = useLocalSearchParams<{
        serverIdentityId?: string | string[];
        machineId?: string | string[];
    }>();
    const router = useRouter();
    const targetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.externalSessions,
    );
    const requestedTarget = React.useMemo(() => readMachineAdministrationTargetRouteParams(params), [
        params.machineId,
        params.serverIdentityId,
    ]);
    const hasRequestedTargetParams = params.machineId !== undefined || params.serverIdentityId !== undefined;
    const requestedCandidate = requestedTarget
        ? targetSelection.candidates.find((candidate) => (
            machineAdministrationTargetsEqual(candidate.target, requestedTarget)
        )) ?? null
        : null;
    const requestedTargetAvailable = requestedTarget !== null
        && requestedCandidate !== null
        && isMachineAdministrationCandidateSelectable(requestedCandidate);
    const requestedTargetAdmitted = requestedTargetAvailable
        && targetSelection.selectedTarget !== null
        && machineAdministrationTargetsEqual(targetSelection.selectedTarget, requestedTarget);

    React.useEffect(() => {
        if (!requestedTargetAvailable || requestedTargetAdmitted || !requestedTarget) return;
        targetSelection.selectTarget(requestedTarget);
    }, [requestedTarget, requestedTargetAdmitted, requestedTargetAvailable, targetSelection.selectTarget]);

    if (hasRequestedTargetParams && !requestedTargetAvailable) {
        return (
            <SurfaceStateCard
                testID="external-sessions-settings-target-unavailable"
                kind="unavailable"
                accessibilitySemantics="alert"
                title={t('externalSessions.browseRouteUnavailableTitle')}
                reason={t('externalSessions.browseRouteUnavailableSubtitle')}
                action={{
                    label: t('common.close'),
                    onPress: () => safeRouterBack({ router, fallbackHref: '/settings/agents' }),
                }}
            />
        );
    }

    if (hasRequestedTargetParams && !requestedTargetAdmitted) {
        return (
            <SurfaceStateCard
                testID="external-sessions-settings-target-admission"
                kind="loading"
                accessibilitySemantics="status"
                title={t('common.loading')}
                secondaryAction={{
                    label: t('common.close'),
                    onPress: () => safeRouterBack({ router, fallbackHref: '/settings/agents' }),
                }}
            />
        );
    }

    return <ExternalSessionsSettingsView integrationInventoryEnabled={true} />;
});

/**
 * The canonical route-admission owner for External Sessions Settings. Checking,
 * probe-failure/unknown, and genuinely disabled decisions each render as an
 * accessible, exitable gate state — never a blank screen — and the Settings
 * children (and therefore their RPCs) mount only once admitted.
 */
export const WorkspaceRouteBody = React.memo(function ExternalSessionsSettingsRoute() {
    return (
        <ExternalSessionsBrowseRouteGate>
            <ExternalSessionsSettingsRouteContent />
        </ExternalSessionsBrowseRouteGate>
    );
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
