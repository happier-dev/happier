import * as React from 'react';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { TEAM_IDENTITY_CONNECTION_SETTINGS } from './teamAuthenticationSettings';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { useTeamGroupNameProjectionDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import { useTeamPagedList } from '@/hooks/teams/useTeamPagedList';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { identityAdministrationFailureMessage } from '@/components/settings/identity/identityAdministrationFailure';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import { buildIdentityConnectionGroupMappingCommand } from './identityConnectionGroupMapping';
import { createIdentityAdministrationClient, executeIdentityAdministrationRead, type TeamExternalGroupBindingActionOutput } from './identityAdministrationClient';
import { teamReadFailureLabel } from '../teamMutationPresentation';

export const IdentityConnectionGroupMappings = React.memo(function IdentityConnectionGroupMappings(props: Readonly<{
    scope: Parameters<typeof createIdentityAdministrationClient>[0];
    address: TeamAddress;
    connectionId: string;
    mutationsAvailable: boolean;
    requestApproval: (registration: ActionApprovalRegistration) => void;
}>) {
    const client = React.useMemo(
        () => createIdentityAdministrationClient(props.scope, {
            onApprovalPending: props.requestApproval,
        }),
        [props.requestApproval, props.scope.accountId, props.scope.serverId],
    );
    const [externalGroupId, setExternalGroupId] = React.useState('');
    const [choosingTarget, setChoosingTarget] = React.useState(false);
    const [pending, setPending] = React.useState<string | null>(null);
    const [failure, setFailure] = React.useState<string | null>(null);

    // A typed Home outcome becomes one localized sentence, announced as well as
    // shown because it lands away from the control that was pressed.
    const reportFailure = React.useCallback((code: string) => {
        const message = identityAdministrationFailureMessage(code);
        setFailure(message);
        announceAccessibilityMessage(message);
    }, []);
    const loadPage = React.useCallback(async (cursor: string | null, signal?: AbortSignal) => {
        const result = await executeIdentityAdministrationRead<TeamExternalGroupBindingActionOutput<'teams.externalGroupBindings.list'>>((options) => client.executeExternalGroupBinding('teams.externalGroupBindings.list', {
            v: 1, teamId: props.address.teamId, ownerKind: 'identity_connection',
            teamIdentityConnectionId: props.connectionId, limit: 50, cursor,
        }, options), signal);
        return result.ok
            ? { kind: 'succeeded' as const, value: { items: result.value.items, nextCursor: result.value.nextCursor } }
            : { kind: 'failed' as const, failure: result.failure.domainFailure ?? { kind: 'unknown' as const, retryable: result.failure.retryable, code: null } };
    }, [client, props.address.teamId, props.connectionId]);
    const bindings = useTeamPagedList({
        key: `${props.scope.serverId} ${props.scope.accountId} ${props.address.teamId} ${props.connectionId} identity-groups`,
        enabled: true,
        loadPage,
    });
    const nativeGroups = useTeamGroups({ scope: props.scope, address: props.address, archived: 'active', enabled: choosingTarget && props.mutationsAvailable });
    const groupLabelInputs = React.useMemo(() => {
        const groups = new Map<string, { id: string; name: (typeof nativeGroups.rows)[number]['name'] }>();
        for (const binding of bindings.rows) groups.set(binding.target.teamGroupId, {
            id: binding.target.teamGroupId,
            name: binding.target.name,
        });
        for (const group of nativeGroups.rows) groups.set(group.id, { id: group.id, name: group.name });
        return [...groups.values()];
    }, [bindings.rows, nativeGroups.rows]);
    const openedGroupDisplayNames = useTeamGroupNameProjectionDisplayNames({
        scope: props.scope,
        groups: groupLabelInputs,
    });
    const bind = React.useCallback(async (target: Parameters<typeof buildIdentityConnectionGroupMappingCommand>[0]['target']) => {
        const command = buildIdentityConnectionGroupMappingCommand({
            teamId: props.address.teamId, connectionId: props.connectionId, externalGroupId, target,
        });
        if (!command) { setFailure(t('identityAdministration.required')); return; }
        const finishBinding = () => {
            setExternalGroupId('');
            setChoosingTarget(false);
            fireAndForget(bindings.reload(), { tag: 'IdentityConnectionGroupMappings.revalidate' });
        };
        setPending('create'); setFailure(null);
        try {
            const result = await client.executeExternalGroupBinding('teams.externalGroupBindings.set', command, {
                onApprovalSucceeded: finishBinding,
                onApprovalFailed: reportFailure,
            });
            if (!result.ok) {
                if (!('approvalPending' in result)) reportFailure(result.failure.code);
                return;
            }
            await finishBinding();
        } finally { setPending(null); }
    }, [bindings, client, externalGroupId, props.address.teamId, props.connectionId, reportFailure]);
    const remove = React.useCallback(async (binding: (typeof bindings.rows)[number]) => {
        const finishRemoval = () => {
            fireAndForget(bindings.reload(), { tag: 'IdentityConnectionGroupMappings.revalidate' });
        };
        setPending(binding.id); setFailure(null);
        try {
            const result = await client.executeExternalGroupBinding('teams.externalGroupBindings.remove', {
                v: 1, teamId: props.address.teamId, bindingId: binding.id,
            }, {
                onApprovalSucceeded: finishRemoval,
                onApprovalFailed: reportFailure,
            });
            if (!result.ok) {
                if (!('approvalPending' in result)) reportFailure(result.failure.code);
            } else await finishRemoval();
        } finally { setPending(null); }
    }, [bindings, client, props.address.teamId, reportFailure]);
    return (
        <>
            <SettingAnchor setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.groupMappings}><ItemGroup title={t('identityAdministration.directoryGroups')}>
                {bindings.status === 'loading' && bindings.rows.length === 0 ? <SurfaceStateCard kind="loading" size="line" title={t('common.loading')} /> : bindings.rows.length === 0 && !bindings.error ? <SurfaceStateCard kind="empty" size="line" title={t('identityAdministration.unmapped')} /> : bindings.rows.map((binding) => (
                    <Item key={binding.id} testID={`identity-group-binding:${binding.id}`} title={binding.externalGroupId} subtitle={`${t('identityAdministration.mappedTo')}: ${openedGroupDisplayNames.get(binding.target.teamGroupId) ?? t('common.unavailable')}`} loading={pending === binding.id} disabled={pending !== null || !props.mutationsAvailable} onPress={() => void remove(binding)} showChevron={false} />
                ))}
                {bindings.hasMore && !bindings.error ? <Item testID="identity-group-bindings-load-more" title={t('identityAdministration.loadMore')} loading={bindings.status === 'loading_more'} disabled={bindings.status === 'loading_more'} onPress={() => void bindings.loadMore()} showChevron={false} /> : null}
            </ItemGroup></SettingAnchor>
            <ItemGroup title={t('identityAdministration.chooseGroup')}>
                <SettingRow setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.externalGroupId} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="identity-external-group-id" accessibilityLabel={t('identityAdministration.directoryGroups')} value={externalGroupId} editable={props.mutationsAvailable} onChangeText={setExternalGroupId} autoCapitalize="none" />} />
                <SettingRow setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.mapCreate} testID="identity-group-map-create" loading={pending === 'create'} disabled={pending !== null || !props.mutationsAvailable} onPress={() => void bind({ kind: 'directory_created' })} showChevron={false} />
                <SettingRow setting={TEAM_IDENTITY_CONNECTION_SETTINGS.settings.mapExisting} testID="identity-group-map-existing" selected={choosingTarget} disabled={pending !== null || !props.mutationsAvailable} onPress={() => setChoosingTarget((value) => !value)} showChevron={false} />
                {choosingTarget && nativeGroups.status === 'loading' && nativeGroups.rows.length === 0 ? <SurfaceStateCard testID="identity-group-native-loading" kind="loading" size="line" title={t('common.loading')} /> : null}
                {choosingTarget && nativeGroups.isCurrent && nativeGroups.rows.length === 0 ? <SurfaceStateCard testID="identity-group-native-empty" kind="empty" size="line" title={t('teams.groups.emptyTitle')} /> : null}
                {choosingTarget ? nativeGroups.rows.map((group) => <Item key={group.id} testID={`identity-group-native-target:${group.id}`} title={openedGroupDisplayNames.get(group.id) ?? t('common.unavailable')} subtitle={t('teams.groups.memberCount', { count: group.memberCount })} disabled={pending !== null || !props.mutationsAvailable || !nativeGroups.isCurrent} onPress={() => void bind({ kind: 'native_target', teamGroupId: group.id })} showChevron={false} />) : null}
                {choosingTarget && nativeGroups.error ? <SurfaceStateCard testID="identity-group-native-error" kind="error" size="line" title={teamReadFailureLabel(nativeGroups.error)} action={nativeGroups.error.retryable ? { testID: 'identity-group-native-retry', label: t('common.retry'), onPress: () => void nativeGroups.reload() } : undefined} /> : null}
                {choosingTarget && nativeGroups.hasMore && nativeGroups.status !== 'loading' && !nativeGroups.error ? <Item title={t('identityAdministration.loadMore')} loading={nativeGroups.status === 'loading_more'} disabled={nativeGroups.status === 'loading_more'} onPress={() => void nativeGroups.loadMore()} showChevron={false} /> : null}
            </ItemGroup>
            {bindings.error ? <ItemGroup><SurfaceStateCard kind="error" size="line" title={teamReadFailureLabel(bindings.error)} action={bindings.error.retryable ? { testID: 'identity-group-bindings-retry', label: t('common.retry'), onPress: () => void bindings.reload() } : undefined} /></ItemGroup> : null}
            {failure ? <ItemGroup><SurfaceStateCard testID="identity-group-mapping-failure" kind="error" size="line" title={failure} /></ItemGroup> : null}
        </>
    );
});
