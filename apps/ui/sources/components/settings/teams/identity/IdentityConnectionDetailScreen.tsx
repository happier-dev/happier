import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useFocusEffect } from '@/components/appShell/workspace/destinationRoute';
import { AppState } from 'react-native';
import type { IdentityConnectionTestDiagnosticsV1 } from '@happier-dev/protocol';
import type { IdentityConnectionV1 } from '@happier-dev/protocol/teams';

import { runTeamIdentityProviderTestReturn } from '@/components/settings/home/identity/identityProviderTestReturn';
import { useManagedIdentityProviders } from '@/components/settings/home/identity/useManagedIdentityProviders';
import { IdentityTestDiagnosticsGroup } from '@/components/settings/identity/IdentityTestDiagnosticsGroup';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { WorkosMark } from '@/components/settings/identity/WorkosMark';
import { resolveTestedSignInConnectionStatus, signInConnectionStatusLabel } from '@/components/settings/identity/signInConnectionStatus';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SetupSteps, type SetupStep } from '@/components/ui/setupBlocks/SetupSteps';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { TEAM_IDENTITY_CONNECTION_SETTINGS as TEAM_CONNECTION_SETTINGS, HOME_IDENTITY_CONNECTION_SETTINGS } from './teamAuthenticationSettings';
import { Modal } from '@/modal';
import { identityAdministrationFailure, identityAdministrationFailureMessage, identityAdministrationFailureRecoveryLabel } from '@/components/settings/identity/identityAdministrationFailure';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import { TeamSection } from '../TeamSection';
import { teamDirectoryPath, teamIdentityConnectionPath, teamIdentityConnectionProviderEditPath } from '../teamsRoutes';
import {
    createIdentityAdministrationClient,
    identityAdministrationActionId,
    executeIdentityAdministrationRead,
    type IdentityAdministrationActionResult,
    type TeamIdentityActionOutput,
} from './identityAdministrationClient';
import {
    connectionStateLabel,
    identityConnectionMode,
    identityProviderKindLabel,
    identityProviderKindIconName,
    workosConnectionStatusLabel,
    workosConnectionStrategyLabel,
    workosSetupSteps,
    type WorkosSetupStep,
} from './identityAdministrationPresentation';
import { useIdentityAdministration } from './useIdentityAdministration';
import { createWorkosPortalReturnController } from './workosPortalReturn';
import { IdentityConnectionGroupMappings } from './IdentityConnectionGroupMappings';
import {
    connectionSettingsFromDraft,
    type OidcConnectionSettingsDraft,
} from './teamIdentitySetup';
import {
    revisionedSettingsDraftTransition,
    type RevisionedSettingsDraftOrigin,
} from '@/components/settings/identity/revisionedSettingsDraft';
import { Icon } from '@/components/ui/icons/Icon';
import { homeAdministrationIdentityConnectionPath, homeAdministrationPoliciesPath } from '@/components/settings/home/governance/homeAdministrationRoutes';
const TEAM_IDENTITY_CONNECTION_SETTINGS = TEAM_CONNECTION_SETTINGS;

const TeamManagedProviderEditItem = React.memo(function TeamManagedProviderEditItem(props: Readonly<{
    scope: Parameters<typeof useManagedIdentityProviders>[0];
    address: Readonly<{ serverId: string; teamId: string }>;
    connectionId: string;
    providerId: string;
    disabled: boolean;
    requestApproval: (registration: ActionApprovalRegistration) => void;
}>) {
    const router = useRouter();
    const owner = React.useMemo(() => ({ kind: 'team' as const, teamId: props.address.teamId }), [props.address.teamId]);
    const providers = useManagedIdentityProviders(props.scope, owner, props.requestApproval);
    if (providers.state.kind !== 'ready' || !providers.state.items.some((provider) => provider.id === props.providerId)) return null;
    return <SettingRow
        setting={TEAM_CONNECTION_SETTINGS.settings.edit}
        testID="team-identity-provider-edit"
        icon={<Icon name="pencil-simple" />}
        disabled={props.disabled}
        onPress={() => router.push(teamIdentityConnectionProviderEditPath(props.address, props.connectionId, props.providerId))}
        showChevron
    />;
});

/**
 * A WorkOS connection whose organization exists but whose SSO setup has not been
 * confirmed yet: the Admin Portal may have just finished it, so arriving on the
 * route is the moment to check. A connected row needs an explicit Portal return.
 */
function isWorkosSetupAwaitingCheck(connection: Pick<IdentityConnectionV1, 'provider' | 'externalReference' | 'state'>): boolean {
    return connection.provider.kind === 'workos_sso'
        && connection.externalReference.kind === 'workos_sso'
        && connection.externalReference.organizationId !== null
        && (connection.state === 'setting_up' || connection.state === 'needs_attention');
}


type WorkosCandidate = Readonly<{ connectionId: string; displayName: string; strategy: string; status: string }>;
type TeamConnectionRemovalImpact = Readonly<{
    linkedAccounts: number;
    accountsRequiringAlternateLogin: number;
    directorySources: number;
    externalGroupBindings: number;
    managedMemberships: number;
}>;

/** A WorkOS draft cannot sign anyone in, so it is shown but never chosen. */
function isWorkosDraftCandidate(candidate: WorkosCandidate): boolean {
    return candidate.status.trim().toLowerCase() === 'draft';
}

function workosCandidateSummary(candidate: Pick<WorkosCandidate, 'strategy' | 'status'>): string {
    return `${workosConnectionStrategyLabel(candidate.strategy)} · ${workosConnectionStatusLabel(candidate.status)}`;
}

/**
 * What removing the connection does, in the person's terms: who signs in with it, and what is kept.
 * The Home refuses removal while anything else depends on it, so a confirmable removal only ever
 * affects the people who sign in with it.
 */
function teamConnectionRemovalBody(impact: TeamConnectionRemovalImpact): string {
    return impact.linkedAccounts > 0
        ? [
            t('identityAdministration.removeImpactPeople', { count: impact.linkedAccounts }),
            t('identityAdministration.removeImpactKept'),
        ].join('\n')
        : t('identityAdministration.removeImpactNobody');
}

/**
 * Why removal is refused, blocker first: each typed blocker becomes its own counted sentence when
 * the preview carries its count, otherwise the shared presenter's sentence, followed by where it is
 * resolved.
 */
function teamConnectionRemovalBlockedBody(
    impact: TeamConnectionRemovalImpact,
    blockers: readonly string[],
): string {
    return blockers.map((blocker) => {
        const counted = blocker === 'account_would_lose_login' && impact.accountsRequiringAlternateLogin > 0
            ? t('identityAdministration.removeBlockedAlternateLogins', { count: impact.accountsRequiringAlternateLogin })
            : blocker === 'directory_source_in_use' && impact.directorySources > 0
                ? t('identityAdministration.removeBlockedDirectories', { count: impact.directorySources })
                : blocker === 'external_group_binding_in_use' && impact.externalGroupBindings > 0
                    ? t('identityAdministration.removeBlockedGroups', { count: impact.externalGroupBindings })
                    : blocker === 'managed_membership_in_use' && impact.managedMemberships > 0
                        ? t('identityAdministration.removeBlockedMemberships', { count: impact.managedMemberships })
                        : identityAdministrationFailureMessage(blocker);
        const label = identityAdministrationFailureRecoveryLabel(identityAdministrationFailure(blocker).recovery);
        return label ? `${counted} ${label}.` : counted;
    }).join('\n');
}

export const IdentityConnectionDetailContent = React.memo(function IdentityConnectionDetailContent(props: Readonly<{
    scope: Parameters<typeof useIdentityAdministration>[0];
    teamId: string | null;
    connectionId: string;
    mutationsAvailable: boolean;
    requestApproval?: (registration: ActionApprovalRegistration) => void;
    testReturn?: Readonly<{ purpose: string | null; resultHandle: string | null; error: string | null }>;
    workosPortalReturn?: boolean;
    conditionBanners?: React.ReactNode;
}>) {
    const router = useRouter();
    const TEAM_IDENTITY_CONNECTION_SETTINGS = props.teamId === null ? HOME_IDENTITY_CONNECTION_SETTINGS : TEAM_CONNECTION_SETTINGS;
    const detailPath = React.useCallback(() => props.teamId === null
        ? homeAdministrationIdentityConnectionPath(props.scope.serverId, props.connectionId)
        : teamIdentityConnectionPath({ serverId: props.scope.serverId, teamId: props.teamId }, props.connectionId),
    [props.scope.serverId, props.teamId, props.connectionId]);
    const { state, refresh } = useIdentityAdministration(props.scope, props.teamId, props.requestApproval);
    const client = React.useMemo(
        () => createIdentityAdministrationClient(props.scope, {
            onApprovalPending: props.requestApproval,
        }),
        [props.requestApproval, props.scope.accountId, props.scope.serverId],
    );
    const [pending, setPending] = React.useState<string | null>(null);
    const [actionFailure, setActionFailure] = React.useState<string | null>(null);
    const readLifetime = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        const controller = new AbortController();
        readLifetime.current = controller;
        return () => {
            controller.abort();
            if (readLifetime.current === controller) readLifetime.current = null;
        };
    }, [props.scope.serverId, props.scope.accountId, props.teamId, props.connectionId]);

    // A typed Home outcome becomes one localized sentence, announced as well as
    // shown because it lands away from the control that was pressed.
    const reportActionFailure = React.useCallback((code: string) => {
        const message = identityAdministrationFailureMessage(code);
        setActionFailure(message);
        announceAccessibilityMessage(message);
    }, []);
    const [testDiagnostics, setTestDiagnostics] = React.useState<IdentityConnectionTestDiagnosticsV1 | null>(null);
    const [workosCandidates, setWorkosCandidates] = React.useState<readonly WorkosCandidate[]>([]);
    const [chosenWorkosCandidateId, setChosenWorkosCandidateId] = React.useState<string | null>(null);
    // The WorkOS Admin Portal returns either to the original screen (foreground)
    // or as a fresh document on this exact route (teams-lane-03/06 §7.4(5)-(6)).
    // Both refresh the authoritative projection first and then check setup; only
    // the portal intent reports a refusal, because an ordinary route focus of a
    // connection that has nothing to check must stay silent.
    const [workosReturn, setWorkosReturn] = React.useState<'portal' | 'route' | null>(
        props.workosPortalReturn ? 'portal' : null,
    );
    const portalReturnController = React.useRef(createWorkosPortalReturnController()).current;
    const handledTestReturnRef = React.useRef<string | null>(null);
    const connection = state.kind === 'ready'
        ? state.items.find((candidate) => candidate.id === props.connectionId) ?? null
        : null;
    const [settingsOrigin, setSettingsOrigin] = React.useState<RevisionedSettingsDraftOrigin | null>(null);
    const [settingsDirty, setSettingsDirty] = React.useState(false);
    const [settingsConflict, setSettingsConflict] = React.useState(false);
    const [oidcSettings, setOidcSettings] = React.useState<OidcConnectionSettingsDraft>({
        allowedUsers: '', allowedEmailDomains: '', groupsAny: '', groupsAll: '',
    });
    const [organizationLogin, setOrganizationLogin] = React.useState('');
    const editOidcSettings = React.useCallback((patch: Partial<OidcConnectionSettingsDraft>) => {
        setSettingsDirty(true);
        setOidcSettings((current) => ({ ...current, ...patch }));
    }, []);
    const editOrganizationLogin = React.useCallback((value: string) => {
        setSettingsDirty(true);
        setOrganizationLogin(value);
    }, []);
    const reloadConnectionSettings = React.useCallback(() => {
        if (!connection) return;
        setSettingsOrigin({ resourceId: connection.id, revision: connection.revision });
        setSettingsDirty(false);
        setSettingsConflict(false);
        if (connection.settings.kind === 'oidc') {
            setOidcSettings({
                allowedUsers: connection.settings.allowedUsers.join('\n'),
                allowedEmailDomains: connection.settings.allowedEmailDomains.join('\n'),
                groupsAny: connection.settings.groupsAny.join('\n'),
                groupsAll: connection.settings.groupsAll.join('\n'),
            });
        } else if (connection.settings.kind === 'github_app_identity') {
            setOrganizationLogin(connection.settings.organizationLogin);
        }
    }, [connection]);
    React.useEffect(() => {
        if (!connection) return;
        const next = { resourceId: connection.id, revision: connection.revision };
        const transition = revisionedSettingsDraftTransition({
            origin: settingsOrigin,
            current: next,
            dirty: settingsDirty,
        });
        if (transition === 'keep') return;
        if (transition === 'conflict') { setSettingsConflict(true); return; }
        reloadConnectionSettings();
    }, [connection, reloadConnectionSettings, settingsDirty, settingsOrigin]);

    const reconcileWorkos = React.useCallback(async () => {
        if (!props.mutationsAvailable || !connection || !connection.allowedActions.includes(identityAdministrationActionId('teams.identity.workos.reconcile', props.teamId))) return;
        setPending('workos:reconcile'); setActionFailure(null);
        try {
            const applyResult = (value: TeamIdentityActionOutput<'teams.identity.workos.reconcile'>) => {
                if (value.outcome === 'selection_required') {
                    setWorkosCandidates(value.candidates);
                    setChosenWorkosCandidateId(null);
                    // A new decision appears further down the screen than the
                    // control that was pressed, so it is announced as well as
                    // rendered; nothing is chosen on the caller's behalf.
                    announceAccessibilityMessage(t('identityAdministration.workosChooseConnection'));
                    return;
                }
                setWorkosCandidates([]);
                setChosenWorkosCandidateId(null);
                refresh();
            };
            const result = await client.execute(
                'teams.identity.workos.reconcile',
                { v: 1, teamId: props.teamId, connectionId: connection.id, expectedRevision: connection.revision },
                { onApprovalSucceeded: applyResult, onApprovalFailed: reportActionFailure },
            );
            if (!result.ok) {
                if ('approvalPending' in result) return;
                reportActionFailure(result.failure.code);
            } else applyResult(result.value);
        } finally { setPending(null); }
    }, [client, connection, props.teamId, props.mutationsAvailable, refresh, reportActionFailure]);

    const routeFocusedRef = React.useRef(false);
    useFocusEffect(React.useCallback(() => {
        const firstFocus = !routeFocusedRef.current;
        routeFocusedRef.current = true;
        setWorkosReturn((current) => current ?? 'route');
        // The first focus is the mount, whose projection request is already in
        // flight; every later focus asks for a fresh exact-Team projection.
        if (!firstFocus) refresh();
    }, [refresh]));

    React.useEffect(() => {
        const reconcileOnReturn = () => {
            if (!portalReturnController.consumeReturn()) return;
            setWorkosReturn('portal');
            refresh();
        };
        const appStateSubscription = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'active') reconcileOnReturn();
        });
        const webWindow = typeof globalThis.window === 'undefined' ? null : globalThis.window;
        webWindow?.addEventListener?.('focus', reconcileOnReturn);
        return () => {
            appStateSubscription.remove();
            webWindow?.removeEventListener?.('focus', reconcileOnReturn);
        };
    }, [portalReturnController, refresh]);

    React.useEffect(() => {
        if (!workosReturn) return;
        if (state.kind === 'loading' || (state.kind === 'ready' && state.refreshing)) return;
        setWorkosReturn(null);
        const canReconcile = state.kind === 'ready'
            && !state.stale
            && props.mutationsAvailable
            && connection?.allowedActions.includes(identityAdministrationActionId('teams.identity.workos.reconcile', props.teamId)) === true;
        if (workosReturn === 'portal') {
            const clearReturnedMarker = () => {
                // Only a fresh-document return has a URL marker. Foreground
                // returns keep the current route and its focus/scroll intact.
                if (props.workosPortalReturn) router.replace(detailPath());
            };
            if (canReconcile) void reconcileWorkos().then(clearReturnedMarker, () => {
                reportActionFailure('home_unreachable');
                clearReturnedMarker();
            });
            else {
                reportActionFailure('workos_reconcile_unavailable');
                clearReturnedMarker();
            }
            return;
        }
        if (canReconcile && connection && isWorkosSetupAwaitingCheck(connection)) void reconcileWorkos();
    }, [connection, detailPath, reconcileWorkos, reportActionFailure, router, state, workosReturn, props.teamId, props.mutationsAvailable, props.workosPortalReturn]);

    React.useEffect(() => {
        const testReturn = props.testReturn;
        if (!testReturn || !connection || testReturn.purpose !== 'identity_connection_test') return;
        const key = `${props.teamId}\u0000${props.connectionId}\u0000${testReturn.resultHandle ?? ''}\u0000${testReturn.error ?? ''}`;
        if (handledTestReturnRef.current === key) return;
        handledTestReturnRef.current = key;
        setPending('test:return');
        setActionFailure(null);
        void (async () => {
            try {
                const applyConsumedDiagnostics = (diagnostics: IdentityConnectionTestDiagnosticsV1 | null) => {
                    setTestDiagnostics(diagnostics);
                    refresh();
                };
                const outcome = await runTeamIdentityProviderTestReturn({
                    ...testReturn,
                    teamId: props.teamId,
                    connectionId: props.connectionId,
                    consume: async (input) => await client.execute(
                        'teams.identity.connections.test.consume',
                        { v: 1, ...input },
                        {
                            onApprovalSucceeded: (value) => applyConsumedDiagnostics(value.diagnostics ?? null),
                            onApprovalFailed: reportActionFailure,
                        },
                    ),
                });
                if (outcome.kind === 'failed') reportActionFailure(outcome.code);
                else if (outcome.kind === 'consumed') applyConsumedDiagnostics(outcome.diagnostics);
            } catch {
                reportActionFailure('home_unreachable');
            } finally {
                setPending(null);
                router.replace(detailPath());
            }
        })();
    }, [client, connection, detailPath, props.connectionId, props.scope.serverId, props.teamId, props.testReturn, refresh, reportActionFailure, router]);

    const header = <PageHeader
        testID="identity-connection-header"
        alwaysShowTitle
        title={connection?.provider.displayName ?? t('teams.authentication.detail.connection')}
        leading={connection ? <PageHeaderMarkSlot>{connection.provider.kind === 'workos_sso' ? <WorkosMark size={32} /> : <Icon name={identityProviderKindIconName(connection.provider.kind)} size={32} />}</PageHeaderMarkSlot> : undefined}
        description={connection ? props.teamId === null ? t('identityAdministration.homeWorkosPurpose') : identityProviderKindLabel(connection.provider.kind) : undefined}
        meta={connection ? [
            { key: 'state', text: connectionStateLabel(connection.state) },
            { key: 'mode', text: identityConnectionMode(connection) === 'sign_in_time_groups' ? t('teams.authentication.mode.signInTimeGroups') : t('teams.authentication.mode.signInOnly') },
        ] : undefined}
    />;
    if (state.kind === 'loading') return <>{header}{props.conditionBanners}<ItemGroup><SurfaceStateCard testID="identity-connection-loading" kind="loading" size="line" title={t('common.loading')} accessibilitySemantics="status" /></ItemGroup></>;
    if (state.kind === 'unavailable') return <>{header}{props.conditionBanners}<ItemGroup><SurfaceStateCard testID="identity-connection-unavailable" kind="error" size="line" title={identityAdministrationFailureMessage(state.failure.code)} diagnosticCode={state.failure.code} action={state.failure.retryable ? { label: t('common.retry'), onPress: refresh, testID: 'identity-connection-retry' } : undefined} accessibilitySemantics="alert" /></ItemGroup></>;
    if (!connection) return <>{header}{props.conditionBanners}<ItemGroup><SurfaceStateCard testID="identity-connection-not-found" kind="unavailable" size="line" title={t('teams.errors.notFound')} /></ItemGroup></>;

    const mode = identityConnectionMode(connection) === 'sign_in_time_groups' ? t('teams.authentication.mode.signInTimeGroups') : t('teams.authentication.mode.signInOnly');
    // This row describes the last test, not whether the binding's sign-in switch is on.
    const testStatusLabel = signInConnectionStatusLabel(resolveTestedSignInConnectionStatus({
        enabled: true, testable: true, lastSuccessfulTest: connection.lastSuccessfulTest,
    }));
    const can = (actionId: import('@happier-dev/protocol/teams').TeamIdentityActionIdV1) => connection.allowedActions.includes(identityAdministrationActionId(actionId, props.teamId));
    const projectionCurrent = !state.refreshing && !state.stale;
    const workosReturnRefreshing = workosReturn === 'portal'
        || (workosReturn === 'route' && connection !== null && isWorkosSetupAwaitingCheck(connection));
    const mutationBusy = pending !== null || workosReturnRefreshing || !projectionCurrent;
    const settle = (result: IdentityAdministrationActionResult<unknown>) => {
        if (result.ok) {
            refresh();
            return;
        }
        if ('approvalPending' in result) return;
        const code = result.failure.code;
        reportActionFailure(code);
        if (identityAdministrationFailure(code).refreshResolves) refresh();
    };

    const runLifecycle = async (actionId: 'teams.identity.connections.enable' | 'teams.identity.connections.disable') => {
        if (!props.mutationsAvailable || mutationBusy || !can(actionId)) return;
        setPending(actionId); setActionFailure(null);
        try {
            settle(await client.execute(
                actionId,
                { v: 1, teamId: props.teamId, connectionId: connection.id, expectedRevision: connection.revision },
                { onApprovalSucceeded: refresh, onApprovalFailed: reportActionFailure },
            ));
        }
        finally { setPending(null); }
    };

    const saveSettings = async () => {
        if (!props.mutationsAvailable || !can('teams.identity.connections.settings.update')) return;
        const settings = connection.settings.kind === 'oidc'
            ? connectionSettingsFromDraft(oidcSettings)
            : connection.settings.kind === 'github_app_identity' && organizationLogin.trim()
                ? { v: 1 as const, kind: 'github_app_identity' as const, organizationLogin: organizationLogin.trim() }
                : null;
        if (!settings) { reportActionFailure('invalid_parameters'); return; }
        setPending('settings'); setActionFailure(null);
        try {
            const applySettingsSuccess = () => {
                setSettingsDirty(false);
                setSettingsConflict(false);
                refresh();
            };
            const result = await client.execute('teams.identity.connections.settings.update', {
                v: 1, teamId: props.teamId, connectionId: connection.id,
                expectedRevision: settingsOrigin?.resourceId === connection.id
                    ? settingsOrigin.revision
                    : connection.revision,
                settings,
            }, {
                onApprovalSucceeded: applySettingsSuccess,
                onApprovalFailed: reportActionFailure,
            });
            if (!result.ok) {
                if ('approvalPending' in result) return;
                reportActionFailure(result.failure.code);
                if (result.failure.code === 'identity_connection_conflict') {
                    setSettingsConflict(true);
                    refresh();
                }
            }
            else applySettingsSuccess();
        } finally { setPending(null); }
    };

    const test = async () => {
        if (!props.mutationsAvailable || mutationBusy || !can('teams.identity.connections.test.start')) return;
        setPending('test'); setActionFailure(null); setTestDiagnostics(null);
        try {
            const continueTest = async (value: TeamIdentityActionOutput<'teams.identity.connections.test.start'>) => {
                if (!await openExternalUrl(value.authorizeUrl)) reportActionFailure('identity_connection_test_open_failed');
            };
            const result = await client.execute(
                'teams.identity.connections.test.start',
                { v: 1, teamId: props.teamId, connectionId: connection.id, expectedRevision: connection.revision },
                { onApprovalSucceeded: continueTest, onApprovalFailed: reportActionFailure },
            );
            if (!result.ok) {
                if ('approvalPending' in result) return;
                reportActionFailure(result.failure.code);
                return;
            }
            await continueTest(result.value);
        } finally { setPending(null); }
    };

    const openWorkosPortal = async () => {
        if (!props.mutationsAvailable || mutationBusy || !can('teams.identity.workos.adminPortalLink.create')) return;
        if (!await Modal.confirm(t('identityAdministration.workosSetupSso'), t('identityAdministration.workosPortalConfirmBody'), { cancelText: t('common.cancel'), confirmText: t('common.continue') })) return;
        const intent = 'sso' as const;
        setPending(`workos:${intent}`); setActionFailure(null);
        try {
            const continuePortal = async (value: TeamIdentityActionOutput<'teams.identity.workos.adminPortalLink.create'>) => {
                let isHttps = false;
                try { isHttps = new URL(value.url).protocol === 'https:'; } catch { /* fail closed */ }
                if (!isHttps || !await openExternalUrl(value.url)) reportActionFailure('workos_portal_open_failed');
                else portalReturnController.markOpened();
            };
            const result = await client.execute(
                'teams.identity.workos.adminPortalLink.create',
                { v: 1, teamId: props.teamId, connectionId: connection.id, intent },
                { onApprovalSucceeded: continuePortal, onApprovalFailed: reportActionFailure },
            );
            if (!result.ok) {
                if ('approvalPending' in result) return;
                reportActionFailure(result.failure.code);
                return;
            }
            await continuePortal(result.value);
        } finally { setPending(null); }
    };

    // Choosing fixes the provider namespace every future identity under this
    // binding is issued in, so a row only selects; the commit is the explicit
    // primary action that names the chosen connection.
    const chooseWorkos = async (candidate: WorkosCandidate) => {
        if (!props.mutationsAvailable || mutationBusy || !can('teams.identity.workos.connection.set')) return;
        if (isWorkosDraftCandidate(candidate)) return;
        const workosConnectionId = candidate.connectionId;
        setPending(`workos:set:${workosConnectionId}`); setActionFailure(null);
        try {
            const applyConnection = () => { setWorkosCandidates([]); setChosenWorkosCandidateId(null); refresh(); };
            const result = await client.execute(
                'teams.identity.workos.connection.set',
                { v: 1, teamId: props.teamId, connectionId: connection.id, expectedRevision: connection.revision, workosConnectionId },
                { onApprovalSucceeded: applyConnection, onApprovalFailed: reportActionFailure },
            );
            if (!result.ok) {
                if ('approvalPending' in result) return;
                reportActionFailure(result.failure.code);
            } else applyConnection();
        } finally { setPending(null); }
    };

    const remove = async () => {
        if (!props.mutationsAvailable || mutationBusy || !can('teams.identity.connections.remove')) return;
        const signal = readLifetime.current?.signal;
        if (!signal || signal.aborted) return;
        setPending('remove'); setActionFailure(null);
        try {
            const preflight = await executeIdentityAdministrationRead<TeamIdentityActionOutput<'teams.identity.connections.remove.preview'>>((options) => client.execute(
                'teams.identity.connections.remove.preview',
                { v: 1, teamId: props.teamId, connectionId: connection.id, expectedRevision: connection.revision },
                options,
            ), signal);
            if (signal.aborted) return;
            if (!preflight.ok) { reportActionFailure(preflight.failure.code); return; }
            if (!preflight.value.canRemove) {
                await Modal.alertAsync(
                    t('identityAdministration.removeBlockedTitle', { name: connection.provider.displayName }),
                    teamConnectionRemovalBlockedBody(preflight.value.impact, preflight.value.blockers),
                );
                return;
            }
            const removalBody = props.teamId === null ? t('identityAdministration.removeBody', { name: connection.provider.displayName }) : teamConnectionRemovalBody(preflight.value.impact);
            if (!await Modal.confirm(t('identityAdministration.removeTitle', { name: connection.provider.displayName }), removalBody, { cancelText: t('common.cancel'), confirmText: t('identityAdministration.remove'), destructive: true })) return;
            if (signal.aborted) return;
            const finishRemoval = () => router.back();
            const result = await client.execute(
                'teams.identity.connections.remove',
                { v: 1, teamId: props.teamId, connectionId: connection.id, expectedRevision: preflight.value.connection.revision },
                { onApprovalSucceeded: finishRemoval, onApprovalFailed: reportActionFailure },
            );
            if (!result.ok) {
                if ('approvalPending' in result) return;
                reportActionFailure(result.failure.code);
            } else finishRemoval();
        } finally { if (!signal.aborted) setPending(null); }
    };

    const setupSteps = workosSetupSteps(connection);
    const isWorkos = connection.provider.kind === 'workos_sso';
    const workosObservation = connection.lastObservation?.kind === 'workos_sso' ? connection.lastObservation.presentation : null;
    const chosenCandidate = workosCandidates.find((candidate) => candidate.connectionId === chosenWorkosCandidateId) ?? null;
    const controlsDisabled = mutationBusy || !props.mutationsAvailable;
    const candidatePicker = workosCandidates.length > 0 ? (
        <SettingAnchor setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.workosConnection}><ItemGroup accessibilityRole="radiogroup">
            {workosCandidates.map((candidate) => {
                const draft = isWorkosDraftCandidate(candidate);
                const detail = draft ? t('identityAdministration.workosCandidateDraft') : workosCandidateSummary(candidate);
                const chosen = candidate.connectionId === chosenWorkosCandidateId;
                return <Item
                    key={candidate.connectionId}
                    testID={`identity-workos-candidate:${candidate.connectionId}`}
                    title={candidate.displayName}
                    subtitle={detail}
                    accessibilityLabel={`${candidate.displayName}, ${detail}`}
                    accessibilityRole="radio"
                    webRole="radio"
                    selected={chosen}
                    accessibilityChecked={chosen}
                    disabled={draft || controlsDisabled || !can('teams.identity.workos.connection.set')}
                    onPress={() => setChosenWorkosCandidateId(candidate.connectionId)}
                    showChevron={false}
                />;
            })}
            <SectionContentRow showDivider={false}><SectionButtonRow>
                <RoundButton
                    testID="team-identity-workos-use"
                    size="small"
                    title={chosenCandidate
                        ? t('identityAdministration.workosUseConnection', { name: chosenCandidate.displayName })
                        : t('identityAdministration.workosChooseConnection')}
                    loading={chosenCandidate !== null && pending === `workos:set:${chosenCandidate.connectionId}`}
                    disabled={chosenCandidate === null || controlsDisabled || !can('teams.identity.workos.connection.set')}
                    onPress={() => { if (chosenCandidate) void chooseWorkos(chosenCandidate); }}
                />
            </SectionButtonRow></SectionContentRow>
        </ItemGroup></SettingAnchor>
    ) : null;
    const workosStep = (step: WorkosSetupStep): SetupStep => {
        const current = step.state === 'current';
        const done = step.state === 'done';
        switch (step.id) {
            case 'portal': return {
                key: step.id,
                state: step.state,
                title: done ? t('identityAdministration.workosStepPortalDone') : t('identityAdministration.workosSetupSso'),
                detail: done ? t('identityAdministration.workosStepPortalDoneDetail') : t('identityAdministration.workosStepPortalDetail'),
                body: can('teams.identity.workos.adminPortalLink.create') ? (
                    <RoundButton
                        testID="team-identity-workos-sso"
                        size="small"
                        display={current ? 'default' : 'inverted'}
                        title={current ? t('identityAdministration.workosOpenPortal') : t('identityAdministration.workosOpenPortalAgain')}
                        loading={pending === 'workos:sso'}
                        disabled={controlsDisabled}
                        onPress={() => void openWorkosPortal()}
                    />
                ) : undefined,
            };
            case 'choose': return {
                key: step.id,
                state: step.state,
                title: done ? t('identityAdministration.workosStepChooseDone') : t('identityAdministration.workosChooseConnection'),
                detail: done
                    ? (workosObservation ? `${workosObservation.displayName} · ${workosCandidateSummary(workosObservation)}` : undefined)
                    : props.teamId === null ? t('identityAdministration.homeWorkosChooseDetail') : t('identityAdministration.workosStepChooseDetail'),
                body: candidatePicker ?? (current && can('teams.identity.workos.reconcile') ? (
                    <RoundButton
                        testID="team-identity-workos-reconcile"
                        size="small"
                        title={t('identityAdministration.workosFindConnections')}
                        loading={pending === 'workos:reconcile'}
                        disabled={controlsDisabled}
                        onPress={() => void reconcileWorkos()}
                    />
                ) : undefined),
            };
            case 'test': return {
                key: step.id,
                state: step.state,
                title: t('identityAdministration.test'),
                detail: done ? t('identityAdministration.workosTestPassed') : t('identityAdministration.workosStepTestDetail'),
                body: current && can('teams.identity.connections.test.start') ? (
                    <RoundButton
                        testID="team-identity-test"
                        size="small"
                        title={t('identityAdministration.test')}
                        loading={pending === 'test' || pending === 'test:return'}
                        disabled={controlsDisabled}
                        onPress={() => void test()}
                    />
                ) : undefined,
            };
            case 'enable': return {
                key: step.id,
                state: step.state,
                title: t('identityAdministration.workosStepEnable'),
                detail: props.teamId === null ? t('identityAdministration.homeWorkosEnableDetail') : t('identityAdministration.workosStepEnableDetail'),
                body: current && can('teams.identity.connections.enable') ? (
                    <RoundButton
                        testID="team-identity-enable"
                        size="small"
                        title={t('identityAdministration.workosTurnOn')}
                        loading={pending === 'teams.identity.connections.enable'}
                        disabled={controlsDisabled}
                        onPress={() => void runLifecycle('teams.identity.connections.enable')}
                    />
                ) : undefined,
            };
        }
    };

    return <>
        {header}
        {props.conditionBanners}
        {state.stale ? <AttentionBanner testID="identity-connection-stale" title={t('teams.unavailable.offline')} description={t('teams.stale.label')} accessibilityLiveRegion="polite" action={{ label: t('common.retry'), onPress: refresh }} /> : null}
        {workosReturnRefreshing ? <ItemGroup><SurfaceStateCard testID="identity-workos-return-checking" kind="loading" size="line" title={t('identityAdministration.workosCheckSetup')} accessibilitySemantics="status" /></ItemGroup> : null}
        {isWorkos ? null : <SettingSection section={TEAM_IDENTITY_CONNECTION_SETTINGS.sectionRefs.configuration} answersFor={[TEAM_CONNECTION_SETTINGS.sectionRefs.groupMappings]}><ItemGroup title={connection.provider.displayName}>
            <Item testID="identity-connection-status" title={t('teams.authentication.detail.status')} detail={connectionStateLabel(connection.state)} showChevron={false} />
            <Item testID="identity-connection-mode" title={t('teams.authentication.detail.mode')} detail={mode} showChevron={false} />
            <Item testID="identity-connection-provider" title={t('teams.authentication.detail.provider')} detail={identityProviderKindLabel(connection.provider.kind)} showChevron={false} />
            {isWorkos ? null : <Item
                testID="identity-connection-test-status"
                title={t('identityAdministration.test')}
                detail={pending === 'test:return'
                    ? t('common.loading')
                    : testStatusLabel}
                loading={pending === 'test:return'}
                accessibilityLiveRegion={pending === 'test:return' ? 'polite' : undefined}
                showChevron={false}
            />}
        </ItemGroup></SettingSection>}
        {setupSteps ? (
            // The WorkOS path as visible steps: only the current step offers its
            // action; done steps keep their fact, later steps wait.
            <SettingAnchor setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.workosSetupSso}><ItemGroup title={t('identityAdministration.workosSetupSection')} description={t('identityAdministration.workosSetupFooter')}>
                <SectionContentRow showDivider={false}>
                    <SetupSteps testID="identity-workos-setup-steps" steps={setupSteps.map(workosStep)} />
                </SectionContentRow>
            </ItemGroup></SettingAnchor>
        ) : null}
        {isWorkos && !setupSteps ? (
            <SettingAnchor setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.workosCheckSetup}><ItemGroup title={t('identityAdministration.workosConnectionSection')}>
                <Item title={t('identityAdministration.homeWorkosCompanyName')} detail={connection.provider.displayName} showChevron={false} rightElement={can('teams.identity.workos.adminPortalLink.create') ? <RoundButton testID="team-identity-workos-sso" size="small" display="secondary" title={t('identityAdministration.workosOpenPortalAgain')} disabled={controlsDisabled} loading={pending === 'workos:sso'} onPress={() => void openWorkosPortal()} /> : undefined} />
                <Item
                    testID="identity-workos-current-connection"
                    title={t('identityAdministration.workosConnectionRow')}
                    subtitle={workosObservation
                        ? `${workosObservation.displayName} · ${workosCandidateSummary(workosObservation)}`
                        : t('identityAdministration.workosConnectionNotChosen')}
                    rightElement={can('teams.identity.workos.reconcile') ? (
                        <RoundButton testID="team-identity-workos-reconcile" size="small" display="inverted" title={t('identityAdministration.workosChange')} loading={pending === 'workos:reconcile'} disabled={controlsDisabled} onPress={() => void reconcileWorkos()} />
                    ) : undefined}
                    showChevron={false}
                />
                <Item
                    testID="identity-connection-test-status"
                    title={t('identityAdministration.test')}
                    subtitle={pending === 'test:return'
                        ? t('common.loading')
                        : testStatusLabel}
                    loading={pending === 'test:return'}
                    accessibilityLiveRegion={pending === 'test:return' ? 'polite' : undefined}
                    rightElement={can('teams.identity.connections.test.start') ? (
                        <RoundButton testID="team-identity-test" size="small" display="secondary" title={t('identityAdministration.workosTestAgain')} loading={pending === 'test'} disabled={controlsDisabled} onPress={() => void test()} />
                    ) : undefined}
                    showChevron={false}
                />
            </ItemGroup></SettingAnchor>
        ) : null}
        {testDiagnostics ? <IdentityTestDiagnosticsGroup diagnostics={testDiagnostics} groupMappings={props.teamId !== null} /> : null}
        {props.teamId === null && isWorkos ? <ItemGroup description={t('identityAdministration.homeWorkosOffboarding')}>
            <Item title={t('homeGovernance.signInTitle')} subtitle={t('identityAdministration.homeWorkosEnableDetail')} onPress={() => router.push(homeAdministrationPoliciesPath(props.scope.serverId))} />
        </ItemGroup> : null}
        {settingsConflict ? <ItemGroup description={t('identityAdministration.settingsChangedElsewhere')}>{settingsOrigin?.resourceId !== connection.id || connection.revision > settingsOrigin.revision ? <Item testID="identity-settings-reload-conflict" title={t('common.refresh')} disabled={pending !== null || !props.mutationsAvailable} onPress={reloadConnectionSettings} showChevron={false} /> : <Item testID="identity-settings-refresh-conflict" title={t('common.retry')} disabled={pending !== null} onPress={refresh} showChevron={false} />}</ItemGroup> : null}
        {connection.settings.kind === 'oidc' ? <ItemGroup title={t('teams.authentication.detail.restrictions')}>
            <SettingRow setting={TEAM_CONNECTION_SETTINGS.settings.allowedUsers} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="identity-settings-allowed-users" accessibilityLabel={t('teams.authentication.detail.allowedUsers')} value={oidcSettings.allowedUsers} editable={projectionCurrent && props.mutationsAvailable && can('teams.identity.connections.settings.update')} multiline onChangeText={(value) => editOidcSettings({ allowedUsers: value })} />} />
            <SettingRow setting={TEAM_CONNECTION_SETTINGS.settings.allowedDomains} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="identity-settings-allowed-domains" accessibilityLabel={t('teams.authentication.detail.allowedDomains')} value={oidcSettings.allowedEmailDomains} editable={projectionCurrent && props.mutationsAvailable && can('teams.identity.connections.settings.update')} multiline autoCapitalize="none" onChangeText={(value) => editOidcSettings({ allowedEmailDomains: value })} />} />
            <SettingRow setting={TEAM_CONNECTION_SETTINGS.settings.groupsAny} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="identity-settings-groups-any" accessibilityLabel={t('identityAdministration.groupsAny')} value={oidcSettings.groupsAny} editable={projectionCurrent && props.mutationsAvailable && can('teams.identity.connections.settings.update')} multiline onChangeText={(value) => editOidcSettings({ groupsAny: value })} />} />
            <SettingRow setting={TEAM_CONNECTION_SETTINGS.settings.groupsAll} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="identity-settings-groups-all" accessibilityLabel={t('identityAdministration.groupsAll')} value={oidcSettings.groupsAll} editable={projectionCurrent && props.mutationsAvailable && can('teams.identity.connections.settings.update')} multiline onChangeText={(value) => editOidcSettings({ groupsAll: value })} />} />
            {can('teams.identity.connections.settings.update') ? <SettingRow setting={TEAM_CONNECTION_SETTINGS.settings.save} testID="identity-settings-save" loading={pending === 'settings'} disabled={mutationBusy || settingsConflict || !settingsDirty || !props.mutationsAvailable} onPress={() => void saveSettings()} showChevron={false} /> : null}
        </ItemGroup> : null}
        {connection.settings.kind === 'github_app_identity' ? <ItemGroup title={t('teams.authentication.detail.configuration')}>
            <SettingRow setting={TEAM_CONNECTION_SETTINGS.settings.organization} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="identity-settings-organization" accessibilityLabel={t('teams.authentication.detail.organization')} value={organizationLogin} editable={projectionCurrent && props.mutationsAvailable && can('teams.identity.connections.settings.update')} autoCapitalize="none" onChangeText={editOrganizationLogin} />} />
            {can('teams.identity.connections.settings.update') ? <SettingRow setting={TEAM_CONNECTION_SETTINGS.settings.save} testID="identity-settings-save" loading={pending === 'settings'} disabled={mutationBusy || settingsConflict || !settingsDirty || !props.mutationsAvailable} onPress={() => void saveSettings()} showChevron={false} /> : null}
        </ItemGroup> : null}
        {props.teamId !== null && props.requestApproval && (connection.provider.kind === 'oidc' || connection.provider.kind === 'github_app_identity') ? <IdentityConnectionGroupMappings scope={props.scope} address={{ serverId: props.scope.serverId, teamId: props.teamId }} connectionId={connection.id} mutationsAvailable={props.mutationsAvailable && projectionCurrent} requestApproval={props.requestApproval} /> : null}
        {setupSteps ? null : candidatePicker}
        {actionFailure ? <ItemGroup><SurfaceStateCard testID="identity-connection-failure" kind="error" size="line" title={actionFailure} accessibilitySemantics="alert" /></ItemGroup> : null}
        <SettingSection section={TEAM_IDENTITY_CONNECTION_SETTINGS.sectionRefs.actions}>{isWorkos ? <>
            <ItemGroup surface="none">
                <SectionButtonRow trailing={can('teams.identity.connections.remove') ? <SettingAnchor setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.remove}><RoundButton
                    testID="team-identity-remove"
                    size="small"
                    display="destructive"
                    title={t('identityAdministration.remove')}
                    disabled={controlsDisabled}
                    onPress={() => void remove()}
                /></SettingAnchor> : undefined}>
                    {can('teams.identity.connections.disable') ? <SettingAnchor setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.disable}><RoundButton
                        testID="team-identity-disable"
                        size="small"
                        display="secondary"
                        title={t('identityAdministration.disable')}
                        loading={pending === 'teams.identity.connections.disable'}
                        disabled={controlsDisabled}
                        onPress={() => void runLifecycle('teams.identity.connections.disable')}
                    /></SettingAnchor> : null}
                </SectionButtonRow>
            </ItemGroup>
            {props.teamId !== null && can('teams.identity.workos.adminPortalLink.create') ? <ItemGroup><SettingRow setting={TEAM_CONNECTION_SETTINGS.settings.workosSetupDirectory} testID="team-identity-workos-directory" icon={<Icon name="users" />} disabled={controlsDisabled} onPress={() => { if (props.teamId !== null) router.push(teamDirectoryPath({ serverId: props.scope.serverId, teamId: props.teamId })); }} showChevron /></ItemGroup> : null}
        </> : <ItemGroup title={t('identityAdministration.actions')}>
            {props.teamId !== null && props.requestApproval && connection.provider.kind === 'oidc' ? <TeamManagedProviderEditItem scope={props.scope} address={{ serverId: props.scope.serverId, teamId: props.teamId }} connectionId={connection.id} providerId={connection.provider.id} disabled={controlsDisabled} requestApproval={props.requestApproval} /> : null}
            {!isWorkos && can('teams.identity.connections.test.start') ? <SettingRow setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.test} testID="team-identity-test" loading={pending === 'test'} disabled={controlsDisabled} onPress={() => void test()} showChevron={false} /> : null}
            {!isWorkos && can('teams.identity.connections.enable') ? <SettingRow setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.enable} testID="team-identity-enable" loading={pending === 'teams.identity.connections.enable'} disabled={controlsDisabled} onPress={() => void runLifecycle('teams.identity.connections.enable')} showChevron={false} /> : null}
            {can('teams.identity.connections.disable') ? <SettingRow setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.disable} testID="team-identity-disable" loading={pending === 'teams.identity.connections.disable'} disabled={controlsDisabled} onPress={() => void runLifecycle('teams.identity.connections.disable')} showChevron={false} /> : null}
            {props.teamId !== null && isWorkos && can('teams.identity.workos.adminPortalLink.create') ? <SettingRow setting={TEAM_CONNECTION_SETTINGS.settings.workosSetupDirectory} testID="team-identity-workos-directory" icon={<Icon name="users" />} disabled={controlsDisabled} onPress={() => { if (props.teamId !== null) router.push(teamDirectoryPath({ serverId: props.scope.serverId, teamId: props.teamId })); }} showChevron /> : null}
            {can('teams.identity.connections.remove') ? <SettingRow setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.remove} testID="team-identity-remove" destructive disabled={controlsDisabled} onPress={() => void remove()} showChevron={false} /> : null}
        </ItemGroup>}</SettingSection>
    </>;
});

export const IdentityConnectionDetailScreen = React.memo(function IdentityConnectionDetailScreen(props: Readonly<{
    serverId: string;
    teamId: string;
    connectionId: string;
    testReturn?: Readonly<{ purpose: string | null; resultHandle: string | null; error: string | null }>;
    workosPortalReturn?: boolean;
}>) {
    return (
        <TeamSection serverId={props.serverId} teamId={props.teamId} title={t('teams.authentication.detail.connection')} childRendersHeader>
            {({ team, scope, canMutate, requestApproval }, conditionBanners) => team.capabilities.manageAuthentication ? (
                <IdentityConnectionDetailContent key={props.connectionId} scope={scope} teamId={team.id} connectionId={props.connectionId} mutationsAvailable={canMutate} requestApproval={requestApproval} testReturn={props.testReturn} workosPortalReturn={props.workosPortalReturn} conditionBanners={conditionBanners} />
            ) : (
                <><PageHeader title={t('teams.authentication.detail.connection')} />{conditionBanners}
                <SettingSection section={TEAM_IDENTITY_CONNECTION_SETTINGS.sectionRefs.actions} answersFor={Object.values(TEAM_IDENTITY_CONNECTION_SETTINGS.sectionRefs)}>
                    <ItemGroup><SurfaceStateCard testID="identity-connection-forbidden" kind="denied" size="line" title={t('teams.errors.forbidden')} /></ItemGroup>
                </SettingSection>
                </>
            )}
        </TeamSection>
    );
});
