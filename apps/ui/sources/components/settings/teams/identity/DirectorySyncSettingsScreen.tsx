import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AppState, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_STATE_SIZE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { TeamDirectorySourceSetupOptionV1, TeamDirectorySourceSetupOptionsV1 } from '@happier-dev/protocol/teams';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { DIRECTORY_SETTINGS } from './directorySettings';
import { identityAdministrationFailureMessage } from '@/components/settings/identity/identityAdministrationFailure';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { serverAccountScopedTeamKey } from '@/sync/domains/teams/teamAddress';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import { TeamSection } from '../TeamSection';
import { teamDirectorySourcePath } from '../teamsRoutes';
import { directorySourcePresentationState, directorySourceStateLabel } from './directoryAdministrationPresentation';
import { createIdentityAdministrationClient, executeIdentityAdministrationRead } from './identityAdministrationClient';
import { useDirectoryAdministration } from './useDirectoryAdministration';
import { identityProviderKindMark } from './identityAdministrationPresentation';
import { createWorkosPortalReturnController } from './workosPortalReturn';
import { homeSignInPlatformHref } from '@/components/settings/home/signInProviders/homeSignInPlatforms';
import { useEligibleProviderRecoveryViewer } from './eligibleProviderAvailability';
import { askAdministratorsText } from '../collection/teamsCreateGuidanceText';


/** The directories a Team can follow, drawn at the pane state's own glyph size and gap. */
const DIRECTORY_MARK_SIZE = HAPPIER_STATE_SIZE_METRICS.pane.glyphPx;

const styles = StyleSheet.create({
    marks: {
        flexDirection: 'row',
        gap: HAPPIER_STATE_SIZE_METRICS.pane.glyphGapPx,
    },
});

function directorySetupOptionKey(option: TeamDirectorySourceSetupOptionV1): string {
    return option.kind === 'workos_directory'
        ? `${option.kind}:${option.teamIdentityConnectionId}:${option.workosDirectoryId}`
        : `${option.kind}:${option.githubAppInstallationId}`;
}

const AuthorizedDirectoryList = React.memo(function AuthorizedDirectoryList(props: Readonly<{
    scope: Parameters<typeof useDirectoryAdministration>[0];
    address: Parameters<typeof teamDirectorySourcePath>[0];
    mutationsAvailable: boolean;
    requestApproval: (registration: ActionApprovalRegistration) => void;
}>) {
    const router = useRouter();
    const { state, refresh, loadMore } = useDirectoryAdministration(props.scope, props.address.teamId, true, props.requestApproval);
    const bindingKey = serverAccountScopedTeamKey(props.scope, props.address);
    const client = React.useMemo(
        () => createIdentityAdministrationClient(props.scope, {
            onApprovalPending: props.requestApproval,
        }),
        [props.requestApproval, props.scope.accountId, props.scope.serverId],
    );
    const [setup, setSetup] = React.useState<Readonly<{
        kind: 'hidden' | 'loading' | 'ready' | 'unavailable';
        items: readonly TeamDirectorySourceSetupOptionV1[];
        nextCursor: string | null;
        complete: boolean;
        failure: string | null;
        retryCursor: string | null;
    }>>({ kind: 'hidden', items: [], nextCursor: null, complete: false, failure: null, retryCursor: null });
    const [pendingSetup, setPendingSetup] = React.useState<string | null>(null);
    const setupRequestGenerationRef = React.useRef(0);
    const setupRequestControllerRef = React.useRef<AbortController | null>(null);
    const setupVisibleRef = React.useRef(false);
    const projectionCurrent = state.kind === 'ready' && !state.refreshing && !state.stale;
    // Setup failures render in the shared recovery line, out of the pressed
    // control's reading order, and announce the same sentence as it is stored.
    // WorkOS Directory Sync refused because WorkOS is not set up on the Home: the recovery line
    // leads a Home owner to the WorkOS row and names, for anyone else, who can set it up.
    const [workosPlatformMissing, setWorkosPlatformMissing] = React.useState(false);
    const recoveryViewer = useEligibleProviderRecoveryViewer(props.scope);
    const reportSetupFailure = React.useCallback((code: string) => {
        setWorkosPlatformMissing(code.trim().toLowerCase() === 'workos_platform_unavailable');
        const message = identityAdministrationFailureMessage(code);
        announceAccessibilityMessage(message);
        return message;
    }, []);
    const portalReturnController = React.useRef(createWorkosPortalReturnController()).current;

    React.useEffect(() => {
        setupRequestGenerationRef.current += 1;
        setupVisibleRef.current = false;
        setSetup({
            kind: 'hidden',
            items: [],
            nextCursor: null,
            complete: false,
            failure: null,
            retryCursor: null,
        });
        setPendingSetup(null);
        return () => setupRequestControllerRef.current?.abort();
    }, [bindingKey]);

    const loadSetup = React.useCallback(async (cursor: string | null = null) => {
        if (!props.mutationsAvailable || !projectionCurrent) return;
        const requestGeneration = setupRequestGenerationRef.current + 1;
        setupRequestGenerationRef.current = requestGeneration;
        setupRequestControllerRef.current?.abort();
        const controller = new AbortController();
        setupRequestControllerRef.current = controller;
        setupVisibleRef.current = true;
        setSetup((current) => ({ ...current, kind: 'loading', failure: null, retryCursor: null }));
        const result = await executeIdentityAdministrationRead<TeamDirectorySourceSetupOptionsV1>(
            (options) => client.executeDirectory('teams.directory.sourceSetup.list', {
                v: 1,
                teamId: props.address.teamId,
                ...(cursor ? { cursor } : {}),
            }, options),
            controller.signal,
        );
        if (controller.signal.aborted || setupRequestGenerationRef.current !== requestGeneration) return;
        const failureMessage = result.ok ? null : reportSetupFailure(result.failure.code);
        setSetup((current) => {
            if (!result.ok) {
                return {
                    ...current,
                    kind: 'unavailable',
                    failure: failureMessage,
                    retryCursor: cursor,
                };
            }
            const combined = cursor === null ? result.value.items : [...current.items, ...result.value.items];
            const seen = new Set<string>();
            const items = combined.filter((option) => {
                const id = directorySetupOptionKey(option);
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
            });
            return {
                kind: 'ready',
                items,
                nextCursor: result.value.nextCursor,
                complete: result.value.complete,
                failure: null,
                retryCursor: null,
            };
        });
    }, [client, projectionCurrent, props.address.teamId, props.mutationsAvailable, reportSetupFailure]);

    React.useEffect(() => {
        const refreshOnReturn = () => {
            const returnedFromPortal = portalReturnController.consumeReturn();
            if (returnedFromPortal || setupVisibleRef.current) void loadSetup();
        };
        const subscription = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'active') refreshOnReturn();
        });
        const webWindow = typeof globalThis.window === 'undefined' ? null : globalThis.window;
        webWindow?.addEventListener?.('focus', refreshOnReturn);
        return () => {
            subscription.remove();
            webWindow?.removeEventListener?.('focus', refreshOnReturn);
        };
    }, [loadSetup, portalReturnController]);

    React.useEffect(() => subscribeHomeAccountChange((event) => {
        if (!setupVisibleRef.current || event.serverId !== props.scope.serverId) return;
        if (event.entityIds !== undefined
            && !event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)) return;
        void loadSetup();
    }, { reconnect: 'refresh' }), [loadSetup, props.scope.serverId]);

    const createSource = React.useCallback(async (option: TeamDirectorySourceSetupOptionV1) => {
        if (!props.mutationsAvailable || !projectionCurrent) return;
        const optionId = option.kind === 'workos_directory'
            ? option.workosDirectoryId
            : option.githubAppInstallationId;
        const createdOptionKey = directorySetupOptionKey(option);
        const finishCreation = async (value: Readonly<{ id: string }>) => {
            setSetup((current) => ({
                ...current,
                items: current.items.filter((candidate) => directorySetupOptionKey(candidate) !== createdOptionKey),
                failure: null,
                retryCursor: null,
            }));
            refresh();
            router.push(teamDirectorySourcePath(props.address, value.id));
        };
        setPendingSetup(optionId);
        setSetup((current) => ({ ...current, failure: null }));
        try {
            const result = await client.executeDirectory('teams.directory.sources.create', option.kind === 'workos_directory'
                ? {
                    v: 1,
                    teamId: props.address.teamId,
                    kind: option.kind,
                    displayName: option.displayName,
                    teamIdentityConnectionId: option.teamIdentityConnectionId,
                    workosDirectoryId: option.workosDirectoryId,
                }
                : {
                    v: 1,
                    teamId: props.address.teamId,
                    kind: option.kind,
                    displayName: option.displayName,
                    githubAppInstallationId: option.githubAppInstallationId,
                }, {
                onApprovalSucceeded: finishCreation,
                onApprovalFailed: (code) => setSetup((current) => ({
                    ...current,
                    failure: reportSetupFailure(code),
                })),
            });
            if (!result.ok) {
                if ('approvalPending' in result) return;
                setSetup((current) => ({ ...current, failure: reportSetupFailure(result.failure.code) }));
                return;
            }
            await finishCreation(result.value);
        } finally {
            setPendingSetup(null);
        }
    }, [client, projectionCurrent, props.address, props.mutationsAvailable, refresh, router]);

    const startWorkosSetup = React.useCallback(async () => {
        if (!props.mutationsAvailable || !projectionCurrent) return;
        setPendingSetup('workos-portal');
        setSetup((current) => ({ ...current, failure: null }));
        try {
            const openPortal = async (value: Readonly<{ url: string }>) => {
                let isHttps = false;
                try {
                    isHttps = new URL(value.url).protocol === 'https:';
                } catch {
                    // Invalid external links fail closed below.
                }
                if (!isHttps || !await openExternalUrl(value.url)) {
                    setSetup((current) => ({ ...current, failure: reportSetupFailure('workos_portal_open_failed') }));
                    return;
                }
                portalReturnController.markOpened();
            };
            const createPortalLink = async (connectionId: string) => {
                const linkResult = await client.execute('teams.identity.workos.adminPortalLink.create', {
                    v: 1,
                    teamId: props.address.teamId,
                    connectionId,
                    intent: 'dsync',
                }, {
                    onApprovalSucceeded: openPortal,
                    onApprovalFailed: (code) => setSetup((current) => ({
                        ...current,
                        failure: reportSetupFailure(code),
                    })),
                });
                if (!linkResult.ok) {
                    if ('approvalPending' in linkResult) return;
                    setSetup((current) => ({ ...current, failure: reportSetupFailure(linkResult.failure.code) }));
                    return;
                }
                await openPortal(linkResult.value);
            };
            const connectionResult = await client.execute('teams.identity.workos.connection.create', {
                v: 1,
                teamId: props.address.teamId,
            }, {
                onApprovalSucceeded: async (value) => await createPortalLink(value.connection.id),
                onApprovalFailed: (code) => setSetup((current) => ({
                    ...current,
                    failure: reportSetupFailure(code),
                })),
            });
            if (!connectionResult.ok) {
                if ('approvalPending' in connectionResult) return;
                setSetup((current) => ({ ...current, failure: reportSetupFailure(connectionResult.failure.code) }));
                return;
            }
            await createPortalLink(connectionResult.value.connection.id);
        } finally {
            setPendingSetup(null);
        }
    }, [client, portalReturnController, projectionCurrent, props.address.teamId, props.mutationsAvailable, reportSetupFailure]);

    if (state.kind === 'loading') {
        return <ItemGroup><SurfaceStateCard testID="team-directory-sources-loading" kind="loading" size="line" title={t('common.loading')} accessibilitySemantics="status" /></ItemGroup>;
    }
    if (state.kind === 'unavailable') {
        return (
            <ItemGroup>
                <SurfaceStateCard
                    testID="team-directory-sources-unavailable"
                    kind="error"
                    size="line"
                    title={identityAdministrationFailureMessage(state.failure.code)}
                    diagnosticCode={state.failure.code}
                    action={state.failure.retryable ? { label: t('common.retry'), onPress: refresh } : undefined}
                    accessibilitySemantics="alert"
                />
            </ItemGroup>
        );
    }

    const setupOpen = setup.kind !== 'hidden';
    const addDisabled = !projectionCurrent || !props.mutationsAvailable || pendingSetup !== null || setup.kind === 'loading';
    // No source yet: the page is the invitation (lab `tsDirectory-E`) — the directories it can follow,
    // what following one does, and the one way to start. The section and its "+" appear with the
    // first source, so the action is never offered twice.
    const empty = state.items.length === 0 && !state.nextCursor;
    return (
        <>
            {state.stale ? (
                <AttentionBanner
                    testID="team-directory-stale"
                    title={t('teams.unavailable.offline')}
                    description={t('teams.stale.label')}
                    accessibilityLiveRegion="polite"
                    action={{ label: t('common.retry'), onPress: refresh }}
                />
            ) : null}
            <SettingSection section={DIRECTORY_SETTINGS.sectionRefs.actions}>{empty ? (
                <SettingAnchor setting={DIRECTORY_SETTINGS.settings.addSource}><SurfaceStateCard
                    testID="team-directory-sources-empty"
                    kind="empty"
                    size="pane"
                    icon={<View style={styles.marks}>
                        {identityProviderKindMark('workos_sso', DIRECTORY_MARK_SIZE)}
                        {identityProviderKindMark('github_app_identity', DIRECTORY_MARK_SIZE)}
                    </View>}
                    title={t('teams.authentication.directory.empty')}
                    reason={t('teams.authentication.directory.emptyBody')}
                    // Once the choices are open, their section says this; the card does not repeat it.
                    note={setupOpen ? undefined : t('teams.authentication.directory.setup.optionsFooter')}
                    action={{
                        label: t('teams.authentication.directory.setup.add'),
                        testID: 'team-directory-source-add',
                        onPress: () => void loadSetup(),
                        disabled: addDisabled,
                        busy: setup.kind === 'loading',
                    }}
                /></SettingAnchor>
            ) : <ItemGroup
                title={t('teams.authentication.directory.sourcesSection')}
                description={t('teams.authentication.directory.subtitle')}
                action={(
                    // One way to add a source: the choices open in place under
                    // this section rather than behind a second "Add a source" step.
                    <SettingAnchor setting={DIRECTORY_SETTINGS.settings.addSource}><SectionActionButton
                        testID="team-directory-source-add"
                        icon="plus"
                        title={t('teams.authentication.directory.setup.add')}
                        expanded={setupOpen}
                        loading={setup.kind === 'loading'}
                        disabled={addDisabled}
                        onPress={() => void loadSetup()}
                    /></SettingAnchor>
                )}
            >
                {state.items.map((source) => (
                    <Item
                        key={source.id}
                        testID={`team-directory-source-${source.id}`}
                        icon={identityProviderKindMark(source.kind === 'workos_directory' ? 'workos_sso' : 'github_app_identity')}
                        title={source.displayName}
                        subtitle={source.kind === 'workos_directory'
                            ? t('teams.authentication.directory.kind.workos')
                            : t('teams.authentication.directory.kind.github')}
                        detail={directorySourceStateLabel(directorySourcePresentationState(source))}
                        onPress={() => router.push(teamDirectorySourcePath(props.address, source.id))}
                    />
                ))}
                {state.nextCursor && state.failure && !state.stale ? (
                    <SurfaceStateCard
                        testID="team-directory-sources-load-more"
                        kind="error"
                        size="line"
                        title={identityAdministrationFailureMessage(state.failure.code)}
                        action={{ label: t('common.retry'), onPress: () => void loadMore() }}
                    />
                ) : state.nextCursor && !state.stale ? (
                    <Item
                        testID="team-directory-sources-load-more"
                        title={t('teams.authentication.directory.sourcesLoadMore')}
                        loading={state.loadingMore}
                        disabled={state.loadingMore || state.refreshing}
                        onPress={() => void loadMore()}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>}</SettingSection>
            {setup.kind === 'ready' || setup.kind === 'unavailable' || (setup.kind === 'loading' && setup.items.length > 0) ? (
                <ItemGroup
                    title={t('teams.authentication.directory.setup.options')}
                    description={t('teams.authentication.directory.setup.optionsFooter')}
                >
                    <SettingAnchor setting={DIRECTORY_SETTINGS.settings.workosSetup}><Item
                        testID="team-directory-setup-workos"
                        icon={identityProviderKindMark('workos_sso')}
                        title={t('teams.authentication.directory.setup.workos')}
                        subtitle={t('teams.authentication.directory.setup.workosSubtitle')}
                        loading={pendingSetup === 'workos-portal'}
                        disabled={!projectionCurrent || !props.mutationsAvailable || pendingSetup !== null}
                        onPress={() => void startWorkosSetup()}
                        showChevron={false}
                    /></SettingAnchor>
                    {setup.items.map((option) => {
                        const optionId = option.kind === 'workos_directory'
                            ? option.workosDirectoryId
                            : option.githubAppInstallationId;
                        return (
                            <Item
                                key={`${option.kind}:${optionId}`}
                                testID={`team-directory-setup-option:${option.kind}:${optionId}`}
                                icon={identityProviderKindMark(option.kind === 'workos_directory' ? 'workos_sso' : 'github_app_identity')}
                                title={option.displayName}
                                subtitle={option.kind === 'workos_directory'
                                    ? t('teams.authentication.directory.kind.workos')
                                    : t('teams.authentication.directory.kind.github')}
                                loading={pendingSetup === optionId}
                                disabled={!projectionCurrent || !props.mutationsAvailable || pendingSetup !== null}
                                onPress={() => void createSource(option)}
                                showChevron={false}
                            />
                        );
                    })}
                    {setup.kind === 'ready' && setup.items.length === 0 ? (
                        <SurfaceStateCard kind="empty" size="line" title={t('teams.authentication.directory.setup.empty')} />
                    ) : null}
                    {setup.kind === 'ready' && !setup.complete && setup.nextCursor ? (
                        <Item
                            testID="team-directory-setup-load-more"
                            title={t('teams.authentication.directory.setup.loadMore')}
                            onPress={() => void loadSetup(setup.nextCursor)}
                            showChevron={false}
                        />
                    ) : null}
                    {setup.kind === 'loading' && setup.items.length > 0 ? (
                        <SurfaceStateCard
                            testID="team-directory-setup-loading-more"
                            kind="loading"
                            size="line"
                            title={t('teams.authentication.directory.setup.loadMore')}
                        />
                    ) : null}
                    {setup.failure && workosPlatformMissing ? (
                        <SurfaceStateCard
                            testID="team-directory-setup-workos-unavailable"
                            kind="unavailable"
                            size="line"
                            title={setup.failure}
                            reason={recoveryViewer.viewerHomeRole === 'owner' ? undefined : askAdministratorsText(recoveryViewer.administratorNames ?? [])}
                            action={recoveryViewer.viewerHomeRole === 'owner'
                                ? { testID: 'team-directory-setup-workos-fix', label: t('teams.authentication.add.fixInSignInProviders'), onPress: () => router.push(homeSignInPlatformHref(props.scope.serverId, 'workos')) }
                                : undefined}
                        />
                    ) : setup.failure || setup.kind === 'unavailable' ? (
                        <SurfaceStateCard
                            kind="error"
                            size="line"
                            title={setup.failure ?? t('identityAdministration.error')}
                            action={setup.kind === 'unavailable'
                                ? { testID: 'team-directory-setup-retry', label: t('common.retry'), onPress: () => void loadSetup(setup.retryCursor) }
                                : undefined}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}
        </>
    );
});

export const DirectorySyncSettingsScreen = React.memo(function DirectorySyncSettingsScreen(props: Readonly<{
    serverId: string;
    teamId: string;
}>) {
    return (
        <TeamSection serverId={props.serverId} teamId={props.teamId} title={t('teams.authentication.directory.title')} description={t('teams.authentication.directory.purpose')}>
            {({ team, scope, address, canMutate, requestApproval }) => team.capabilities.manageAuthentication ? (
                <AuthorizedDirectoryList scope={scope} address={address} mutationsAvailable={canMutate} requestApproval={requestApproval} />
            ) : (
                <SettingSection section={DIRECTORY_SETTINGS.sectionRefs.actions}>
                    <ItemGroup><SurfaceStateCard testID="team-directory-forbidden" kind="denied" size="line" title={t('teams.errors.forbidden')} /></ItemGroup>
                </SettingSection>
            )}
        </TeamSection>
    );
});
