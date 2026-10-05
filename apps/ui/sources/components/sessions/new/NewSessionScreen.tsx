import React from 'react';
import type { SessionDirectoryIntentV1 } from '@happier-dev/protocol';

import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { useShouldBlockNewSessionWithGettingStartedGuidance } from '@/components/sessions/guidance/useShouldBlockNewSessionWithGettingStartedGuidance';
import { NewSessionSimplePanel } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { NewSessionComposerCard } from '@/components/sessions/new/components/NewSessionComposerCard';
import { NewSessionWizard } from '@/components/sessions/new/components/NewSessionWizard';
import { NewSessionLaunchSurface } from '@/components/sessions/new/components/NewSessionLaunchSurface';
import { useNewSessionScreenModel } from '@/components/sessions/new/hooks/useNewSessionScreenModel';
import type { ExactTurnAutomationPrefill } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { NewSessionScreenPortalScope } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import {
    resolveNewSessionDraftRouteIdentity,
    resolveNewSessionDraftRouteScope,
} from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import {
    useNewSessionHostCreationProfile,
    useNewSessionHostNavigation,
    useNewSessionHostParams,
    type NewSessionCreationProfile,
} from '@/components/sessions/new/navigation/newSessionHost';
import { useNewSessionPanelPropsForCreationProfile } from '@/components/sessions/new/modules/newSessionCreationProfile';
import { useResolveNewSessionOrdinaryEntryRoute } from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';
import { isNewSessionDraftLaunchInCustody } from '@/components/sessions/new/modules/newSessionDraftLaunchCustody';
import { NewSessionDraftComposerActions } from '@/components/sessions/drafts/NewSessionDraftComposerActions';
import { deleteNewSessionDraftAfterConfirmation } from '@/components/sessions/drafts/deleteNewSessionDraftAfterConfirmation';
import { buildSessionDraftSyncStatusBadge } from '@/components/sessions/drafts/sessionDraftStatusPresentation';
import {
    SessionDraftConflictResolution,
    useSessionDraftConflictComposerBanner,
} from '@/components/sessions/drafts/SessionDraftConflictResolution';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { Modal } from '@/modal';
import { readAllActionOperations, useAllActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { parseNewSessionCheckoutDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import {
    clearNewSessionOrdinaryEntryDraftIdExact,
    setNewSessionOrdinaryEntryDraftId,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import { useActiveServerAccountScope, useSettingMutable } from '@/sync/store/hooks';
import {
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    deleteSessionDraft,
    deleteSessionDraftWithScopedRuntime,
    type SessionDraftSnapshot,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useServerCredentialAccountScopeBindings, useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { runWithSessionDraftRepositoryScopedRuntime } from '@/sync/ops/sessionDrafts/runWithSessionDraftRepositoryScopedRuntime';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { t } from '@/text';

/**
 * How the New Session surface is presented. `screen` is the `/new` route (the panel or the
 * wizard, with its own chrome). `embedded` is the same surface inside another page (Home): only
 * the composer, at the page's column width, with the host owning params and draft identity
 * (`NewSessionEmbeddedHostProvider`).
 */
export type NewSessionScreenPresentation = 'screen' | 'embedded';

function hasSeededCheckoutIntent(value: unknown): boolean {
    const draft = parseNewSessionCheckoutDraft(value);
    return draft.checkoutCreationDraft !== null;
}

function NewSessionScreenInner(props: Readonly<{
    presentation: NewSessionScreenPresentation;
    composerTopContent?: React.ReactNode;
    draftId: string;
    statusBadges?: ReadonlyArray<AgentInputStatusBadge>;
    statusTrailingActions?: React.ReactNode;
    automationExactTurnRetarget?: ExactTurnAutomationPrefill | null;
    fixedDirectoryIntent?: SessionDirectoryIntentV1;
}>) {
    const model = useNewSessionScreenModel(props);
    // A host that fixes part of the creation (the embed's new chat) narrows this same composer.
    const creationProfile = useNewSessionHostCreationProfile();

    if (model.variant === 'simple') {
        return (
            <NewSessionLaunchSurface
                overlay={model.launchOverlay}
                temporaryComputerLaunch={model.temporaryComputerLaunch}
                onRequestClose={model.launchOnRequestClose}
                overlayPresentation={model.overlayPresentation}
                presentation={props.presentation}
                focusReturnRef={model.overlayFocusReturnRef}
                overlayAccessibilityLabel={model.overlayAccessibilityLabel}
            >
                {props.presentation === 'embedded'
                    ? <NewSessionEmbeddedComposerCard panelProps={model.simpleProps} creationProfile={creationProfile} />
                    : <NewSessionSimplePanel {...model.simpleProps} />}
            </NewSessionLaunchSurface>
        );
    }

    const { layout, profiles, agent, machine, footer } = model.wizardProps;

    return (
        <NewSessionLaunchSurface
            overlay={model.launchOverlay}
            temporaryComputerLaunch={model.temporaryComputerLaunch}
            onRequestClose={model.launchOnRequestClose}
            overlayPresentation={model.overlayPresentation}
            presentation={props.presentation}
            focusReturnRef={model.overlayFocusReturnRef}
            overlayAccessibilityLabel={model.overlayAccessibilityLabel}
        >
            <NewSessionWizard
                popoverBoundaryRef={model.popoverBoundaryRef}
                layout={layout}
                profiles={profiles}
                agent={agent}
                machine={machine}
                footer={footer}
            />
        </NewSessionLaunchSurface>
    );
}

function NewSessionEmbeddedComposerCard(props: Readonly<{
    panelProps: React.ComponentProps<typeof NewSessionSimplePanel>;
    creationProfile: NewSessionCreationProfile | undefined;
}>) {
    const panelProps = useNewSessionPanelPropsForCreationProfile(props.panelProps, props.creationProfile);
    return (
        <NewSessionComposerCard
            panelProps={panelProps}
            layout="embedded"
            {...(props.creationProfile ? {
                attachments: props.creationProfile.attachments !== false,
                voiceAffordance: 'none' as const,
            } : {})}
        />
    );
}

function NewSessionContent(props: Readonly<{
    presentation: NewSessionScreenPresentation;
    allowBlockingGuidance: boolean;
    composerTopContent?: React.ReactNode;
    draftId: string;
    statusBadges?: ReadonlyArray<AgentInputStatusBadge>;
    statusTrailingActions?: React.ReactNode;
    automationExactTurnRetarget?: ExactTurnAutomationPrefill | null;
    fixedDirectoryIntent?: SessionDirectoryIntentV1;
}>) {
    const shouldBlock = useShouldBlockNewSessionWithGettingStartedGuidance();

    if (props.allowBlockingGuidance && shouldBlock) {
        return <SessionGettingStartedGuidance variant="newSessionBlocking" />;
    }

    return (
        <NewSessionScreenPortalScope>
            <NewSessionScreenInner {...props} />
        </NewSessionScreenPortalScope>
    );
}

/**
 * The one New Session surface: its draft identity, the ordinary-entry pointer, draft status and
 * actions, and the authoring model behind them. The `/new` route and Home both render it; the
 * host seam (`newSessionHost`) decides where its params live and how a draft change navigates.
 */
export function NewSessionScreen(props: Readonly<{
    presentation: NewSessionScreenPresentation;
    automationExactTurnRetarget?: ExactTurnAutomationPrefill | null;
    /**
     * A host that decides where the session lives (the embed's new chat passes `{kind:'managed'}`).
     * The folder and checkout controls then render nothing; see `useNewSessionMachinePathState`.
     */
    fixedDirectoryIntent?: SessionDirectoryIntentV1;
}>) {
    const { router, openDraft } = useNewSessionHostNavigation();
    const {
        dataId,
        draftId: routeDraftId,
        draftOrigin,
        machineId,
        directory,
        draftServerId,
        draftAccountId,
    } = useNewSessionHostParams<{
        dataId?: string;
        draftId?: string;
        draftOrigin?: string;
        spawnServerId?: string;
        machineId?: string;
        directory?: string;
        draftServerId?: string;
        draftAccountId?: string;
    }>();
    const activeDraftScope = useActiveServerAccountScope();
    const creationProfile = useNewSessionHostCreationProfile();
    const requestedDraftScopeResolution = useServerCredentialAccountScopeResolution(draftServerId);
    const draftScope = resolveNewSessionDraftRouteScope({
        activeScope: activeDraftScope,
        hostScope: creationProfile?.draftScope,
        draftServerId,
        draftAccountId,
        requestedScopeResolution: requestedDraftScopeResolution,
    });
    const requestedDraftScopeBindings = useServerCredentialAccountScopeBindings(
        draftServerId ? [draftServerId] : [],
    );
    const requestedDraftScopeBinding = draftServerId
        ? [...requestedDraftScopeBindings.values()].find((binding) => (
            draftScope !== null && areServerAccountScopesEqual(binding.scope, draftScope)
        )) ?? null
        : null;
    const requestedDraftProfile = React.useMemo(
        () => draftScope && requestedDraftScopeBinding
            ? getServerProfileById(draftScope.serverId)
            : null,
        [draftScope, requestedDraftScopeBinding],
    );
    const requestedDraftActiveRequest = React.useMemo(
        () => requestedDraftProfile && draftScope
            ? createServerFetchAtEndpoint({
                endpointUrl: requestedDraftProfile.serverUrl,
                serverId: draftScope.serverId,
            })
            : null,
        [draftScope, requestedDraftProfile],
    );
    const resolveOrdinaryEntry = useResolveNewSessionOrdinaryEntryRoute();
    const [ordinaryEntryDraftId, setOrdinaryEntryDraftId] = useSettingMutable('newSessionOrdinaryEntryDraftId');
    const draftIdentity = React.useMemo(() => {
        const explicitIdentity = resolveNewSessionDraftRouteIdentity({ routeDraftId });
        if (!explicitIdentity.shouldWriteRouteParam) {
            return {
                draftId: explicitIdentity.draftId,
                draftOrigin: draftOrigin === 'ordinary' ? 'ordinary' as const : null,
                shouldWriteRouteParam: false,
            };
        }
        const ordinaryEntry = resolveOrdinaryEntry();
        return {
            draftId: ordinaryEntry.draftId,
            draftOrigin: ordinaryEntry.draftOrigin,
            shouldWriteRouteParam: true,
        };
    }, [draftOrigin, resolveOrdinaryEntry, routeDraftId]);
    React.useEffect(() => {
        if (!draftIdentity.shouldWriteRouteParam) return;
        router.setParams({ draftId: draftIdentity.draftId, draftOrigin: draftIdentity.draftOrigin ?? undefined });
    }, [draftIdentity.draftId, draftIdentity.draftOrigin, draftIdentity.shouldWriteRouteParam, router]);
    const draftAddress = React.useMemo(() => ({
        kind: 'newSession' as const,
        draftId: draftIdentity.draftId,
    }), [draftIdentity.draftId]);
    const subscribeDraft = React.useCallback((listener: () => void) => (
        draftScope ? subscribeSessionDraft(draftScope, draftAddress, listener) : () => undefined
    ), [draftAddress, draftScope]);
    const getDraftSnapshot = React.useCallback((): SessionDraftSnapshot | null => (
        draftScope ? getSessionDraftSnapshot(draftScope, draftAddress) : null
    ), [draftAddress, draftScope]);
    const exactDraft = React.useSyncExternalStore(subscribeDraft, getDraftSnapshot, getDraftSnapshot);
    React.useEffect(() => {
        if (draftIdentity.draftOrigin !== 'ordinary' || exactDraft?.materialized !== true) return;
        const pointerDelta = setNewSessionOrdinaryEntryDraftId(draftIdentity.draftId);
        if (pointerDelta && pointerDelta.newSessionOrdinaryEntryDraftId !== ordinaryEntryDraftId) {
            setOrdinaryEntryDraftId(pointerDelta.newSessionOrdinaryEntryDraftId);
        }
    }, [draftIdentity.draftId, draftIdentity.draftOrigin, exactDraft?.materialized, ordinaryEntryDraftId, setOrdinaryEntryDraftId]);
    const actionOperations = useAllActionOperations();
    const launchInCustody = Boolean(draftScope && exactDraft && isNewSessionDraftLaunchInCustody({
        accountId: draftScope.accountId,
        launchUserAttemptId: exactDraft.localSupplement.launchUserAttemptId,
        operations: actionOperations,
    }));
    const startAnother = React.useCallback(() => {
        openDraft(resolveOrdinaryEntry({ forceFresh: true }), 'push');
    }, [openDraft, resolveOrdinaryEntry]);
    const deleteDraft = React.useCallback(async () => {
        if (!draftScope || launchInCustody) return;
        const deleted = await deleteNewSessionDraftAfterConfirmation({
            confirm: () => Modal.confirm(
                t('sessionDrafts.delete.confirmTitle'),
                t('sessionDrafts.delete.confirmDescription'),
                { confirmText: t('common.delete'), cancelText: t('common.cancel'), destructive: true },
            ),
            readCurrentDraftDeletionDisposition: () => {
                const currentDraft = getSessionDraftSnapshot(draftScope, draftAddress);
                if (!currentDraft) return 'missing';
                return isNewSessionDraftLaunchInCustody({
                    accountId: draftScope.accountId,
                    launchUserAttemptId: currentDraft.localSupplement.launchUserAttemptId,
                    operations: readAllActionOperations(),
                }) ? 'launch-custody' : 'deletable';
            },
            deleteDraft: () => {
                if (activeDraftScope && areServerAccountScopesEqual(activeDraftScope, draftScope)) {
                    return deleteSessionDraft({ scope: draftScope, address: draftAddress });
                }
                if (!requestedDraftScopeBinding || !requestedDraftActiveRequest) return Promise.resolve(false);
                return runWithSessionDraftRepositoryScopedRuntime({
                    binding: requestedDraftScopeBinding,
                    activeRequest: requestedDraftActiveRequest,
                    operation: ({ runtime, isCurrent }) => deleteSessionDraftWithScopedRuntime({
                        scope: draftScope,
                        address: draftAddress,
                        runtime,
                        isCurrent,
                    }),
                }).then((deleted) => deleted === true);
            },
        });
        if (!deleted) return;
        const pointerDelta = clearNewSessionOrdinaryEntryDraftIdExact(
            { newSessionOrdinaryEntryDraftId: ordinaryEntryDraftId },
            draftIdentity.draftId,
        );
        if (pointerDelta) setOrdinaryEntryDraftId(pointerDelta.newSessionOrdinaryEntryDraftId);
        openDraft(resolveOrdinaryEntry({ forceFresh: true }), 'replace');
    }, [
        activeDraftScope,
        draftAddress,
        draftIdentity.draftId,
        draftScope,
        launchInCustody,
        openDraft,
        ordinaryEntryDraftId,
        requestedDraftActiveRequest,
        requestedDraftScopeBinding,
        resolveOrdinaryEntry,
        setOrdinaryEntryDraftId,
    ]);

    const tempData = React.useMemo(() => {
        return typeof dataId === 'string' ? peekTempData<NewSessionData>(dataId) : null;
    }, [dataId]);

    const hasSeededDraftIntent = React.useMemo(() => {
        if (exactDraft?.materialized === true) return true;
        return hasSeededCheckoutIntent({ checkoutCreationDraft: tempData?.checkoutCreationDraft ?? null });
    }, [exactDraft?.materialized, tempData?.checkoutCreationDraft]);

    const hasSeededRouteIntent = React.useMemo(() => {
        return (
            (typeof machineId === 'string' && machineId.trim().length > 0)
            || (typeof directory === 'string' && directory.trim().length > 0)
            || (typeof tempData?.machineId === 'string' && tempData.machineId.trim().length > 0)
            || (typeof tempData?.directory === 'string' && tempData.directory.trim().length > 0)
            || (typeof tempData?.path === 'string' && tempData.path.trim().length > 0)
        );
    }, [machineId, directory, tempData]);

    const draftConflictBanner = useSessionDraftConflictComposerBanner(exactDraft?.conflict ?? null);
    const draftSyncStatusBadge = React.useMemo(
        () => buildSessionDraftSyncStatusBadge(exactDraft?.status ?? 'clean'),
        [exactDraft?.status],
    );
    const composerTopContent = React.useMemo(() => (
        draftScope && exactDraft?.materialized === true && exactDraft.conflict && !draftConflictBanner.collapsed ? (
            <ComposerAuxiliaryFrame>
                <SessionDraftConflictResolution
                    scope={draftScope}
                    address={draftAddress}
                    conflict={exactDraft.conflict}
                />
            </ComposerAuxiliaryFrame>
        ) : null
    ), [draftAddress, draftConflictBanner.collapsed, draftScope, exactDraft?.conflict, exactDraft?.materialized]);
    const statusBadges = React.useMemo(() => [
        ...(draftSyncStatusBadge ? [draftSyncStatusBadge] : []),
        ...(draftConflictBanner.statusBadge ? [draftConflictBanner.statusBadge] : []),
    ], [draftConflictBanner.statusBadge, draftSyncStatusBadge]);
    const statusTrailingActions = React.useMemo(() => (
        draftScope && exactDraft?.materialized === true ? (
            <NewSessionDraftComposerActions
                deleteDisabled={launchInCustody}
                onStartAnother={startAnother}
                onDelete={deleteDraft}
            />
        ) : null
    ), [deleteDraft, draftScope, exactDraft?.materialized, launchInCustody, startAnother]);

    return (
        <NewSessionContent
            presentation={props.presentation}
            // Embedded, the page around the composer owns getting started (Home swaps to the
            // guidance itself while no machine can run a session).
            allowBlockingGuidance={props.presentation === 'screen' && !hasSeededDraftIntent && !hasSeededRouteIntent}
            composerTopContent={composerTopContent}
            draftId={draftIdentity.draftId}
            statusBadges={statusBadges}
            statusTrailingActions={statusTrailingActions}
            automationExactTurnRetarget={props.automationExactTurnRetarget ?? null}
            fixedDirectoryIntent={props.fixedDirectoryIntent}
        />
    );
}
