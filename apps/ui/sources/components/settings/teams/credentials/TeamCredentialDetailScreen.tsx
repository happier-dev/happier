import * as React from 'react';
import type { TeamCredentialTestActionOutputV1 } from '@happier-dev/protocol/teams';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import {
    deleteTeamCredentialResource,
    getTeamCredentialPreparation,
    testTeamCredentialResource,
    updateTeamCredentialResource,
} from '@/sync/ops/teams/teamCredentialOperations';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import {
    teamCredentialAccessPath,
    teamCredentialActivityPath,
    teamCredentialEditPath,
    teamCredentialExternalApiPath,
    teamCredentialLimitsPath,
    teamCredentialRequestPolicyPath,
    teamCredentialUsagePath,
    teamCredentialsPath,
} from '../teamsRoutes';
import {
    audienceSummary,
    brokerPlacementLabel,
    credentialApprovalFailureMessage,
    credentialFailureMessage,
    deliveryModeLabel,
    recipientDeliveryMode,
    requestPolicySummary,
    resourceDeliverySummary,
    resourceStateLabel,
    sessionUsePolicyLabel,
    sourceKindLabel,
} from './teamCredentialPresentation';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';
import {
    recoveryDestinationIsNavigable,
    teamCredentialRecoveryLabel,
    teamCredentialRecoveryPresentation,
    type TeamCredentialRecoveryPresentation,
} from './teamCredentialPresentation';
import { useTeamCredentialResourceView } from './useTeamCredentialResourceView';
import { useTeamCredentialExternalApiAvailability } from './useTeamCredentialExternalApiAvailability';
import { Icon } from '@/components/ui/icons/Icon';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { resourceConnectedServiceMarkId } from './teamCredentialPresentation';

function directMaterialStateLabel(state: NonNullable<ReturnType<typeof useTeamCredentialResourceView>['catalogResource']>['directMaterialState']): string {
    switch (state) {
        case 'current': return t('teams.credentials.directReadiness.state.ready');
        case 'preparing': return t('teams.credentials.directReadiness.state.preparing');
        case 'never_delivered': return t('teams.credentials.directReadiness.state.notDelivered');
        case 'stale': return t('teams.credentials.directReadiness.state.sourceChanged');
        case 'revoked': return t('teams.credentials.detail.notFound');
    }
}

type CredentialTestResult = Readonly<{ message: string; code?: string; detail?: string }>;

function presentTestResult(result: TeamCredentialTestActionOutputV1, sourceOwnerDisplayName: string | null): CredentialTestResult {
    return {
        message: result.recovery ?? resourceStateLabel(result.readiness, sourceOwnerDisplayName),
        code: result.failureDetail?.code ?? result.code ?? (result.result === 'needs_attention'
            ? ('reason' in result.readiness ? result.readiness.reason : undefined) ?? result.readiness.kind
            : undefined),
        detail: result.failureDetail ? JSON.stringify({
            stage: result.failureDetail.stage,
            httpStatus: result.failureDetail.httpStatus,
            requestId: result.requestId,
        }, null, 2) : result.requestId,
    };
}

/**
 * The one recovery row the Home's recovery action maps to.
 *
 * Every destination already exists — reload, the resource's own Settings where
 * the source and broker placement live, the app-update owner — and the handoff
 * and choose-another arms are instructions rather than navigations. Whoever
 * reaches this row was allowed here by the Home; the mapper only says what the
 * typed recovery action means, never who may perform it.
 */
const CredentialRecoveryRow = React.memo(function CredentialRecoveryRow(props: Readonly<{
    recovery: TeamCredentialRecoveryPresentation;
    retryTestID: string;
    onRetry: () => void;
    onOpenResourceSettings: () => void;
    onAppUpdate: () => void;
    onChooseAnotherResource: () => void;
}>) {
    const navigable = recoveryDestinationIsNavigable(props.recovery.destination);
    const label = teamCredentialRecoveryLabel(props.recovery);
    const isRetry = props.recovery.destination === 'retry';
    // The resource cannot be used as it is: say so above its details, with the one recovery it has.
    return (
        <AttentionBanner
            testID="team-credential-recovery-notice"
            title={label}
            action={navigable ? {
                label: isRetry ? t('teams.unavailable.retry') : label,
                testID: isRetry ? props.retryTestID : 'team-credential-recovery',
                onPress: () => {
                    if (isRetry) props.onRetry();
                    else if (props.recovery.destination === 'app_update') props.onAppUpdate();
                    else if (props.recovery.destination === 'choose_another_resource') props.onChooseAnotherResource();
                    else props.onOpenResourceSettings();
                },
            } : null}
        />
    );
});

/**
 * One shared credential.
 *
 * The overview is Settings-native: a header that says what the resource is and
 * whether it is usable, then grouped rows that open the focused destinations.
 * There is no second navigation system inside it, and opening it loads neither
 * activity nor anything else a person did not ask for.
 */
const CredentialDetail = React.memo(function CredentialDetail(props: Readonly<{
    context: TeamSectionContext;
    resourceId: string;
    conditionBanners?: React.ReactNode;
}>) {
    const router = useRouter();
    const { context, resourceId } = props;
    const view = useTeamCredentialResourceView({ context, resourceId });
    const externalApiAvailability = useTeamCredentialExternalApiAvailability(context.scope.serverId);
    const [mutating, setMutating] = React.useState(false);
    // An unresolved approval already carries this screen's last write, so every
    // control it owns stays visible and disabled rather than disappearing.
    const busy = mutating || view.writesSuspended;
    const [notice, setNotice] = React.useState<string | null>(null);
    const [preparationPending, setPreparationPending] = React.useState<number | null>(null);
    const [preparationBusy, setPreparationBusy] = React.useState(false);
    const [testBusy, setTestBusy] = React.useState(false);
    const [testResult, setTestResult] = React.useState<CredentialTestResult | null>(null);
    const targetKey = `${context.scope.serverId}:${context.scope.accountId}:${context.address.teamId}:${resourceId}`;
    const currentTargetKey = React.useRef(targetKey);
    currentTargetKey.current = targetKey;
    const actionLifetime = React.useRef<AbortController | null>(null);

    React.useEffect(() => {
        const controller = new AbortController();
        actionLifetime.current = controller;
        setMutating(false);
        setNotice(null);
        setPreparationPending(null);
        setPreparationBusy(false);
        setTestBusy(false);
        setTestResult(null);
        return () => controller.abort();
    }, [targetKey]);

    // Identity first: the page opens with the credential itself — its name, and who shared it —
    // rather than a generic title over a section repeating the name.
    const named = view.resource ?? view.catalogResource;
    const registry = useProjectedConnectedServicesRegistry();
    const sharedBy = view.resource
        ? view.resource.custodianAccountId === context.scope.accountId
            ? t('teams.credentials.sharedByYou')
            : view.resource.sourceOwnerDisplayName
        : null;
    const frame = (body: React.ReactNode) => (
        <>
            <PageHeader
                testID="team-credential-header"
                alwaysShowTitle
                title={named?.displayName ?? t('teams.credentials.title')}
                leading={named ? <ConnectedServiceMark legacyServiceId={resourceConnectedServiceMarkId(named, registry)} size="page" /> : undefined}
                description={named ? (sharedBy ?? t('teams.pages.credentialDetail')) : t('teams.pages.credentialDetail')}
            />
            {props.conditionBanners}
            {body}
        </>
    );

    if (!view.featureEnabled) {
        return frame(
            <SurfaceStateCard
                testID="team-credential-unavailable"
                kind="unavailable"
                size="pane"
                iconName="key"
                title={t('teams.credentials.unavailable')}
            />,
        );
    }

    if (view.resource === null && view.catalogResource !== null) {
        const resource = view.catalogResource;
        // A least-privilege catalog row carries no custodian identity, so a
        // recipient is never treated as the person who can repair the source;
        // the Home's handoff instruction is rendered as is.
        const recipientRecovery = teamCredentialRecoveryPresentation(resource.recoveryAction, {
            isSourceCustodian: false,
        });
        return frame(
            <>
                <ItemGroup>
                    <Item
                        testID="team-credential-recipient-source"
                        title={t('teams.credentials.detail.sourceLabel')}
                        detail={sourceKindLabel(resource.sourcePresentation)}
                        showChevron={false}
                    />
                    <Item
                        testID="team-credential-recipient-state"
                        title={resourceStateLabel(resource.readiness)}
                        detail={(() => {
                            const mode = recipientDeliveryMode(resource);
                            return mode ? deliveryModeLabel(mode) : undefined;
                        })()}
                        showChevron={false}
                    />
                    {resource.sessionUsePolicy ? (
                        <Item
                            testID="team-credential-recipient-use-policy"
                            title={t('teams.credentials.usePolicy.label')}
                            detail={sessionUsePolicyLabel(resource.sessionUsePolicy)}
                            showChevron={false}
                        />
                    ) : null}
                    {resource.mayReceiveDirect ? (
                        <Item
                            testID="team-credential-recipient-direct-readiness"
                            title={t('teams.credentials.directReadiness.title')}
                            detail={directMaterialStateLabel(resource.directMaterialState)}
                            showChevron={false}
                        />
                    ) : null}
                </ItemGroup>
                <ItemGroup>
                    <Item
                        testID="team-credential-recipient-open-usage"
                        icon={<Icon name="chart-bar" />}
                        title={t('teams.credentials.detail.usage')}
                        onPress={() => router.push(teamCredentialUsagePath(context.address, resourceId))}
                    />
                    {resource.mayBroker && externalApiAvailability.available ? (
                        <Item
                            testID="team-credential-open-external-api"
                            icon={<Icon name="globe" />}
                            title={t('teams.credentials.externalApi.title')}
                            onPress={() => router.push(teamCredentialExternalApiPath(context.address, resourceId))}
                        />
                    ) : null}
                </ItemGroup>
                {recipientRecovery === null ? null : (
                    <CredentialRecoveryRow
                        recovery={recipientRecovery}
                        retryTestID="team-credential-recipient-retry"
                        onRetry={() => void view.reload()}
                        onOpenResourceSettings={() => router.push(teamCredentialEditPath(context.address, resourceId))}
                        onAppUpdate={() => router.push(UPDATES_ROUTE)}
                        onChooseAnotherResource={() => router.push(teamCredentialsPath(context.address))}
                    />
                )}
            </>,
        );
    }

    if (view.resource === null) {
        // Until the Home has answered, absence proves nothing; afterwards it is
        // the answer, and the retry belongs to whichever of the two it is.
        return frame(view.resolved ? (
            <SurfaceStateCard
                testID="team-credential-not-found"
                kind="unavailable"
                size="pane"
                title={t('teams.errors.notFound')}
                reason={t('teams.credentials.detail.notFound')}
                action={{ label: t('teams.credentials.title'), onPress: () => router.push(teamCredentialsPath(context.address)) }}
            />
        ) : view.error ? (
            <ItemGroup>
                <SurfaceStateCard
                    testID="team-credential-error"
                    kind="error"
                    size="line"
                    title={t('teams.unavailable.offline')}
                    action={{ label: t('common.retry'), testID: 'team-credential-retry', onPress: () => void view.reload() }}
                    accessibilitySemantics="alert"
                />
            </ItemGroup>
        ) : (
            <ItemGroup>
                <ItemLoadStateRows
                    testID="team-credential-loading"
                    state={{ kind: 'loading' }}
                    rows={4}
                    accessibilityLabel={t('common.loading')}
                />
            </ItemGroup>
        ));
    }

    const { resource } = view;
    // The Home discloses the audience, and admits the administrative history,
    // only to the viewer who administers resources. A member's empty grant lists
    // therefore mean "not shown" and must not be read as state, and the two
    // destinations that would be refused are not offered.
    const { capabilities } = resource;
    const delivery = capabilities.manageAudience ? resourceDeliverySummary(resource) : null;
    const brokerConnectionSemantics = resource.brokerPlacement?.kind === 'machine_pool'
        ? t('machinePools.connectionSemantics')
        : undefined;
    // The Home's typed recovery for this exact resource. Only its source
    // custodian can repair the source or move the broker, so anyone else —
    // including a Team manager — is handed to the owner rather than being
    // offered a Settings destination that would refuse them.
    const administratorRecovery = teamCredentialRecoveryPresentation(resource.recoveryAction, {
        isSourceCustodian: capabilities.updateBrokerPlacement
            || capabilities.narrowDisclosure
            || capabilities.refreshDirectMaterial,
    });

    return frame(
        <>
            <ItemGroup>
                {notice ? (
                    <SurfaceStateCard
                        testID="team-credential-notice"
                        kind="error"
                        size="line"
                        title={notice}
                        accessibilitySemantics="alert"
                    />
                ) : null}
                <Item
                    testID="team-credential-source"
                    title={t('teams.credentials.detail.sourceLabel')}
                    detail={sourceKindLabel(resource.source ?? resource.sourcePresentation)}
                    showChevron={false}
                />
                <Item
                    testID="team-credential-state"
                    title={resourceStateLabel(resource.readiness, resource.sourceOwnerDisplayName)}
                    // The last test's answer, while there is one, says more than the delivery line.
                    subtitle={testResult?.code ? delivery ?? undefined : testResult?.message ?? delivery ?? undefined}
                    showChevron={false}
                    rightElement={(
                        <RoundButton
                            testID="team-credential-test"
                            size="small"
                            display="secondary"
                            title={t('settingsProviders.detail.testConnection')}
                            loading={testBusy}
                            // Test registers its own approval, so it shares this
                            // screen's approval custody: starting a second unresolved
                            // Action would orphan the decision already waiting.
                            disabled={testBusy || busy}
                            onPress={async () => {
                                if (testBusy || busy) return;
                                const requestedTargetKey = targetKey;
                                setTestBusy(true);
                                setTestResult(null);
                                try {
                                    const outcome = await testTeamCredentialResource({
                                        scope: context.scope,
                                        teamId: context.address.teamId,
                                        resourceId,
                                        handlers: {
                                            // Test is the one intent whose whole value
                                            // is its answer. A deferred approval must
                                            // still deliver that readiness, not a bare
                                            // "it ran".
                                            onApprovalSucceeded: (result) => {
                                                if (currentTargetKey.current !== requestedTargetKey) return;
                                                setTestResult(presentTestResult(result, resource.sourceOwnerDisplayName));
                                            },
                                            onApprovalFailed: (code) => {
                                                if (currentTargetKey.current !== requestedTargetKey) return;
                                                setTestResult({ message: credentialApprovalFailureMessage(code), code });
                                            },
                                        },
                                    });
                                    if (currentTargetKey.current !== requestedTargetKey) return;
                                    if (outcome.kind === 'succeeded') {
                                        setTestResult(presentTestResult(outcome.value, resource.sourceOwnerDisplayName));
                                    } else {
                                        setTestResult({ message: credentialFailureMessage(outcome.failure), code: outcome.failure.code ?? undefined });
                                    }
                                } catch (cause) {
                                    if (currentTargetKey.current !== requestedTargetKey) return;
                                    if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
                                    else setTestResult({ message: t('teams.errors.generic') });
                                } finally {
                                    if (currentTargetKey.current === requestedTargetKey) setTestBusy(false);
                                }
                            }}
                        />
                    )}
                />
                {testResult?.code ? (
                    <SurfaceStateCard
                        key={`${testResult.code}:${testResult.detail ?? ''}`}
                        testID="team-credential-test-result"
                        kind="error"
                        size="line"
                        title={testResult.message}
                        diagnosticCode={testResult.code}
                        diagnosticDetail={testResult.detail}
                        accessibilitySemantics="alert"
                    />
                ) : null}
{capabilities.managePolicy ? <Item
                    testID="team-credential-use-policy"
                    title={t('teams.credentials.usePolicy.label')}
                    detail={sessionUsePolicyLabel(resource.sessionUsePolicy)}
                    subtitle={resource.sessionUsePolicy === 'team_visibility_required'
                        ? t('teams.credentials.usePolicy.visibilityNote')
                        : undefined}
                    showChevron={false}
                /> : null}
                {resource.source !== null ? <Item
                    testID="team-credential-broker"
                    title={t('teams.credentials.detail.brokerLabel')}
                    // The stored placement is the Home's own opaque Machine id,
                    // and it names a machine belonging to the source custodian
                    // rather than to the reader. Printing it would put a raw
                    // internal identifier on a settings screen without making
                    // anyone able to act on it.
                    detail={brokerPlacementLabel(resource)}
                    subtitle={brokerConnectionSemantics}
                    accessibilityLabel={[t('teams.credentials.detail.brokerLabel'), brokerPlacementLabel(resource), brokerConnectionSemantics]
                        .filter(Boolean).join('. ')}
                    showChevron={false}
                /> : null}
            </ItemGroup>

            {administratorRecovery !== null ? (
                <CredentialRecoveryRow
                    recovery={administratorRecovery}
                    retryTestID="team-credential-admin-retry"
                    onRetry={() => void view.reload()}
                    onOpenResourceSettings={() => router.push(teamCredentialEditPath(context.address, resourceId))}
                    onAppUpdate={() => router.push(UPDATES_ROUTE)}
                    onChooseAnotherResource={() => router.push(teamCredentialsPath(context.address))}
                />
            ) : null}

            {capabilities.refreshDirectMaterial ? (
                <ItemGroup>
                    <Item
                        testID="team-credential-preparation"
                        title={t('teams.credentials.directReadiness.title')}
                        subtitle={(preparationPending === null
                            ? undefined
                            : preparationPending === 0
                                ? t('teams.credentials.directReadiness.allReady')
                                : t('session.access.preparationPending', { count: preparationPending })) ?? t('teams.credentials.directReadiness.automatic')}
                        subtitleLines={0}
                        showChevron={false}
                        rightElement={(
                            <RoundButton
                                testID="team-credential-preparation-refresh"
                                size="small"
                                display="secondary"
                                title={t('teams.credentials.directReadiness.check')}
                                loading={preparationBusy}
                                // All user intents share the Action admission owner.
                                disabled={preparationBusy || busy}
                                onPress={async () => {
                            if (preparationBusy || busy) return;
                            const requestedTargetKey = targetKey;
                            setPreparationBusy(true);
                            setNotice(null);
                            try {
                                const outcome = await getTeamCredentialPreparation({
                                    scope: context.scope,
                                    teamId: context.address.teamId,
                                    resourceId,
                                    signal: actionLifetime.current?.signal,
                                });
                                if (currentTargetKey.current !== requestedTargetKey) return;
                                if (outcome.kind === 'failed') {
                                    setNotice(credentialFailureMessage(outcome.failure));
                                    return;
                                }
                                setPreparationPending(outcome.value.counts.pending);
                            } catch (cause) {
                                if (currentTargetKey.current !== requestedTargetKey) return;
                                if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
                                else setNotice(t('teams.errors.generic'));
                            } finally {
                                if (currentTargetKey.current === requestedTargetKey) setPreparationBusy(false);
                            }
                        }}
                            />
                        )}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup>
                {capabilities.manageAudience ? (
                    <Item
                        testID="team-credential-open-access"
                        icon={<Icon name="users" />}
                        title={t('teams.credentials.detail.access')}
                        detail={audienceSummary(resource)}
                        onPress={() => router.push(teamCredentialAccessPath(context.address, resourceId))}
                    />
                ) : null}
                {capabilities.managePolicy ? (
                    <Item
                        testID="team-credential-open-request-policy"
                        icon={<Icon name="shield-check" />}
                        title={t('teams.credentials.requestPolicy.title')}
                        detail={requestPolicySummary(resource)}
                        onPress={() => router.push(teamCredentialRequestPolicyPath(context.address, resourceId))}
                    />
                ) : null}
                {capabilities.manageAudience || capabilities.managePolicy || capabilities.manageLimits ? (
                    <Item
                        testID="team-credential-open-activity"
                        icon={<Icon name="clock-counter-clockwise" />}
                        title={t('teams.credentials.detail.activity')}
                        onPress={() => router.push(teamCredentialActivityPath(context.address, resourceId))}
                    />
                ) : null}
                {capabilities.manageLimits ? (
                    <Item
                        testID="team-credential-open-limits"
                        icon={<Icon name="speedometer" />}
                        title={t('teams.credentials.detail.limits')}
                        onPress={() => router.push(teamCredentialLimitsPath(context.address, resourceId))}
                    />
                ) : null}
                <Item
                    testID="team-credential-open-usage"
                    icon={<Icon name="chart-bar" />}
                    title={t('teams.credentials.detail.usage')}
                    onPress={() => router.push(teamCredentialUsagePath(context.address, resourceId))}
                />
                {capabilities.managePolicy && (
                    externalApiAvailability.available
                    || externalApiAvailability.reason === 'home_not_public_https'
                ) ? (
                    <Item
                        testID="team-credential-open-external-api"
                        icon={<Icon name="globe" />}
                        title={t('teams.credentials.externalApi.title')}
                        detail={externalApiAvailability.available
                            ? t('teams.credentials.state.available')
                            : externalApiAvailability.reason === 'home_not_public_https'
                                ? t('teams.credentials.externalApi.publicHttpsRequired')
                                : t('teams.credentials.externalApi.unavailable')}
                        onPress={() => router.push(teamCredentialExternalApiPath(context.address, resourceId))}
                    />
                ) : null}
                {context.canMutate && (capabilities.updateBrokerPlacement || capabilities.narrowDisclosure || capabilities.managePolicy) ? (
                    <Item
                        testID="team-credential-open-edit"
                        icon={<Icon name="pencil-simple" />}
                        title={t('teams.credentials.detail.edit')}
                        onPress={() => router.push(teamCredentialEditPath(context.address, resourceId))}
                    />
                ) : null}
            </ItemGroup>

            {(capabilities.delete || (resource.enabled && capabilities.disable) || (!resource.enabled && capabilities.enable)) ? (
                // The lifecycle closes the page as one quiet row: turning it off or on, then deleting it,
                // destructive and last (one button row, not rows in a sheet).
                <ItemGroup surface="none">
                    <SectionButtonRow trailing={capabilities.delete ? (
                        <RoundButton
                            testID="team-credential-delete"
                            size="small"
                            display="destructive"
                            title={t('teams.credentials.delete.action')}
                            loading={busy}
                            disabled={busy}
                                onPress={async () => {
                                    const requestedTargetKey = targetKey;
                                    const signal = actionLifetime.current?.signal;
                                    if (!signal || signal.aborted) return;
                                    if (currentTargetKey.current !== requestedTargetKey) return;
                                    setMutating(true);
                                    setNotice(null);
                                    try {
                                        const outcome = await deleteTeamCredentialResource({
                                            scope: context.scope,
                                            address: context.address,
                                            resourceId,
                                            expectedRevision: resource.revision,
                                            signal,
                                            handlers: {
                                                // The resource this screen is about no
                                                // longer exists once the approval runs,
                                                // so staying here would render a
                                                // not-found page over a completed
                                                // action. Leave exactly as an immediate
                                                // delete leaves.
                                                onApprovalSucceeded: () => {
                                                    if (currentTargetKey.current !== requestedTargetKey) return;
                                                    router.replace(teamCredentialsPath(context.address));
                                                },
                                                onApprovalFailed: (code) => {
                                                    if (currentTargetKey.current !== requestedTargetKey) return;
                                                    setNotice(credentialApprovalFailureMessage(code));
                                                },
                                            },
                                        });
                                        if (currentTargetKey.current !== requestedTargetKey) return;
                                        if (outcome.kind === 'succeeded') {
                                            router.replace(teamCredentialsPath(context.address));
                                            return;
                                        }
                                        // The Home named this refusal; the screen shows
                                        // the recovery that refusal actually implies.
                                        setNotice(credentialFailureMessage(outcome.failure));
                                    } catch (cause) {
                                        if (currentTargetKey.current !== requestedTargetKey) return;
                                        if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
                                        else setNotice(t('teams.errors.generic'));
                                    } finally {
                                        if (currentTargetKey.current === requestedTargetKey) setMutating(false);
                                    }
                                }}
                            />
                    ) : undefined}>
                        {((resource.enabled && capabilities.disable) || (!resource.enabled && capabilities.enable)) ? (
                            <RoundButton
                                testID="team-credential-toggle-enabled"
                                size="small"
                                display="secondary"
                                title={resource.enabled ? t('common.disable') : t('common.enable')}
                                disabled={busy}
                                onPress={async () => {
                            const requestedTargetKey = targetKey;
                            const signal = actionLifetime.current?.signal;
                            if (!signal || signal.aborted) return;
                            if (currentTargetKey.current !== requestedTargetKey) return;
                            setMutating(true);
                            setNotice(null);
                            try {
                                const outcome = await updateTeamCredentialResource({
                                    scope: context.scope,
                                    address: context.address,
                                    resourceId,
                                    expectedRevision: resource.revision,
                                    enabled: !resource.enabled,
                                    signal,
                                    handlers: {
                                        // The projection was already invalidated
                                        // for this exact Team when the approval
                                        // executed; clearing the notice is what
                                        // tells the person their change landed.
                                        onApprovalSucceeded: () => {
                                            if (currentTargetKey.current !== requestedTargetKey) return;
                                            setNotice(null);
                                            void view.reload();
                                        },
                                        onApprovalFailed: (code) => {
                                            if (currentTargetKey.current !== requestedTargetKey) return;
                                            setNotice(credentialApprovalFailureMessage(code));
                                        },
                                    },
                                });
                                if (currentTargetKey.current !== requestedTargetKey) return;
                                if (outcome.kind === 'succeeded') {
                                    fireAndForget(view.reload(), { tag: 'TeamCredentialDetailScreen.revalidate' });
                                } else {
                                    setNotice(credentialFailureMessage(outcome.failure));
                                }
                            } catch (cause) {
                                if (currentTargetKey.current !== requestedTargetKey) return;
                                if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
                                else setNotice(t('teams.errors.generic'));
                            } finally {
                                if (currentTargetKey.current === requestedTargetKey) setMutating(false);
                            }
                        }}
                            />
                        ) : null}
                    </SectionButtonRow>
                </ItemGroup>
            ) : null}
        </>,
    );
});

export const TeamCredentialDetailScreen = React.memo(function TeamCredentialDetailScreen(props: Readonly<{
    serverId: string;
    teamId: string;
    resourceId: string;
}>) {
    return (
        <TeamSection serverId={props.serverId} teamId={props.teamId} title={t('teams.credentials.title')} description={t('teams.pages.credentialDetail')} childRendersHeader>
            {(context, conditionBanners) => <CredentialDetail context={context} resourceId={props.resourceId} conditionBanners={conditionBanners} />}
        </TeamSection>
    );
});
