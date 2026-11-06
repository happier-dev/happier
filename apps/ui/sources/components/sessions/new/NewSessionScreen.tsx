import React from 'react';
import { Platform } from 'react-native';
import { AtmosphereSurfaceFrame } from '@/components/atmosphere/AtmosphereSurfaceFrame';
import { LookChip, type LookTarget } from '@/components/atmosphere/look/LookChip';
import { useNewSessionFloatingComposer } from '@/components/sessions/new/navigation/useNewSessionFloatingComposer';
import { StoredPluginUiNewSessionSeedOriginV1Schema } from '@happier-dev/protocol/plugins/ui';
import { ProjectSetupDraftFootnote, ProjectSetupDraftHeader } from '@/components/projects/projectSetup/ProjectSetupReturn';
import type { SessionDirectoryIntentV1 } from '@happier-dev/protocol';

import { NewSessionSimplePanel } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { NewSessionComposerCard } from '@/components/sessions/new/components/NewSessionComposerCard';
import { NewSessionWizard } from '@/components/sessions/new/components/NewSessionWizard';
import { NewSessionWebDismissal } from '@/components/sessions/new/components/NewSessionWebDismissal';
import { NewBotDraftHeader } from '@/components/sessions/bots/NewBotDraftHeader';
import type { NewSessionBotCreationModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import { NewSessionLaunchSurface } from '@/components/sessions/new/components/NewSessionLaunchSurface';
import { useNewSessionScreenModel } from '@/components/sessions/new/hooks/useNewSessionScreenModel';
import { useNewSessionDraftPresentation } from '@/components/sessions/new/hooks/useNewSessionDraftPresentation';
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
import { isNewSessionDraftLaunchOperationInCustody } from '@/components/sessions/new/modules/newSessionDraftLaunchCustody';
import { NewSessionDraftComposerActions } from '@/components/sessions/drafts/NewSessionDraftComposerActions';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { buildSessionDraftSyncStatusBadge } from '@/components/sessions/drafts/sessionDraftStatusPresentation';
import {
    SessionDraftConflictResolution,
    useSessionDraftConflictComposerBanner,
} from '@/components/sessions/drafts/SessionDraftConflictResolution';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { useActionOperationByRequestId } from '@/sync/domains/actionOperations/useActionOperations';
import {
    clearNewSessionOrdinaryEntryDraftIdExact,
    readNewSessionOrdinaryEntryDraftId,
    setNewSessionOrdinaryEntryDraftId,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import { useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useSetting } from '@/sync/store/hooks';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useServerCredentialAccountScopeBindings, useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { SessionDraftHydrationBoundary } from '@/components/sessions/drafts/SessionDraftHydrationBoundary';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';

/**
 * How the New Session surface is presented. `screen` is the `/new` route (the panel or the
 * wizard, with its own chrome). `embedded` is the same surface inside another page (Home): only
 * the composer, at the page's column width, with the host owning params and draft identity
 * (`NewSessionEmbeddedHostProvider`).
 */
export type NewSessionScreenPresentation = 'screen' | 'embedded';

function NewSessionScreenInner(props: Readonly<{
    presentation: NewSessionScreenPresentation;
    composerTopContent?: React.ReactNode;
    composerBottomContent?: React.ReactNode;
    draftId: string;
    statusBadges?: ReadonlyArray<AgentInputStatusBadge>;
    statusTrailingActions?: React.ReactNode;
    automationExactTurnRetarget?: ExactTurnAutomationPrefill | null;
    fixedDirectoryIntent?: SessionDirectoryIntentV1;
    inputPlaceholder?: string;
    composerControlPreset?: 'full' | 'compact';
}>) {
    const model = useNewSessionScreenModel(props);
    // A host that fixes part of the creation (the embed's new chat) narrows this same composer.
    const creationProfile = useNewSessionHostCreationProfile();
    const simpleProps = model.variant === 'simple' ? model.simpleProps : null;
    const inputPlaceholder = props.inputPlaceholder;
    // An embedding page's placeholder rides the composer's own input; the props keep their identity.
    const embeddedPanelProps = React.useMemo(
        () => (simpleProps && inputPlaceholder ? { ...simpleProps, inputPlaceholder } : simpleProps),
        [inputPlaceholder, simpleProps],
    );

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
                    ? <NewSessionEmbeddedComposerCard
                        panelProps={embeddedPanelProps ?? model.simpleProps}
                        creationProfile={creationProfile}
                        controlPreset={props.composerControlPreset} />
                    : <NewSessionSimplePanel {...withBotDraftPresentation(model.simpleProps, model.botCreation)} />}
            </NewSessionLaunchSurface>
        );
    }

    // The wizard's layout settings (Settings → Sessions → Wizard layout) ride with its sections.
    const { layout, sectionPresentation, useColumnLayout, profiles, agent, machine, footer } = model.wizardProps;
    // The web route card has no header, so the wizard brings its own way out (a Home embed never shows the wizard).
    const wizardWithDismissal = (wizard: React.ReactElement) => (
        Platform.OS === 'web' && props.presentation === 'screen'
            ? <NewSessionWebDismissal>{wizard}</NewSessionWebDismissal>
            : wizard
    );

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
            {wizardWithDismissal(
                <NewSessionWizard
                    popoverBoundaryRef={model.popoverBoundaryRef}
                    layout={layout}
                    sectionPresentation={sectionPresentation}
                    useColumnLayout={useColumnLayout}
                    profiles={profiles}
                    agent={agent}
                    machine={machine}
                    footer={footer}
                />,
            )}
        </NewSessionLaunchSurface>
    );
}

/**
 * A Bot draft (lab `b-new`) is the ordinary composer under its own identity: the name-as-title header
 * above the card and a placeholder that asks what it should look after. Everything else is unchanged.
 */
function withBotDraftPresentation(
    panelProps: React.ComponentProps<typeof NewSessionSimplePanel>,
    botCreation: NewSessionBotCreationModel | undefined,
): React.ComponentProps<typeof NewSessionSimplePanel> {
    if (!botCreation) return panelProps;
    return {
        ...panelProps,
        inputPlaceholder: t('bots.create.placeholder'),
        composerTopContent: (
            <>
                <NewBotDraftHeader botCreation={botCreation} />
                {panelProps.composerTopContent}
            </>
        ),
    };
}

function NewSessionEmbeddedComposerCard(props: Readonly<{
    panelProps: React.ComponentProps<typeof NewSessionSimplePanel>;
    creationProfile: NewSessionCreationProfile | undefined;
    controlPreset: 'full' | 'compact' | undefined;
}>) {
    const panelProps = useNewSessionPanelPropsForCreationProfile(props.panelProps, props.creationProfile);
    return (
        <NewSessionComposerCard
            panelProps={panelProps}
            layout="embedded"
            {...(props.controlPreset ? { controlPreset: props.controlPreset } : {})}
            {...(props.creationProfile ? {
                attachments: props.creationProfile.attachments !== false,
                voiceAffordance: 'none' as const,
            } : {})}
        />
    );
}

const NEW_SESSION_LOOK_TARGET: LookTarget = { surface: 'new-session' };

function NewSessionContent(props: Readonly<{
    presentation: NewSessionScreenPresentation;
    composerTopContent?: React.ReactNode;
    composerBottomContent?: React.ReactNode;
    draftId: string;
    statusBadges?: ReadonlyArray<AgentInputStatusBadge>;
    statusTrailingActions?: React.ReactNode;
    automationExactTurnRetarget?: ExactTurnAutomationPrefill | null;
    fixedDirectoryIntent?: SessionDirectoryIntentV1;
    inputPlaceholder?: string;
    composerControlPreset?: 'full' | 'compact';
}>) {
    // With no route card around it, the floating composer seats Look in its own status row,
    // beside Start another and Delete draft, instead of in the window's corner.
    const floatingComposer = useNewSessionFloatingComposer(props.presentation);
    const statusTrailingActions = floatingComposer ? (
        <>
            {props.statusTrailingActions}
            <LookChip target={NEW_SESSION_LOOK_TARGET} testID="new-session-look" />
        </>
    ) : props.statusTrailingActions;

    return (
        <NewSessionScreenPortalScope presentation={props.presentation}>
            {props.presentation === 'screen' ? <AtmosphereSurfaceFrame surface="new-session" showLook={!floatingComposer}>
                <NewSessionScreenInner {...props} statusTrailingActions={statusTrailingActions} />
            </AtmosphereSurfaceFrame> : <NewSessionScreenInner {...props} />}
        </NewSessionScreenPortalScope>
    );
}

/**
 * The one New Session surface: its draft identity, the ordinary-entry pointer, draft status and
 * actions, and the authoring model behind them. The `/new` route and Home both render it; the
 * host seam (`newSessionHost`) decides where its params live and how a draft change navigates.
 */
type NewSessionScreenProps = Readonly<{
    presentation: NewSessionScreenPresentation;
    automationExactTurnRetarget?: ExactTurnAutomationPrefill | null;
    /**
     * A host that decides where the session lives (the embed's new chat passes `{kind:'managed'}`).
     * The folder and checkout controls then render nothing; see `useNewSessionMachinePathState`.
     */
    fixedDirectoryIntent?: SessionDirectoryIntentV1;
    /** An embedding page's own question for the empty composer ("Ask about edge-1…"). */
    inputPlaceholder?: string;
    /** `compact`: an embedding page's ask box keeps only machine and model (see `AgentInput`). */
    composerControlPreset?: 'full' | 'compact';
}>;

export function NewSessionScreen(props: NewSessionScreenProps) {
    const { draftId: routeDraftId, draftServerId, draftAccountId } = useNewSessionHostParams<{
        draftId?: string;
        draftServerId?: string;
        draftAccountId?: string;
    }>();
    const activeDraftScope = useActiveServerAccountScope();
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const creationProfile = useNewSessionHostCreationProfile();
    const requestedDraftScopeResolution = useServerCredentialAccountScopeResolution(draftServerId);
    const draftScope = resolveNewSessionDraftRouteScope({
        activeScope: activeDraftScope,
        hostScope: creationProfile?.draftScope,
        draftServerId,
        draftAccountId,
        requestedScopeResolution: requestedDraftScopeResolution,
    });
    const bindingServerId = draftScope && !areServerAccountScopesEqual(activeLifetime?.scope, draftScope)
        ? draftScope.serverId
        : null;
    const bindingServerIds = React.useMemo(() => bindingServerId ? [bindingServerId] : [], [bindingServerId]);
    const requestedDraftScopeBindings = useServerCredentialAccountScopeBindings(bindingServerIds);
    const requestedDraftScopeBinding = draftScope
        ? [...requestedDraftScopeBindings.values()].find((binding) => (
            areServerAccountScopesEqual(binding.scope, draftScope)
        )) ?? null
        : null;
    const lifetime = draftScope && areServerAccountScopesEqual(activeLifetime?.scope, draftScope)
        ? activeLifetime
        : requestedDraftScopeBinding;
    const entryMode = useSetting('newSessionDraftEntryMode');
    const ordinaryEntryDraftId = useSetting('newSessionOrdinaryEntryDraftId');
    // Validation uses the existing route owner; allocation belongs to Ready,
    // after the remembered draft's exact read has established whether it exists.
    const routeIdentity = resolveNewSessionDraftRouteIdentity({ routeDraftId, createDraftId: () => '' });
    const explicitDraftId = routeIdentity.shouldWriteRouteParam ? null : routeIdentity.draftId;
    const requestRef = React.useRef<{
        lifetime: ServerAccountScopeLifetime | null;
        routeDraftId: string | null;
        assignedDraftId: string | null;
        addresses: readonly Readonly<{ kind: 'newSession'; draftId: string }>[];
    } | null>(null);
    let request = requestRef.current;
    if (!request || request.lifetime !== lifetime || (
        request.routeDraftId !== explicitDraftId && (explicitDraftId === null || request.assignedDraftId !== explicitDraftId)
    )) {
        const requestedDraftId = explicitDraftId ?? (entryMode === 'resumePrevious'
            ? readNewSessionOrdinaryEntryDraftId({ newSessionOrdinaryEntryDraftId: ordinaryEntryDraftId })
            : null);
        request = { lifetime, routeDraftId: explicitDraftId, assignedDraftId: null,
            addresses: requestedDraftId ? [{ kind: 'newSession', draftId: requestedDraftId }] : [] };
    }
    // Writing this surface's allocated id into its host does not turn a fresh
    // request into another hydration barrier and remount its consumed seed.
    const admissionRequest = request;
    React.useLayoutEffect(() => {
        admissionRequest.routeDraftId = explicitDraftId;
        requestRef.current = admissionRequest;
    }, [admissionRequest, explicitDraftId]);
    const onDraftIdentityResolved = React.useCallback((draftId: string) => {
        admissionRequest.assignedDraftId = draftId;
    }, [admissionRequest]);
    return <SessionDraftHydrationBoundary addresses={admissionRequest.addresses} lifetime={lifetime}
        localScope={creationProfile?.draftHydration === 'local' ? draftScope : undefined}
        fallback={props.presentation === 'embedded' ? (
            <GlassSurface testID="new-session-draft-loading" finishRole="composer">
                <ItemLoadStateRows state={{ kind: 'loading' }} rows={2} lines={1} accessibilityLabel={t('common.loading')} />
            </GlassSurface>
        ) : undefined}>
        <NewSessionScreenReady {...props} draftScope={draftScope} onDraftIdentityResolved={onDraftIdentityResolved} />
    </SessionDraftHydrationBoundary>;
}

function NewSessionScreenReady(props: NewSessionScreenProps & Readonly<{
    draftScope: ServerAccountScope | null;
    onDraftIdentityResolved: (draftId: string) => void;
}>) {
    const { router, openDraft } = useNewSessionHostNavigation();
    const { draftId: routeDraftId, draftOrigin } = useNewSessionHostParams<{
        draftId?: string;
        draftOrigin?: string;
    }>();
    const { draftScope, onDraftIdentityResolved } = props;
    const draftAction = useMountedActionExecution(draftScope);
    const resolveOrdinaryEntry = useResolveNewSessionOrdinaryEntryRoute();
    const expectedSettingsScope = useAccountSettingsScope();
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
    const committedDraftIdRef = React.useRef(draftIdentity.draftId);
    React.useLayoutEffect(() => {
        committedDraftIdRef.current = draftIdentity.draftId;
        onDraftIdentityResolved(draftIdentity.draftId);
    }, [draftIdentity.draftId, onDraftIdentityResolved]);
    React.useEffect(() => {
        if (!draftIdentity.shouldWriteRouteParam) return;
        router.setParams({ draftId: draftIdentity.draftId, draftOrigin: draftIdentity.draftOrigin ?? undefined });
    }, [draftIdentity.draftId, draftIdentity.draftOrigin, draftIdentity.shouldWriteRouteParam, router]);
    const draftAddress = React.useMemo(() => ({
        kind: 'newSession' as const,
        draftId: draftIdentity.draftId,
    }), [draftIdentity.draftId]);
    const exactDraft = useNewSessionDraftPresentation(draftScope, draftIdentity.draftId);
    React.useEffect(() => {
        if (draftIdentity.draftOrigin !== 'ordinary' || exactDraft?.materialized !== true) return;
        const pointerDelta = setNewSessionOrdinaryEntryDraftId(draftIdentity.draftId);
        if (!pointerDelta) return;
        if (getStorage().getState().settings.newSessionOrdinaryEntryDraftId === pointerDelta.newSessionOrdinaryEntryDraftId) return;
        getSyncSingleton().applySettings(pointerDelta, { expectedSettingsScope, source: 'ui' });
    }, [expectedSettingsScope, draftIdentity.draftId, draftIdentity.draftOrigin, exactDraft?.materialized]);
    const launchUserAttemptId = exactDraft?.launchUserAttemptId ?? null;
    const launchOperation = useActionOperationByRequestId(
        launchUserAttemptId,
        draftScope?.serverId ?? null,
        draftScope?.accountId ?? null,
    );
    const launchInCustody = Boolean(draftScope && isNewSessionDraftLaunchOperationInCustody({
        accountId: draftScope.accountId,
        launchUserAttemptId,
        operation: launchOperation,
    }));
    const startAnother = React.useCallback(() => {
        openDraft(resolveOrdinaryEntry({ forceFresh: true }));
    }, [openDraft, resolveOrdinaryEntry]);
    const deleteDraft = React.useCallback(async () => {
        if (!draftScope || launchInCustody) return;
        const outcome = await draftAction.execute('session.draft.delete', { draftId: draftIdentity.draftId });
        if (!outcome.ok || !draftAction.isCurrent()) return;
        const deleted = AppShellActionOutputSchemas['session.draft.delete'].safeParse(outcome.result);
        if (!deleted.success || deleted.data.status !== 'deleted') return;
        const pointerDelta = clearNewSessionOrdinaryEntryDraftIdExact(
            getStorage().getState().settings,
            draftIdentity.draftId,
        );
        if (pointerDelta) getSyncSingleton().applySettings(pointerDelta, { expectedSettingsScope, source: 'ui' });
        if (committedDraftIdRef.current === draftIdentity.draftId) {
            openDraft(resolveOrdinaryEntry({ forceFresh: true }));
        }
    }, [
        draftAction.execute,
        draftAction.isCurrent,
        draftIdentity.draftId,
        draftScope,
        launchInCustody,
        openDraft,
        expectedSettingsScope,
        resolveOrdinaryEntry,
    ]);

    const draftConflictBanner = useSessionDraftConflictComposerBanner(exactDraft?.conflict ?? null);
    const draftSyncStatusBadge = React.useMemo(
        () => buildSessionDraftSyncStatusBadge(exactDraft?.status ?? 'clean'),
        [exactDraft?.status],
    );
    const authoringOriginValue = exactDraft?.authoringOrigin;
    const authoringOriginKey = authoringOriginValue === undefined ? null : JSON.stringify(authoringOriginValue);
    // The draft's Project origin keeps its identity until its stored value changes.
    const authoringOrigin = React.useMemo(() => {
        const parsed = StoredPluginUiNewSessionSeedOriginV1Schema.safeParse(authoringOriginValue);
        return parsed.success ? parsed.data : null;
    }, [authoringOriginKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const composerTopContent = React.useMemo(() => (
        draftScope && exactDraft?.materialized === true && exactDraft.conflict && !draftConflictBanner.collapsed ? (
            <ComposerAuxiliaryFrame>
                <SessionDraftConflictResolution
                    scope={draftScope}
                    address={draftAddress}
                    conflict={exactDraft.conflict}
                />
            </ComposerAuxiliaryFrame>
        ) : authoringOrigin ? (
            <ProjectSetupDraftHeader origin={authoringOrigin} />
        ) : null
    ), [authoringOrigin, draftAddress, draftConflictBanner.collapsed, draftScope, exactDraft?.conflict, exactDraft?.materialized]);
    // A seeded Project draft says where it will author and that nothing starts before Send (lab `s-setup` ENTRY).
    const composerBottomContent = React.useMemo(
        () => (authoringOrigin ? <ProjectSetupDraftFootnote origin={authoringOrigin} /> : null),
        [authoringOrigin],
    );
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
            // The model and its Composer custody are initialized for one exact draft.
            key={draftIdentity.draftId}
            presentation={props.presentation}
            composerTopContent={composerTopContent}
            composerBottomContent={composerBottomContent}
            draftId={draftIdentity.draftId}
            statusBadges={statusBadges}
            statusTrailingActions={statusTrailingActions}
            automationExactTurnRetarget={props.automationExactTurnRetarget ?? null}
            fixedDirectoryIntent={props.fixedDirectoryIntent}
            inputPlaceholder={props.inputPlaceholder}
            composerControlPreset={props.composerControlPreset}
        />
    );
}
