import * as React from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SessionGettingStartedSummary } from '@/components/sessions/guidance/SessionGettingStartedSummary';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAllMachines } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { buildMachineSetupWizardHref } from '@/utils/routes/setupWizardHref';
import { resolveMachineActionCandidates } from '@/utils/sessions/resolveMachineActionCandidates';

import type { SessionGettingStartedDecisionKind } from '@/components/sessions/guidance/gettingStartedModel';
import { Icon } from '@/components/ui/icons/Icon';

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
    const machines = resolveMachineActionCandidates(allMachines);

    const handleStartSession = React.useCallback((machineId: string) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        router.push({
            pathname: '/new',
            params: {
                machineId,
                ...(serverId ? { spawnServerId: serverId } : {}),
            },
        } as never);
    }, [activeServer.serverId, router]);

    const handleOpenSetup = React.useCallback(() => {
        router.push(buildMachineSetupWizardHref({
            action: 'local',
            step: 'setup_this_computer',
        }) as never);
    }, [router]);
    const setupSubtitle = props.kind === 'connect_machine'
        ? t('sessionsList.emptyState.connectMachineActionSubtitle')
        : t('sessionsList.emptyState.reconnectMachineActionSubtitle');

    return (
        <ItemList testID="sessions-empty-state-list" containerStyle={{ paddingTop: 12 }}>
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
                        const machineLabel = getMachineDisplayName(machine) ?? machine.id;
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

            {props.kind === 'connect_machine' || props.kind === 'start_daemon' ? (
                <ItemGroup>
                    <Item
                        testID="sessions-empty-state-open-setup"
                        title={t('setupOnboarding.openSetupAction')}
                        subtitle={setupSubtitle}
                        icon={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />}
                        onPress={handleOpenSetup}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
}
