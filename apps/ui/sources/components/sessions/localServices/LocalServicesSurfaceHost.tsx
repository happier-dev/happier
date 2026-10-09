import * as React from 'react';

import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { PluginSurfacePlacementStack } from '@/components/plugins/surfaces';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import type {
    LocalServiceLauncherSnapshotClient,
    LocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceInventorySnapshotClient } from '@/sync/domains/local/services/inventory/useLocalServiceInventoryState';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import type { LocalServicePublicPreviewStatusClient } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';

import { DetectedLocalServicesPane } from './DetectedLocalServicesPane';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';
import type { ServiceRowOpenHandler } from './ServiceRowView';
import { useLocalServiceLauncherStartAction } from './launcherStartAction';
import type { LocalServiceActionAdmission, LocalServiceEffectReview, LocalServiceSetupConsentReview } from './localServiceActionAdmission';
import { LocalServiceEffectReviewCard } from './LocalServiceEffectReviewCard';
import { LocalServiceSetupConsentContinuation } from './LocalServiceSetupConsentContinuation';
import {
    useDetectedLocalServiceForgetAction,
    useDetectedLocalServiceTerminateAction,
    useLocalServiceCopyUrlAction,
    useLocalServiceLauncherHistoryClearAction,
    useManagedLocalServiceControlAction,
} from './lifecycleActions';
import { useLocalServicePublicPreviewActions } from './publicPreviewActions';
import { useLocalServiceLiveFeeds } from './useLocalServiceLiveFeeds';
import {
    useLocalServiceCapabilityDisabledReasons,
    useLocalServicePublicPreviewFeatureEnabled,
} from './useLocalServicePublicPreviewFeature';

export type LocalServicesSurfaceHostProps = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string;
    /** Session-less project scoping by repo root (raw; canonicalized at the daemon boundary). */
    workspaceRoot?: string | null;
    workspaceRefId?: string | null;
    /** Initial scope; defaults to 'workspace'. The toggle mutates local scope state. */
    scope?: 'workspace' | 'machine';
    inventoryState?: LocalServiceInventoryState;
    inventorySnapshotClient?: LocalServiceInventorySnapshotClient;
    launcherState?: LocalServiceLauncherState | null;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
    runtimeActionExecute?: RuntimeActionExecute;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    /** Exact AppPane-admitted projection when a driver-owned surface supplies it. */
    pluginUiProjection?: PluginUiProjectionModel | null;
    projectionInteractionEnabled?: boolean;
    platform?: LocalServicePreviewPlatform;
    /** `page` on the Project Services page; the rail and Session panel keep the pane chrome. */
    presentation?: 'pane' | 'page';
    /** The placement owner's per-row "Runs on" control (plan 32), hosted in each row's expansion. */
    renderServicePlacement?: (row: ServiceRow) => React.ReactNode;
    testID: string;
}>;

export function LocalServicesSurfaceHost(props: LocalServicesSurfaceHostProps): React.ReactElement {
    const machineId = props.machineId ?? null;
    const serverId = props.serverId ?? null;
    const sessionId = props.sessionId;
    const workspaceRoot = props.workspaceRoot ?? null;
    const [scope, setScope] = React.useState<'workspace' | 'machine'>(props.scope ?? 'workspace');
    // The header line and the offline state name the machine and read its presence: one summary,
    // primitives only, so presence heartbeats that change nothing re-render nothing.
    const machine = useMachinePresenceSummary(serverId, machineId);
    const publicPreviewFeatureEnabled = useLocalServicePublicPreviewFeatureEnabled(serverId);
    // Resolved once for the whole surface: the server names which prerequisite is unmet, and the
    // rows render it instead of one generic sentence for eleven different causes (audit P1-3).
    const publicPreviewCapabilityDisabledReasons = useLocalServiceCapabilityDisabledReasons(serverId);
    const feeds = useLocalServiceLiveFeeds({
        machineId,
        serverId,
        sessionId,
        workspaceRoot,
        workspaceRefId: props.workspaceRefId,
        scope,
        inventoryState: props.inventoryState,
        launcherState: props.launcherState,
        inventorySnapshotClient: props.inventorySnapshotClient,
        launcherSnapshotClient: props.launcherSnapshotClient,
    });
    const { inventoryState, launcherState, refresh: onRefresh } = feeds;
    // Single front door (FINALIZATION-PLAN §3.1/§12.6): local-service runtime actions dispatch
    // through ActionExecutor.execute via the canonical bridge, so ActionsSettings enablement and
    // approval routing apply — never the raw runtime executor.
    const runtimeActionExecute = React.useMemo(
        () => props.runtimeActionExecute ?? createFrontDoorRuntimeActionExecutor(),
        [props.runtimeActionExecute],
    );
    const credentialBindings = useServerCredentialAccountScopeBindings([serverId]);
    const credentialBinding = credentialBindings.get(resolveServerProfileScopeIdForIdentifier(serverId));
    const actionScopeKey = JSON.stringify([serverId, credentialBinding?.accountId, credentialBinding?.revision, machineId, workspaceRoot, sessionId]);
    const cancellation = React.useMemo(() => new AbortController(), [actionScopeKey]);
    React.useEffect(() => {
        const retirement = credentialBinding?.onRetire(() => cancellation.abort());
        return () => { retirement?.dispose(); cancellation.abort(); };
    }, [credentialBinding, cancellation]);
    const refreshAfterApproval = React.useCallback(() => { void onRefresh(); }, [onRefresh]);
    const approval = useActionApprovalContinuation({ scopeKey: actionScopeKey, serverId: serverId ?? '', onExecuted: refreshAfterApproval });
    const isActionScopeCurrent = React.useCallback(() => Boolean(credentialBinding?.isCurrent()) && !cancellation.signal.aborted,
        [credentialBinding, cancellation]);
    const effectReview = useLocalServiceReview<LocalServiceEffectReview>();
    const setupReview = useLocalServiceReview<LocalServiceSetupConsentReview>();
    const actionAdmission: LocalServiceActionAdmission = {
        expectedAccountId: credentialBinding?.accountId,
        signal: cancellation.signal,
        isCurrent: isActionScopeCurrent,
        onApprovalPending: approval.requestApproval,
        reviewEffect: effectReview.request,
        reviewSetupConsent: setupReview.request,
    };
    const onTerminateDetectedService = useDetectedLocalServiceTerminateAction({
        ...actionAdmission,
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
    });
    const onForgetDetectedService = useDetectedLocalServiceForgetAction({
        ...actionAdmission,
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
    });
    const onCopyServiceUrl = useLocalServiceCopyUrlAction({
        ...actionAdmission,
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
    });
    // Stop and Restart a managed lifetime through its exact occurrence; the result settles the row.
    const managedControl = useManagedLocalServiceControlAction({
        ...actionAdmission,
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
    });
    const onStopManagedService = React.useMemo(() => managedControl
        ? (target: Parameters<typeof managedControl>[0]) => managedControl(target, 'localServices.actions.stopManaged')
        : undefined, [managedControl]);
    const onRestartManagedService = React.useMemo(() => managedControl
        ? (target: Parameters<typeof managedControl>[0]) => managedControl(target, 'localServices.actions.restartManaged')
        : undefined, [managedControl]);
    const onStartLauncherTarget = useLocalServiceLauncherStartAction({
        ...actionAdmission,
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
        applyLauncherSnapshot: feeds.applyLauncherSnapshot,
    });
    const onClearLauncherHistory = useLocalServiceLauncherHistoryClearAction({ ...actionAdmission,
        runtimeActionExecute, machineId, serverId, sessionId, scope, workspaceRoot,
        applyLauncherSnapshot: feeds.applyLauncherSnapshot,
    });
    const publicPreviewActions = useLocalServicePublicPreviewActions({
        ...actionAdmission,
        runtimeActionExecute,
        machineId,
        serverId,
        sessionId,
    });
    const hasAdmittedPluginProjection = props.pluginUiProjection !== undefined;
    // AppPane has already admitted the exact projection for a driver-rendered
    // surface. Keep this hook unconditional for React, but disable its
    // ambient target lookup so an explicit unavailable projection cannot
    // subscribe to or replace the driver-owned snapshot.
    const pluginProjection = useScopedPluginUiProjection(hasAdmittedPluginProjection
        ? { machineId: null, serverId: null, enabled: false }
        : { machineId, serverId });
    const pluginUiProjection = hasAdmittedPluginProjection
        ? props.pluginUiProjection ?? null
        : pluginProjection.pluginUiProjection;
    const projectionInteractionEnabled = hasAdmittedPluginProjection
        ? props.projectionInteractionEnabled === true
        : pluginProjection.interactionEnabled;
    const platform = hasAdmittedPluginProjection
        ? props.platform ?? pluginProjection.platform
        : pluginProjection.platform;

    const pluginStack = (
        <PluginSurfacePlacementStack
            container="servicesPanel"
            pluginUiProjection={pluginUiProjection}
            projectionInteractionEnabled={projectionInteractionEnabled}
            machineId={machineId}
            serverId={serverId}
            sessionId={sessionId}
            platform={platform}
            targetKind="services"
            testID={`${props.testID}-plugin-stack`}
        />
    );

    return (
        <DetectedLocalServicesPane
            inventoryState={inventoryState}
            launcherState={launcherState}
            publicPreviewState={props.publicPreviewState}
            sourceMachineId={machineId}
            serverId={serverId}
            publicPreviewEnabled={publicPreviewFeatureEnabled}
            publicPreviewStatusClient={props.publicPreviewStatusClient}
            sessionId={sessionId}
            scope={scope}
            onChangeScope={setScope}
            onTerminateDetectedService={onTerminateDetectedService}
            onForgetDetectedService={onForgetDetectedService}
            onStopManagedService={onStopManagedService}
            onRestartManagedService={onRestartManagedService}
            onCopyServiceUrl={onCopyServiceUrl}
            onStartLauncherTarget={onStartLauncherTarget}
            onClearLauncherHistory={onClearLauncherHistory}
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            publicPreviewActions={publicPreviewActions}
            publicPreviewCapabilityDisabledReasons={publicPreviewCapabilityDisabledReasons}
            machine={machine}
            onRefresh={onRefresh}
            presentation={props.presentation}
            renderServicePlacement={props.renderServicePlacement}
            viewerAccountId={credentialBinding?.accountId ?? null}
            effectReview={<>
                {setupReview.pending && credentialBinding ? <LocalServiceSetupConsentContinuation
                    key={JSON.stringify([setupReview.pending.review.target.id, setupReview.pending.review.consent.reviewedEffectDigest])}
                    review={setupReview.pending.review}
                    binding={credentialBinding}
                    runtimeActionExecute={runtimeActionExecute}
                    onComplete={setupReview.pending.settle}
                    testID={props.testID}
                /> : null}
                {effectReview.pending && serverId ? (
                <LocalServiceEffectReviewCard
                    review={effectReview.pending.review}
                    serverId={serverId}
                    machineId={machineId}
                    onDecide={effectReview.pending.settle}
                    testID={`${props.testID}-effect-review`}
                />
                ) : null}
            </>}
            testID={props.testID}
            footer={pluginStack}
        />
    );
}

type PendingReview<T> = Readonly<{ review: T; settle: (accepted: boolean) => void }>;

/**
 * The one current-effect review of this Services surface: Start/Restart hand it the effect the
 * daemon disclosed and wait for the person. Only an explicit Start/Restart rejoins the Action with
 * that digest; Not now, a newer review or the scope's retirement (its Account, machine or checkout
 * changing aborts the signal) settles it as declined, so nothing re-enters on its own.
 */
function useLocalServiceReview<T extends Readonly<{ signal?: AbortSignal }>>(): Readonly<{
    pending: PendingReview<T> | null;
    request: (review: T) => Promise<boolean>;
}> {
    const [pending, setPending] = React.useState<PendingReview<T> | null>(null);
    const current = React.useRef<PendingReview<T> | null>(null);
    const request = React.useCallback((review: T) => new Promise<boolean>((resolve) => {
        current.current?.settle(false);
        if (review.signal?.aborted) {
            resolve(false);
            return;
        }
        let settled = false;
        const onAbort = () => entry.settle(false);
        const entry: PendingReview<T> = {
            review,
            settle: (accepted) => {
                if (settled) return;
                settled = true;
                review.signal?.removeEventListener('abort', onAbort);
                if (current.current === entry) {
                    current.current = null;
                    setPending(null);
                }
                resolve(accepted);
            },
        };
        current.current = entry;
        setPending(entry);
        review.signal?.addEventListener('abort', onAbort, { once: true });
    }), []);
    React.useEffect(() => () => current.current?.settle(false), []);
    return { pending, request };
}
