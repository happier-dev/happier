import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SessionGettingStartedSummary } from '@/components/sessions/guidance/SessionGettingStartedSummary';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAllMachines, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { resolveMachineActionCandidates } from '@/utils/sessions/resolveMachineActionCandidates';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';

import type { SessionGettingStartedDecisionKind } from '@/components/sessions/guidance/gettingStartedModel';
import { Icon } from '@/components/ui/icons/Icon';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

type SessionsListEmptyStateKind = Extract<
    SessionGettingStartedDecisionKind,
    'create_session' | 'connect_machine' | 'start_daemon' | 'select_session'
>;

type SessionsListEmptyStateProps = Readonly<{
    kind: SessionsListEmptyStateKind;
    targetLabel: string;
    surface?: 'default' | 'sidebar';
}>;

export function SessionsListEmptyState(props: SessionsListEmptyStateProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const activeServer = useActiveServerSnapshot();
    const allMachines = useAllMachines();
    useMachineReachabilityRevision();
    const accountScope = useActiveServerAccountScope(activeServer.serverId);
    const machines = resolveMachineActionCandidates(accountScope, allMachines);
    const machineNames = resolveMachineDisplayNames(allMachines);

    const handleStartSession = React.useCallback((machineId: string) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!serverId || !lifetime) return;
        seedAndOpenNewSession({
            seed: { placement: { kind: 'exactTarget', serverId, machineId } },
            scope: lifetime.scope,
            isCurrent: lifetime.isCurrent,
            navigateToNewSession: ({ draftId }) => router.push({
                pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }),
            }),
        });
    }, [activeServer.serverId, router]);

    const handleOpenSetup = React.useCallback(() => {
        router.push(buildMachineAddHref({ path: 'thisComputer' }) as never);
    }, [router]);
    // No machine yet: Home's Machines and Capacity widgets and New Session's "Run on…" carry the first steps
    // (58d AF1), so the list says only what will appear here (the phone's Sessions tab shows Home itself). Setting
    // up this machine is desktop-only; the Add flow offers it where the device can do it.
    if (props.kind === 'connect_machine') {
        return (
            <ItemList presentation="grouped" testID="sessions-empty-state-list" containerStyle={{ paddingTop: theme.space.s12 }}>
                <View testID={`session-getting-started-kind-${props.kind}`} style={{ width: 0, height: 0, overflow: 'hidden' }} />
                <EmptyState layout="line" testID="sessions-empty-state-first-run" title={t('sessionsList.emptyState.firstRunLine')} />
            </ItemList>
        );
    }

    return (
        <ItemList presentation="grouped" testID="sessions-empty-state-list" containerStyle={{ paddingTop: theme.space.s12 }}>
            <View testID={`session-getting-started-kind-${props.kind}`} style={{ width: 0, height: 0, overflow: 'hidden' }} />
            {props.surface === 'sidebar' ? (
                <SessionGettingStartedSummary
                    testID="sessions-empty-state-summary"
                    titleTestID="sessions-empty-state-title"
                    descriptionTestID="sessions-empty-state-description"
                    kind={props.kind}
                    targetLabel={props.targetLabel}
                    surface="sidebar"
                />
            ) : (
                <SessionGettingStartedSummary
                    testID="sessions-empty-state-summary"
                    titleTestID="sessions-empty-state-title"
                    descriptionTestID="sessions-empty-state-description"
                    kind={props.kind}
                    targetLabel={props.targetLabel}
                />
            )}

            {props.kind === 'create_session' && machines.length > 0 ? (
                <ItemGroup title={t('sessionsList.emptyState.actionsTitle')}>
                    {machines.map((machine) => {
                        const machineLabel = machineNames.get(machine.id)!;
                        return (
                            <Item
                                key={machine.id}
                                testID={`sessions-empty-state-machine:${machine.id}`}
                                title={t('sessionsList.emptyState.startSessionOnMachine', { machine: machineLabel })}
                                subtitle={t('sessionsList.emptyState.startSessionOnMachineSubtitle')}
                                icon={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />}
                                onPress={() => handleStartSession(machine.id)}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}

            {props.kind === 'start_daemon' ? (
                <ItemGroup>
                    <Item
                        testID="sessions-empty-state-open-setup"
                        title={t('setupOnboarding.openSetupAction')}
                        subtitle={t('sessionsList.emptyState.reconnectMachineActionSubtitle')}
                        icon={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />}
                        onPress={handleOpenSetup}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
}
