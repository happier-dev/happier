import * as React from 'react';
import type { BrowserPlatformV1 } from '@happier-dev/protocol/browser/view/v1';
import { hasUncertainLocalServiceNativeCustodyV1, isLocalServiceStateRunningV1 } from '@happier-dev/protocol/local/services/launcher/v1';

import { RightSidebarActionsContext, useRightSidebarTabAvailable } from '@/components/appShell/rightSidebar/rightSidebarActions';
import { describeLocalServiceStartFailure, readLocalServiceActionOutcome, useLocalServiceActionRunner } from '@/components/sessions/localServices/localServiceActionOutcome';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { selectBrowserEndedPreviewLastPage } from '@/sync/domains/browser/shell';
import { selectRunningServiceForEndedPreview, selectServiceForEndedPreview, type BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { buildLocalServiceRows, canStartLocalService } from '@/sync/domains/local/services/serviceRow';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { t } from '@/text';

import type { BrowserFrameRecovery } from './frame/types';
import { bindServicesOpenInBrowser, type OpenBrowserViewTarget } from './surfaces/openBrowserTargetInWorkspace';

/** Preview cards consume the existing Service, page-info and Action outcome owners here. */
export function useBrowserPreviewRecovery(input: Readonly<{
    activeView: BrowserControlViewState | null;
    launchpadRows: readonly BrowserLaunchpadRow[];
    localServiceTargets?: readonly LocalServiceLaunchTarget[];
    platform: BrowserPlatformV1;
    serverId?: string | null;
    accountLifetime: ServerAccountScopeLifetime | null;
    credentialKey?: string;
    onOpenTarget?: OpenBrowserViewTarget;
    onClose: () => void;
    canReload: boolean;
    onCommand: (kind: 'reload') => void;
}>): BrowserFrameRecovery {
    const { activeView, launchpadRows, localServiceTargets, platform, serverId, accountLifetime,
        credentialKey, onOpenTarget, onClose, canReload, onCommand } = input;
    const machineId = activeView?.target.kind === 'localServicePreview' ? activeView.target.machineId : null;
    const machineIds = React.useMemo(() => machineId ? [machineId] : [], [machineId]);
    const machineNames = useMachineDisplayNamesById(machineIds);
    const machineName = machineId ? machineNames[machineId] ?? null : null;
    const endedView = activeView?.loadingState === 'failed' && activeView.lastError === 'preview_ended' ? activeView : null;
    const endedLastPage = selectBrowserEndedPreviewLastPage(endedView);
    const scopeSideActions = React.useContext(RightSidebarActionsContext);
    const openServices = React.useCallback(() => scopeSideActions?.current?.selectTab('services'), [scopeSideActions]);
    const scopeHasServices = useRightSidebarTabAvailable('services');
    const endedServiceFacts = React.useMemo(() => endedView && localServiceTargets
        ? selectServiceForEndedPreview(localServiceTargets, endedView.target) : null,
    [endedView, localServiceTargets]);
    const endedServiceTarget = React.useMemo(() => {
        // Current Service facts may precede the launchpad or its first preview registration.
        // Consume the same primary-action decision as Services, including its unavailable states.
        if (localServiceTargets) {
            if (!endedServiceFacts) return null;
            const row = buildLocalServiceRows({ launchTargets: [endedServiceFacts], inventoryRows: [],
                sessionId: endedServiceFacts.sessionId ?? null, scope: 'workspace' })[0];
            return row?.primaryAction?.kind === 'open' ? row.primaryAction.openTarget : null;
        }
        return endedView ? selectRunningServiceForEndedPreview(launchpadRows, endedView.target) : null;
    }, [endedServiceFacts, endedView, launchpadRows, localServiceTargets]);
    const observedNativeBinding = endedServiceFacts?.source === 'managed_service'
        && isLocalServiceStateRunningV1(endedServiceFacts.serviceState)
        && !hasUncertainLocalServiceNativeCustodyV1(endedServiceFacts);
    const reopenRunner = useLocalServiceActionRunner({
        presentation: 'inline', servicesActionOffered: scopeHasServices, observedNativeBinding,
    });
    const runReopen = reopenRunner.run;
    const reopenFailure = reopenRunner.failure?.body ?? null;
    const serviceStartFailure = React.useMemo(() => {
        const observed = endedServiceFacts ? describeLocalServiceStartFailure(endedServiceFacts) : null;
        // An Open refusal can precede its Services publication; keep that typed outcome too.
        return observed ?? (reopenRunner.failure?.reasonCode === 'plugin_managed_service_establishment_failed'
            ? { ...reopenRunner.failure, reasonCode: reopenRunner.failure.reasonCode } : null);
    }, [endedServiceFacts, reopenRunner.failure]);
    const dismissReopenFailure = reopenRunner.dismissFailure;
    const activeViewKey = activeView ? `${activeView.browserSessionId}\u0000${activeView.viewId}` : null;
    const reopenAfterStart = React.useRef<string | null>(null);
    React.useEffect(() => {
        reopenAfterStart.current = null;
        dismissReopenFailure();
    }, [activeViewKey, dismissReopenFailure]);
    const serviceRestarting = endedServiceFacts?.state === 'starting' || endedServiceFacts?.serviceState === 'starting';
    React.useEffect(() => {
        if (serviceRestarting || observedNativeBinding) dismissReopenFailure();
    }, [dismissReopenFailure, observedNativeBinding, serviceRestarting]);
    const onOpenAgain = React.useMemo(() => endedServiceTarget && onOpenTarget ? () => {
            let reopenedSamePreview = false;
            const openServiceAgain = bindServicesOpenInBrowser({
                platform, serverId, accountLifetime, credentialKey,
                onOpenTarget: (target, options) => {
                    reopenedSamePreview = target.kind === 'localServicePreview'
                        && endedView?.target.kind === 'localServicePreview'
                        && target.targetId === endedView.target.targetId
                        && target.machineId === endedView.target.machineId;
                    return onOpenTarget(target, options);
                },
            });
            return runReopen({
                id: 'ended-preview-open-again',
                failureTitle: t('browserShell.unavailable.openAgain'),
                serviceName: endedServiceTarget.title,
                serviceTarget: endedServiceTarget,
                action: () => openServiceAgain(endedServiceTarget),
            }).then((opened) => {
                if (opened && !reopenedSamePreview) onClose();
            });
        } : undefined, [accountLifetime, credentialKey, endedServiceTarget, endedView, onClose, onOpenTarget, platform, runReopen, serverId]);
    React.useEffect(() => {
        if (!activeViewKey || reopenAfterStart.current !== activeViewKey || reopenRunner.pendingId || !observedNativeBinding || !onOpenAgain) return;
        // Start expresses an intent to resume this page. Re-register once through Services Open;
        // a refused registration leaves Open again available rather than retrying in the background.
        reopenAfterStart.current = null;
        void onOpenAgain();
    }, [activeViewKey, observedNativeBinding, onOpenAgain, reopenRunner.pendingId]);
    return React.useMemo<BrowserFrameRecovery>(() => ({
        machineName,
        lastPage: endedLastPage,
        onOpenAgain,
        openAgainFailure: reopenFailure,
        serviceStartFailure: serviceStartFailure ?? undefined,
        serviceName: endedServiceFacts?.title ?? endedServiceTarget?.title
            ?? (endedView?.target.kind === 'localServicePreview' ? endedView.target.display?.title : null),
        stoppedServiceName: endedServiceFacts && (endedServiceFacts.serviceState === undefined || endedServiceFacts.serviceState === 'stopped')
            ? endedServiceFacts.title : null,
        // Use the Services row's Start decision regardless of which pane is visible.
        startAgain: endedServiceFacts && (describeLocalServiceStartFailure(endedServiceFacts)
            || (endedServiceFacts.serviceState !== 'running' && canStartLocalService(endedServiceFacts))) ? {
            target: endedServiceFacts,
            serverId: serverId ?? null,
            run: (start) => runReopen({
                id: 'ended-preview-start-again',
                failureTitle: t('localServices.actions.failureTitle.start', { service: endedServiceFacts.title }),
                serviceName: endedServiceFacts.title,
                serviceTarget: endedServiceFacts,
                observeNativeStart: true,
                action: async () => {
                    try {
                        const result = await start();
                        const outcome = readLocalServiceActionOutcome(result);
                        reopenAfterStart.current = outcome.kind === 'succeeded' || outcome.kind === 'accepted'
                            || outcome.kind === 'outcome_unknown' || outcome.kind === 'approval_pending' ? activeViewKey : null;
                        return result;
                    } catch (error) {
                        reopenAfterStart.current = readLocalServiceActionOutcome(error).kind === 'outcome_unknown' ? activeViewKey : null;
                        throw error;
                    }
                },
            }),
        } : undefined,
        onOpenServices: scopeHasServices ? openServices : undefined,
        onClose,
        onTryAgain: canReload ? () => onCommand('reload') : undefined,
    }), [accountLifetime, activeViewKey, canReload, credentialKey, endedLastPage, endedServiceFacts, endedServiceTarget,
        endedView, machineName, onClose, onCommand, onOpenAgain, onOpenTarget, openServices, platform, reopenFailure, runReopen,
        scopeHasServices, serverId, serviceStartFailure]);
}
