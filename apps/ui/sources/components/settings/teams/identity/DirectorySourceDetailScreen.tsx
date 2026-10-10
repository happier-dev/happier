import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AppState, type Pressable } from 'react-native';

import { SettingAnchor, SettingSection, useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { SearchHeader } from '@/components/ui/forms/SearchHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { VirtualizedList, type VirtualizedListRef } from '@/components/ui/lists/virtualized';
import { restoreFocusToBestTarget } from '@/keyboard/focusReturn';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { useTeamPagedList } from '@/hooks/teams/useTeamPagedList';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { TeamDirectoryGroupPageV1 } from '@happier-dev/protocol/teams';
import { identityAdministrationFailureMessage } from '@/components/settings/identity/identityAdministrationFailure';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { getPreferredLanguage, t } from '@/text';
import { Modal } from '@/modal';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import { TeamSection } from '../TeamSection';
import { teamMemberDetailPath } from '../teamsRoutes';
import { DirectoryListFailure, useDirectoryPeopleList } from './DirectoryPeopleList';
import { directorySourcePresentationState, directorySourceRemovalBody, directorySourceStateLabel } from './directoryAdministrationPresentation';
import { runDirectoryGroupMappingChange } from './directoryGroupMapping';
import { runDirectorySourceRemoval } from './directorySourceRemoval';
import {
    createIdentityAdministrationClient,
    executeIdentityAdministrationRead,
    type TeamIdentityActionOutput,
} from './identityAdministrationClient';
import { useDirectorySourceAdministration } from './useDirectoryAdministration';
import { buildVirtualizedSegments } from './directorySourceDetailVirtualization';
import { createWorkosPortalReturnController } from './workosPortalReturn';
import { DIRECTORY_SOURCE_SETTINGS } from './directorySettings';

type DirectoryDetailVirtualRow = Readonly<{
    key: string;
    element: React.ReactElement;
}>;

const DIRECTORY_DETAIL_SEGMENT_SIZE = 12;

function formatTimestamp(value: string | null): string {
    if (value === null) return t('teams.authentication.directory.never');
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) return t('teams.authentication.directory.unknown');
    return formatWithCachedDateTimeFormatter(timestamp, getPreferredLanguage(), {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}

const DirectoryGroupMappings = React.memo(function DirectoryGroupMappings(props: Readonly<{
    scope: Parameters<typeof createIdentityAdministrationClient>[0];
    address: TeamAddress;
    sourceId: string;
    groupMappingsAvailable: boolean;
    mutationsAvailable: boolean;
    requestApproval: (registration: ActionApprovalRegistration) => void;
    beforeRows: readonly DirectoryDetailVirtualRow[];
    /** Rows that close the page after the mappings, such as the source's removal button row. */
    afterRows?: readonly DirectoryDetailVirtualRow[];
    header: React.ReactElement;
}>) {
    const [query, setQuery] = React.useState('');
    const [choosingFor, setChoosingFor] = React.useState<string | null>(null);
    const [pendingGroupId, setPendingGroupId] = React.useState<string | null>(null);
    const [failure, setFailure] = React.useState<string | null>(null);
    const listRef = React.useRef<VirtualizedListRef>(null);
    const revealGroupSearch = useSettingRevealRequested([DIRECTORY_SOURCE_SETTINGS.settings.searchGroups]);
    const revealRemoval = useSettingRevealRequested([DIRECTORY_SOURCE_SETTINGS.settings.remove]);
    const revealedSetting = React.useRef<string | null>(null);
    const triggerRef = React.useRef<React.ComponentRef<typeof Pressable> | null>(null);
    const focusChooser = React.useCallback((target: React.ComponentRef<typeof Pressable> | null) => {
        if (target) restoreFocusToBestTarget({ current: target });
    }, []);
    const closeChooser = React.useCallback(() => {
        restoreFocusToBestTarget(triggerRef);
        setChoosingFor(null);
    }, []);
    const onChooserKeyDown = React.useCallback<NonNullable<React.ComponentProps<typeof Item>['onKeyDown']>>((event) => {
        if ((event.key ?? event.nativeEvent?.key) !== 'Escape') return;
        event.preventDefault?.();
        closeChooser();
    }, [closeChooser]);

    // Announced as well as shown: the outcome renders far below the control.
    const reportMappingFailure = React.useCallback((code: string) => {
        const message = identityAdministrationFailureMessage(code);
        setFailure(message);
        announceAccessibilityMessage(message);
    }, []);
    const client = React.useMemo(
        () => createIdentityAdministrationClient(props.scope, {
            onApprovalPending: props.requestApproval,
        }),
        [props.requestApproval, props.scope.accountId, props.scope.serverId],
    );
    const loadPage = React.useCallback(async (cursor: string | null, signal: AbortSignal) => {
        const result = await executeIdentityAdministrationRead<TeamDirectoryGroupPageV1>((options) => client.executeDirectory('teams.directory.groups.list', {
            v: 1,
            teamId: props.address.teamId,
            sourceId: props.sourceId,
            limit: 50,
            cursor,
            ...(query.trim() ? { query: query.trim() } : {}),
        }, options), signal);
        return result.ok
            ? { kind: 'succeeded' as const, value: result.value }
            : { kind: 'failed' as const, failure: result.failure.domainFailure ?? { kind: 'unknown' as const, retryable: result.failure.retryable, code: null } };
    }, [client, props.address.teamId, props.sourceId, query]);
    const directoryGroups = useTeamPagedList({
        key: `${props.scope.serverId} ${props.scope.accountId} ${props.address.teamId} ${props.sourceId} ${query.trim()}`,
        enabled: props.groupMappingsAvailable,
        loadPage,
        // Directory projection changes are published as the Team change.
        accountChange: { serverId: props.address.serverId, entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 },
    });
    const nativeGroups = useTeamGroups({
        scope: props.scope,
        address: props.address,
        archived: 'active',
        enabled: props.groupMappingsAvailable,
    });
    const nativeGroupNames = React.useMemo(
        () => new Map(nativeGroups.rows.map((group) => [group.id, group.name] as const)),
        [nativeGroups.rows],
    );
    const mappingAvailable = props.mutationsAvailable && directoryGroups.status === 'ready' && !directoryGroups.error;

    const changeMapping = React.useCallback(async (
        group: (typeof directoryGroups.rows)[number],
        target: Parameters<typeof runDirectoryGroupMappingChange>[0]['target'],
    ) => {
        // Roster binding counts describe the people behind this mapping. They
        // are not a promise of exact grants/removals: native ownership survives.
        const teamGroupName = (teamGroupId: string) =>
            nativeGroupNames.get(teamGroupId) ?? t('teams.authentication.directory.unknown');
        const mappedTo = (name: string) => `${t('identityAdministration.mappedTo')}: ${name}`;
        const destination = target === null
            ? (group.mapping.state === 'bound' ? mappedTo(teamGroupName(group.mapping.teamGroupId)) : null)
            : target.kind === 'native_target'
                ? mappedTo(teamGroupName(target.teamGroupId))
                : t('identityAdministration.mapCreate');
        const confirmed = await Modal.confirm(
            target === null ? t('identityAdministration.removeMapping') : t('identityAdministration.chooseGroup'),
            [
                group.displayName,
                destination,
                t('teams.authentication.directory.people.boundAccountCount', { count: group.boundAccountCount === null ? t('teams.authentication.directory.unknown') : group.boundAccountCount }),
                t('teams.authentication.directory.people.unboundPeopleCount', { count: group.unboundPeopleCount === null ? t('teams.authentication.directory.unknown') : group.unboundPeopleCount }),
            ].filter((line): line is string => line !== null).join('\n'),
            {
                cancelText: t('common.cancel'),
                confirmText: target === null ? t('identityAdministration.removeMapping') : t('common.continue'),
                ...(target === null ? { destructive: true } : {}),
            },
        );
        if (!confirmed) return;
        setPendingGroupId(group.id);
        setFailure(null);
        const finishMapping = async () => {
            closeChooser();
            await directoryGroups.reload();
        };
        try {
            const result = await runDirectoryGroupMappingChange({
                sourceId: props.sourceId,
                group,
                target,
                execute: async (command) => {
                    const outcome = command.kind === 'set'
                        ? await client.executeExternalGroupBinding('teams.externalGroupBindings.set', {
                            v: 1,
                            teamId: props.address.teamId,
                            owner: { kind: 'directory_source', directorySourceId: props.sourceId },
                            externalGroupId: command.externalGroupId,
                            target: command.target,
                        }, {
                            onApprovalSucceeded: finishMapping,
                            onApprovalFailed: reportMappingFailure,
                        })
                        : await client.executeExternalGroupBinding('teams.externalGroupBindings.remove', {
                            v: 1,
                            teamId: props.address.teamId,
                            bindingId: command.bindingId,
                        }, {
                            onApprovalSucceeded: finishMapping,
                            onApprovalFailed: reportMappingFailure,
                        });
                    if (outcome.ok) return { ok: true };
                    return 'approvalPending' in outcome
                        ? { ok: false, approvalPending: true, code: outcome.failure.code }
                        : { ok: false, code: outcome.failure.code };
                },
            });
            if (!result.ok) {
                if (!result.approvalPending) reportMappingFailure(result.code);
            } else await finishMapping();
        } finally {
            setPendingGroupId(null);
        }
    }, [client, closeChooser, directoryGroups, nativeGroupNames, props.address.teamId, props.sourceId, reportMappingFailure]);

    const selectedGroup = choosingFor === null
        ? null
        : directoryGroups.rows.find((group) => group.id === choosingFor) ?? null;

    const rows = React.useMemo(() => {
        const result: DirectoryDetailVirtualRow[] = [...props.beforeRows];
        if (!props.groupMappingsAvailable) return [...result, ...(props.afterRows ?? [])];
        result.push({
            key: 'groups-search',
            element: <SettingSection section={DIRECTORY_SOURCE_SETTINGS.sectionRefs.groups}>
                <SettingAnchor setting={DIRECTORY_SOURCE_SETTINGS.settings.searchGroups}>
                    <SearchHeader testID="directory-groups-search" value={query} onChangeText={setQuery} placeholder={t(DIRECTORY_SOURCE_SETTINGS.settings.searchGroups.titleKey)} />
                </SettingAnchor>
            </SettingSection>,
        });
        if (directoryGroups.status === 'loading' && directoryGroups.rows.length === 0) {
            result.push({ key: 'groups-loading', element: <ItemGroup title={t('identityAdministration.directoryGroups')}><Item title={t('common.loading')} loading showChevron={false} /></ItemGroup> });
        } else if (directoryGroups.rows.length === 0 && !directoryGroups.error) {
            result.push({ key: 'groups-empty', element: <ItemGroup title={t('identityAdministration.directoryGroups')}><Item title={t('teams.authentication.directory.empty')} showChevron={false} /></ItemGroup> });
        } else {
            // Give the opened chooser its own adjacent virtual row so the list
            // can reach it directly, even on a long directory page.
            const chooser = selectedGroup === null ? null : (
                <ItemGroup title={t('identityAdministration.chooseGroup')}>
                    <Item testID="directory-group-map-create" pressableRef={focusChooser} onKeyDown={onChooserKeyDown} title={t('identityAdministration.mapCreate')} disabled={pendingGroupId !== null || !mappingAvailable} onPress={() => void changeMapping(selectedGroup, { kind: 'directory_created' })} showChevron={false} />
                    {nativeGroups.status === 'loading' && nativeGroups.rows.length === 0 ? <Item title={t('common.loading')} loading showChevron={false} /> : null}
                    {nativeGroups.isCurrent && nativeGroups.rows.length === 0 ? <Item testID="directory-native-groups-empty" title={t('teams.groups.emptyTitle')} showChevron={false} /> : null}
                    {nativeGroups.rows.map((group) => <Item key={group.id} testID={`directory-group-native-target:${group.id}`} onKeyDown={onChooserKeyDown} title={group.name} subtitle={t('teams.groups.memberCount', { count: group.memberCount })} disabled={pendingGroupId !== null || !mappingAvailable || !nativeGroups.isCurrent} onPress={() => void changeMapping(selectedGroup, { kind: 'native_target', teamGroupId: group.id })} showChevron={false} />)}
                    {nativeGroups.error ? <DirectoryListFailure testID="directory-native-groups" failure={nativeGroups.error} retry={nativeGroups.reload} /> : null}
                    {nativeGroups.hasMore && nativeGroups.status !== 'loading' && !nativeGroups.error ? <Item onKeyDown={onChooserKeyDown} title={t('identityAdministration.loadMore')} loading={nativeGroups.status === 'loading_more'} disabled={nativeGroups.status === 'loading_more'} onPress={() => void nativeGroups.loadMore()} showChevron={false} /> : null}
                    {selectedGroup.mapping.state === 'bound' ? <Item testID="directory-group-remove-mapping" onKeyDown={onChooserKeyDown} title={t('identityAdministration.removeMapping')} destructive disabled={pendingGroupId !== null || !mappingAvailable} onPress={() => void changeMapping(selectedGroup, null)} showChevron={false} /> : null}
                    <Item testID="directory-group-chooser-cancel" onKeyDown={onChooserKeyDown} title={t('common.cancel')} onPress={closeChooser} showChevron={false} />
                </ItemGroup>
            );
            directoryGroups.rows.forEach((group, index) => {
                result.push({
                    key: `groups:${group.id}`,
                    element: (
                    <ItemGroup title={index === 0 ? t('identityAdministration.directoryGroups') : undefined} virtualizedSegment={{ first: index === 0, last: index === directoryGroups.rows.length - 1 }}>
                            <Item
                                key={group.id}
                                testID={`directory-group:${group.id}`}
                                title={group.displayName}
                                subtitle={group.mapping.state === 'bound'
                                    ? `${t('identityAdministration.mappedTo')}: ${nativeGroupNames.get(group.mapping.teamGroupId) ?? t('teams.authentication.directory.unknown')}`
                                    : t('identityAdministration.unmapped')}
                                detail={group.memberCount === null ? undefined : t('teams.groups.memberCount', { count: group.memberCount })}
                                loading={pendingGroupId === group.id}
                                pressableRef={choosingFor === group.id ? triggerRef : undefined}
                                accessibilityExpanded={choosingFor === group.id}
                                disabled={pendingGroupId !== null || !mappingAvailable}
                                onPress={() => setChoosingFor((current) => current === group.id ? null : group.id)}
                                showChevron={false}
                            />
                    </ItemGroup>
                    ),
                });
                if (selectedGroup !== null && chooser !== null && group.id === selectedGroup.id) {
                    result.push({ key: `groups-choice:${selectedGroup.id}`, element: chooser });
                }
            });
        }
        if (directoryGroups.error) result.push({ key: 'groups-error', element: <ItemGroup><DirectoryListFailure testID="directory-groups" failure={directoryGroups.error} retry={directoryGroups.reload} /></ItemGroup> });
        if (directoryGroups.hasMore && directoryGroups.status !== 'loading' && !directoryGroups.error) result.push({ key: 'groups-more', element: <ItemGroup><Item testID="directory-groups-load-more" title={t('identityAdministration.loadMore')} loading={directoryGroups.status === 'loading_more'} disabled={directoryGroups.status === 'loading_more'} onPress={() => void directoryGroups.loadMore()} showChevron={false} /></ItemGroup> });
        if (failure) result.push({ key: 'groups-failure', element: <ItemGroup><Item testID="directory-group-mapping-failure" title={failure} showChevron={false} /></ItemGroup> });
        return [...result, ...(props.afterRows ?? [])];
    }, [props.afterRows, changeMapping, choosingFor, closeChooser, focusChooser, onChooserKeyDown, directoryGroups.error, directoryGroups.hasMore, directoryGroups.loadMore, directoryGroups.reload, directoryGroups.rows, directoryGroups.status, failure, mappingAvailable, nativeGroupNames, nativeGroups.error, nativeGroups.hasMore, nativeGroups.isCurrent, nativeGroups.loadMore, nativeGroups.reload, nativeGroups.rows, nativeGroups.status, pendingGroupId, props.beforeRows, props.groupMappingsAvailable, query, selectedGroup]);

    const chooserIndex = rows.findIndex((row) => row.key === `groups-choice:${choosingFor}`);
    React.useEffect(() => {
        if (chooserIndex >= 0) void listRef.current?.scrollToIndex({ index: chooserIndex, animated: false });
    }, [chooserIndex, choosingFor]);

    const requestedSettingRow = revealGroupSearch ? 'groups-search' : revealRemoval ? 'source-remove' : null;
    const requestedSettingIndex = rows.findIndex((row) => row.key === requestedSettingRow);
    React.useEffect(() => {
        revealedSetting.current = null;
    }, [props.scope.serverId, props.scope.accountId, props.address.teamId, props.sourceId, requestedSettingRow]);
    React.useEffect(() => {
        if (requestedSettingRow === null || requestedSettingIndex < 0 || revealedSetting.current === requestedSettingRow) return;
        // Mount the requested virtual row first; its canonical SettingAnchor
        // then owns marking/revealing it. Later page refreshes must not pull
        // the person back after they have moved elsewhere in the list.
        revealedSetting.current = requestedSettingRow;
        void listRef.current?.scrollToIndex({ index: requestedSettingIndex, animated: false });
    }, [props.scope.serverId, props.scope.accountId, props.address.teamId, props.sourceId, requestedSettingIndex, requestedSettingRow]);

    const renderRow = React.useCallback(({ item }: Readonly<{ item: DirectoryDetailVirtualRow }>) => item.element, []);

    return <VirtualizedList
        ref={listRef}
        testID="directory-source-detail-virtualized-list"
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={renderRow}
        ListHeaderComponent={props.header}
        style={{ flex: 1 }}
        backendPreference="auto"
        initialNumToRender={8}
        maxToRenderPerBatch={6}
        windowSize={7}
        estimatedItemSize={180}
        maintainVisibleContentPosition
        keyboardShouldPersistTaps="handled"
    />;
});

const AuthorizedDirectorySourceDetail = React.memo(function AuthorizedDirectorySourceDetail(props: Readonly<{
    scope: Parameters<typeof useDirectorySourceAdministration>[0];
    address: NonNullable<Parameters<typeof useTeamGroups>[0]['address']>;
    teamId: string;
    sourceId: string;
    groupMappingsAvailable: boolean;
    mutationsAvailable: boolean;
    requestApproval: (registration: ActionApprovalRegistration) => void;
    shellHeader?: React.ReactNode;
}>) {
    const router = useRouter();
    const revealGroupSearch = useSettingRevealRequested([DIRECTORY_SOURCE_SETTINGS.settings.searchGroups]);
    const { state, refresh, pendingAction, runAction, readRemovalImpact, removeSource } = useDirectorySourceAdministration(
        props.scope,
        props.teamId,
        props.sourceId,
        props.requestApproval,
    );
    const [actionFailure, setActionFailure] = React.useState<string | null>(null);
    const [workosPortalPending, setWorkosPortalPending] = React.useState(false);
    const portalReturnController = React.useRef(createWorkosPortalReturnController()).current;
    const client = React.useMemo(
        () => createIdentityAdministrationClient(props.scope, {
            onApprovalPending: props.requestApproval,
        }),
        [props.requestApproval, props.scope.accountId, props.scope.serverId],
    );

    // Announced as well as shown: the outcome renders far below the control.
    const reportActionFailure = React.useCallback((code: string) => {
        const message = identityAdministrationFailureMessage(code);
        setActionFailure(message);
        announceAccessibilityMessage(message);
    }, []);

    const source = state.kind === 'ready' ? state.item : null;
    React.useEffect(() => {
        const refreshOnReturn = () => {
            if (portalReturnController.consumeReturn()) refresh();
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
    }, [portalReturnController, refresh]);
    const people = useDirectoryPeopleList({
        scope: props.scope,
        address: props.address,
        sourceId: props.sourceId,
        enabled: source !== null,
        requestApproval: props.requestApproval,
    });
    const can = React.useCallback((actionId: Parameters<typeof runAction>[0]) => (
        source?.allowedActions.includes(actionId) ?? false
    ), [source]);
    const run = React.useCallback(async (actionId: Parameters<typeof runAction>[0]) => {
        setActionFailure(null);
        const result = await runAction(actionId, { onApprovalFailed: reportActionFailure });
        if (!result.ok && !('approvalPending' in result)) reportActionFailure(result.failure.code);
        return result.ok;
    }, [reportActionFailure, runAction]);
    const pause = React.useCallback(async () => {
        if (!source) return;
        if (!await Modal.confirm(
            t('teams.authentication.directory.actions.pauseTitle', { source: source.displayName }),
            t('teams.authentication.directory.actions.pauseBody'),
            { cancelText: t('common.cancel'), confirmText: t('teams.authentication.directory.actions.pause') },
        )) return;
        await run('teams.directory.sources.pause');
    }, [run, source]);
    const openWorkosSetup = React.useCallback(async () => {
        const connectionId = source?.workosAdminPortalConnectionId;
        if (!connectionId || source.kind !== 'workos_directory' || !props.mutationsAvailable) return;
        if (!await Modal.confirm(
            t('identityAdministration.workosSetupDirectory'),
            t('identityAdministration.workosDirectoryPortalConfirmBody'),
            { cancelText: t('common.cancel'), confirmText: t('common.continue') },
        )) return;
        setWorkosPortalPending(true);
        setActionFailure(null);
        try {
            const continuePortal = async (
                value: TeamIdentityActionOutput<'teams.identity.workos.adminPortalLink.create'>,
            ) => {
                let isHttps = false;
                try {
                    isHttps = new URL(value.url).protocol === 'https:';
                } catch {
                    // Invalid external links fail closed below.
                }
                if (!isHttps || !await openExternalUrl(value.url)) {
                    reportActionFailure('workos_portal_open_failed');
                    return;
                }
                portalReturnController.markOpened();
            };
            const result = await client.execute(
                'teams.identity.workos.adminPortalLink.create',
                {
                    v: 1,
                    teamId: props.teamId,
                    connectionId,
                    directorySourceId: source.id,
                    intent: 'dsync',
                },
                { onApprovalSucceeded: continuePortal, onApprovalFailed: reportActionFailure },
            );
            if (!result.ok) {
                if ('approvalPending' in result) return;
                reportActionFailure(result.failure.code);
                return;
            }
            await continuePortal(result.value);
        } finally {
            setWorkosPortalPending(false);
        }
    }, [client, portalReturnController, props.mutationsAvailable, props.teamId, reportActionFailure, source]);
    const remove = React.useCallback(async () => {
        if (!source) return;
        setActionFailure(null);
        const outcome = await runDirectorySourceRemoval({
            sourceId: source.id,
            readImpact: readRemovalImpact,
            confirm: async (preflight) => await Modal.confirm(
                t('teams.authentication.directory.actions.removeTitle', { source: preflight.sourceLabel }),
                directorySourceRemovalBody(preflight.impact),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('teams.authentication.directory.actions.remove'),
                    destructive: true,
                },
            ),
            remove: removeSource,
            onApprovalSucceeded: async () => router.back(),
            onApprovalFailed: reportActionFailure,
        });
        if (outcome.kind === 'failed' && outcome.code !== 'aborted') {
            reportActionFailure(outcome.code);
        } else if (outcome.kind === 'removed') {
            router.back();
        }
    }, [readRemovalImpact, removeSource, reportActionFailure, router, source]);

    if (state.kind === 'loading') {
        return <DirectoryGroupMappings
            scope={props.scope}
            address={props.address}
            sourceId={props.sourceId}
            groupMappingsAvailable={false}
            mutationsAvailable={false}
            requestApproval={props.requestApproval}
            beforeRows={[{
                key: 'source-loading',
                element: <ItemGroup><SurfaceStateCard testID="team-directory-source-loading" kind="loading" size="line" title={t('common.loading')} accessibilitySemantics="status" /></ItemGroup>,
            }]}
            header={<>{props.shellHeader}</>}
        />;
    }
    if (state.kind === 'unavailable') {
        return <DirectoryGroupMappings
            scope={props.scope}
            address={props.address}
            sourceId={props.sourceId}
            groupMappingsAvailable={false}
            mutationsAvailable={false}
            requestApproval={props.requestApproval}
            beforeRows={[{
                key: 'source-unavailable',
                element: (
                    <ItemGroup>
                        <SurfaceStateCard
                            testID="team-directory-source-unavailable"
                            kind="error"
                            size="line"
                            title={identityAdministrationFailureMessage(state.failure.code)}
                            diagnosticCode={state.failure.code}
                            action={state.failure.retryable ? { label: t('common.retry'), onPress: refresh } : undefined}
                            accessibilitySemantics="alert"
                        />
                    </ItemGroup>
                ),
            }]}
            header={<>{props.shellHeader}</>}
        />;
    }
    if (!source) {
        return <DirectoryGroupMappings
            scope={props.scope}
            address={props.address}
            sourceId={props.sourceId}
            groupMappingsAvailable={false}
            mutationsAvailable={false}
            requestApproval={props.requestApproval}
            beforeRows={[{
                key: 'source-not-found',
                element: <ItemGroup><SurfaceStateCard testID="team-directory-source-not-found" kind="unavailable" size="line" title={t('teams.errors.notFound')} /></ItemGroup>,
            }]}
            header={<>{props.shellHeader}</>}
        />;
    }
    const projectionCurrent = !state.refreshing && !state.stale;
    const beforeRows: DirectoryDetailVirtualRow[] = [];
    const peopleSegments = buildVirtualizedSegments(people.rows, DIRECTORY_DETAIL_SEGMENT_SIZE);
    if (people.status === 'loading' && people.rows.length === 0) {
        beforeRows.push({ key: 'people-loading', element: <ItemGroup title={t('teams.authentication.directory.people.section')}><Item title={t('common.loading')} loading showChevron={false} /></ItemGroup> });
    } else if (people.rows.length === 0 && !people.error) {
        beforeRows.push({ key: 'people-empty', element: <ItemGroup title={t('teams.authentication.directory.people.section')}><Item title={t('teams.authentication.directory.people.empty')} showChevron={false} /></ItemGroup> });
    } else {
        peopleSegments.forEach((segment, index) => beforeRows.push({
            key: `people:${index}`,
            element: <ItemGroup title={segment.first ? t('teams.authentication.directory.people.section') : undefined} virtualizedSegment={{ first: segment.first, last: segment.last }}>
                {segment.items.map((person) => {
                    const membershipId = person.accountBinding.state === 'bound' ? person.accountBinding.teamMembershipId : null;
                    const stateLabel = person.state === 'active' ? null : t(`teams.authentication.directory.people.state.${person.state}`);
                    const identityLabel = person.email ?? person.externalLogin;
                    return <Item
                        key={person.id}
                        testID={`directory-person:${person.id}`}
                        title={person.displayName ?? identityLabel ?? t('teams.authentication.directory.people.unknown')}
                        subtitle={[identityLabel, stateLabel].filter((value): value is string => value !== null).join(' · ') || undefined}
                        detail={person.accountBinding.state === 'unbound' ? t('teams.authentication.directory.people.provisioned') : t('teams.authentication.directory.people.member')}
                        onPress={membershipId === null ? undefined : () => router.push(teamMemberDetailPath(props.address, membershipId))}
                        showChevron={membershipId !== null}
                    />;
                })}
            </ItemGroup>,
        }));
    }
    if (people.error) beforeRows.push({ key: 'people-error', element: <ItemGroup><DirectoryListFailure testID="directory-people" failure={people.error} retry={people.reload} /></ItemGroup> });
    if (people.hasMore && people.status !== 'loading' && !people.error) beforeRows.push({ key: 'people-more', element: <ItemGroup><Item testID="directory-people-load-more" title={t('teams.authentication.directory.people.loadMore')} loading={people.status === 'loading_more'} disabled={people.status === 'loading_more'} onPress={() => void people.loadMore()} showChevron={false} /></ItemGroup> });
    if (revealGroupSearch && !props.groupMappingsAvailable) beforeRows.push({
        key: 'groups-search',
        element: <SettingSection section={DIRECTORY_SOURCE_SETTINGS.sectionRefs.groups}>
            <ItemGroup title={t('identityAdministration.directoryGroups')}>
                <Item testID="directory-groups-forbidden" title={t('teams.errors.forbidden')} showChevron={false} />
            </ItemGroup>
        </SettingSection>,
    });
    const header = (
        <>
            {props.shellHeader}
            {state.stale ? (
                <AttentionBanner
                    testID="team-directory-source-stale"
                    title={t('teams.unavailable.offline')}
                    description={t('teams.stale.label')}
                    accessibilityLiveRegion="polite"
                    action={{ label: t('common.retry'), onPress: refresh }}
                />
            ) : null}
            <ItemGroup title={source.displayName}>
                <Item
                    testID="team-directory-source-status"
                    title={t('teams.authentication.directory.detail.status')}
                    detail={directorySourceStateLabel(directorySourcePresentationState(source))}
                    showChevron={false}
                />
                <Item
                    title={t('teams.authentication.directory.detail.sourceType')}
                    detail={source.kind === 'workos_directory'
                        ? t('teams.authentication.directory.kind.workos')
                        : t('teams.authentication.directory.kind.github')}
                    showChevron={false}
                />
            </ItemGroup>
            <ItemGroup title={t('teams.authentication.directory.detail.syncSection')}>
                <Item
                    title={t('teams.authentication.directory.detail.mode')}
                    detail={source.sync.mode === 'events_and_full'
                        ? t('teams.authentication.directory.mode.eventsAndFull')
                        : t('teams.authentication.directory.mode.fullOnly')}
                    showChevron={false}
                />
                <Item
                    title={t('teams.authentication.directory.detail.freshness')}
                    detail={t(`teams.authentication.directory.freshness.${source.sync.freshness}`)}
                    showChevron={false}
                />
                <Item
                    title={t('teams.authentication.directory.detail.lastSuccess')}
                    detail={formatTimestamp(source.sync.lastSuccessAt)}
                    showChevron={false}
                />
                {source.sync.nextScheduledAt ? (
                    <Item
                        title={t('teams.authentication.directory.detail.nextScheduled')}
                        detail={formatTimestamp(source.sync.nextScheduledAt)}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
            {source.error ? (
                <ItemGroup title={t('teams.authentication.directory.detail.attentionSection')}>
                    <Item
                        testID="team-directory-source-error"
                        title={identityAdministrationFailureMessage(source.error.code)}
                        subtitle={source.error.retryable
                            ? t('teams.authentication.directory.detail.attentionRetryable')
                            : t('teams.authentication.directory.detail.attentionAdmin')}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
            {actionFailure ? (
                <ItemGroup>
                    <Item
                        testID="team-directory-source-action-error"
                        title={actionFailure}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
            <SettingSection section={DIRECTORY_SOURCE_SETTINGS.sectionRefs.actions}>
                <ItemGroup title={t('teams.authentication.directory.actions.section')}>
                    {source.kind === 'workos_directory' && source.workosAdminPortalConnectionId ? (
                        <SettingAnchor setting={DIRECTORY_SOURCE_SETTINGS.settings.workosSetup}>
                            <Item
                                testID="team-directory-source-open-workos"
                                title={t(DIRECTORY_SOURCE_SETTINGS.settings.workosSetup.titleKey)}
                                disabled={!projectionCurrent || pendingAction !== null || workosPortalPending || !props.mutationsAvailable}
                                loading={workosPortalPending}
                                onPress={() => void openWorkosSetup()}
                                showChevron={false}
                            />
                        </SettingAnchor>
                    ) : null}
                    {can('teams.directory.sources.sync') ? (
                        <SettingAnchor setting={DIRECTORY_SOURCE_SETTINGS.settings.syncNow}>
                            <Item
                                testID="team-directory-source-sync"
                                // child 05 §14.1: a failed source offers Retry — the
                                // same one complete-scan Sync Action.
                                title={source.error ? t('common.retry') : t(DIRECTORY_SOURCE_SETTINGS.settings.syncNow.titleKey)}
                                disabled={!projectionCurrent || pendingAction !== null || !props.mutationsAvailable}
                                detail={pendingAction === 'teams.directory.sources.sync' ? t('common.loading') : undefined}
                                onPress={() => void run('teams.directory.sources.sync')}
                                showChevron={false}
                            />
                        </SettingAnchor>
                    ) : null}
                    {can('teams.directory.sources.pause') ? (
                        <SettingAnchor setting={DIRECTORY_SOURCE_SETTINGS.settings.pause}>
                            <Item
                                testID="team-directory-source-pause"
                                title={t(DIRECTORY_SOURCE_SETTINGS.settings.pause.titleKey)}
                                disabled={!projectionCurrent || pendingAction !== null || !props.mutationsAvailable}
                                onPress={() => void pause()}
                                showChevron={false}
                            />
                        </SettingAnchor>
                    ) : null}
                    {can('teams.directory.sources.resume') ? (
                        <SettingAnchor setting={DIRECTORY_SOURCE_SETTINGS.settings.resume}>
                            <Item
                                testID="team-directory-source-resume"
                                title={t(DIRECTORY_SOURCE_SETTINGS.settings.resume.titleKey)}
                                disabled={!projectionCurrent || pendingAction !== null || !props.mutationsAvailable}
                                onPress={() => void run('teams.directory.sources.resume')}
                                showChevron={false}
                            />
                        </SettingAnchor>
                    ) : null}
                </ItemGroup>
            </SettingSection>
        </>
    );
    // Removing the source closes this page, so it ends the page as a quiet button row.
    const afterRows: DirectoryDetailVirtualRow[] = can('teams.directory.sources.remove') ? [{
        key: 'source-remove',
        element: (
            <ItemGroup surface="none">
                <SettingAnchor setting={DIRECTORY_SOURCE_SETTINGS.settings.remove}>
                    <SectionButtonRow>
                        <RoundButton
                            testID="team-directory-source-remove"
                            size="small"
                            display="destructive"
                            title={t(DIRECTORY_SOURCE_SETTINGS.settings.remove.titleKey)}
                            loading={pendingAction === 'teams.directory.sources.remove'}
                            disabled={!projectionCurrent || pendingAction !== null || !props.mutationsAvailable}
                            onPress={() => void remove()}
                        />
                    </SectionButtonRow>
                </SettingAnchor>
            </ItemGroup>
        ),
    }] : [];
    return <DirectoryGroupMappings
        scope={props.scope}
        address={props.address}
        sourceId={source.id}
        groupMappingsAvailable={props.groupMappingsAvailable}
        mutationsAvailable={props.mutationsAvailable && projectionCurrent}
        requestApproval={props.requestApproval}
        beforeRows={beforeRows}
        afterRows={afterRows}
        header={header}
    />;
});

export const DirectorySourceDetailScreen = React.memo(function DirectorySourceDetailScreen(props: Readonly<{
    serverId: string;
    teamId: string;
    sourceId: string;
}>) {
    return (
        <TeamSection serverId={props.serverId} teamId={props.teamId} title={t('teams.authentication.directory.title')} description={t('teams.authentication.directory.sourcePurpose')} presentation="virtualized-list">
            {({ team, scope, address, canMutate, requestApproval }, shellHeader) => team.capabilities.manageAuthentication ? (
                <AuthorizedDirectorySourceDetail
                    scope={scope}
                    address={address}
                    teamId={team.id}
                    sourceId={props.sourceId}
                    groupMappingsAvailable={team.capabilities.manageGroups}
                    mutationsAvailable={canMutate}
                    requestApproval={requestApproval}
                    shellHeader={shellHeader}
                />
            ) : <>
                {shellHeader}
                <SettingSection section={DIRECTORY_SOURCE_SETTINGS.sectionRefs.actions} answersFor={[DIRECTORY_SOURCE_SETTINGS.sectionRefs.groups]}>
                    <ItemGroup><SurfaceStateCard testID="team-directory-source-forbidden" kind="denied" size="line" title={t('teams.errors.forbidden')} /></ItemGroup>
                </SettingSection>
            </>}
        </TeamSection>
    );
});
