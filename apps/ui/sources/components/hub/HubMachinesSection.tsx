import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';

import { useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { machineCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { MachineCliLogoRow } from '@/components/sessions/new/components/MachineCliLogoRow';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';
import { MachinePresenceCounts } from '@/components/machines/MachinePresenceCounts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard, SURFACE_CARD_PADDING_PX } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAllMachines } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { useMachinesCapabilitySnapshots } from '@/updates/machineCapabilitySnapshots';
import { useMachineUpdateRuns } from '@/updates/machineUpdateRuns';
import { buildRemoteMachineUpdateFacts } from '@/updates/remoteCliUpdateItems';
import { useThisComputerCliUpdate } from '@/updates/useThisComputerCliUpdate';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { countMachinePresence, isMachineOnline } from '@/utils/sessions/machineUtils';
import { formatLastSeen, formatOSPlatform } from '@/utils/sessions/sessionUtils';

import { CardGrid } from '@/components/ui/cardGrid/CardGrid';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import type { HubSectionProps } from './hubSectionProps';

/** Update states that ask the person to act (the Updates surface owns the action). */
const UPDATE_WAITING = new Set(['available', 'required']);

/**
 * Each machine of this Home as a card in Home's grid (lab `hindex-I3`): its glyph and presence
 * (online, or offline in grey — laptops sleep), its name, one fact line, the agents an earlier detect
 * found there while it is online, and an Update action only when one is waiting. The header counts
 * the machines online and offline. No machine is asked anything: the agents are the last cached
 * answer, so the section says when it was read ("As of 10:42").
 */
export const HubMachinesSection = React.memo(function HubMachinesSection(props: HubSectionProps) {
    const allMachines = useAllMachines();
    // A replaced identity (the same computer before a reinstall) is not a machine to show or count.
    const machines = React.useMemo(() => allMachines.filter((machine) => !isMachineReplaced(machine)), [allMachines]);
    const serverId = useActiveServerSnapshot().serverId;
    const thisComputer = useThisComputerCliUpdate();
    const runs = useMachineUpdateRuns(serverId);
    const machineIds = React.useMemo(() => machines.map((machine) => machine.id), [machines]);
    const snapshots = useMachinesCapabilitySnapshots(serverId, machineIds);
    const updatesById = React.useMemo(() => new Map(
        buildRemoteMachineUpdateFacts(machines, thisComputer.machineId, runs, snapshots)
            .filter((facts) => UPDATE_WAITING.has(facts.cliItem.state))
            .map((facts) => [facts.machine.id, facts.cliItem] as const),
    ), [machines, runs, snapshots, thisComputer.machineId]);
    const machineAgents = useMachineAgentsByMachine({ serverId, machineIds, load: false });

    const names = React.useMemo(() => resolveMachineDisplayNames(machines), [machines]);

    if (machines.length === 0) return null;

    const nowMs = Date.now();
    const cards = machines.map((machine) => {
        const online = isMachineOnline(machine, nowMs);
        const update = updatesById.get(machine.id) ?? null;
        // Agents are shown for a machine that can run them now; an offline machine's last answer is
        // not a readiness claim.
        const agents = online ? machineAgents.get(machine.id) ?? null : null;
        return { machine, online, update, agents, isThisComputer: machine.id === thisComputer.machineId };
    });
    const asOf = cards.reduce((newest, card) => Math.max(newest, card.agents?.lastCheckedAt ?? 0), 0);
    const counts = countMachinePresence(machines, nowMs);

    return (
        <ItemGroup
            title={t('settingsOverview.machinesTitle')}
            titleAccessory={<MachinePresenceCounts testID="hub-machines.presence" counts={counts} />}
            surface="none"
            action={asOf > 0 || props.menu ? (
                <View style={stylesheet.headerActions}>
                    {asOf > 0 ? <SurfaceAsOfLabel testID="hub-machines.asOf" at={asOf} /> : null}
                    {props.menu}
                </View>
            ) : undefined}
        >
            <CardGrid testID="hub-machines.grid">
                {cards.map((card) => (
                    <HubMachineCard
                        key={card.machine.id}
                        machine={card.machine}
                        serverId={serverId}
                        name={names.get(card.machine.id) ?? card.machine.id}
                        online={card.online}
                        isThisComputer={card.isThisComputer}
                        agents={card.agents?.agents ?? null}
                        hasUpdate={card.update !== null}
                    />
                ))}
            </CardGrid>
        </ItemGroup>
    );
});

/** "This computer · macOS", "Linux", "macOS · last seen 09:12": one fact line under the name. */
function describeMachineFact(machine: Machine, online: boolean, isThisComputer: boolean): string {
    const platform = formatOSPlatform(machine.metadata?.platform);
    const parts = [
        isThisComputer ? t('updates.sections.thisComputer') : null,
        platform || null,
        online ? null : t('settingsOverview.machineLastSeen', { lastSeen: formatLastSeen(machine.activeAt ?? 0) }),
    ];
    return parts.filter(Boolean).join(' · ');
}

const HubMachineCard = React.memo(function HubMachineCard(props: Readonly<{
    machine: Machine;
    serverId: string;
    name: string;
    online: boolean;
    isThisComputer: boolean;
    agents: readonly MachineAgent[] | null;
    hasUpdate: boolean;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { machine, online } = props;
    const agentIds = React.useMemo(() => props.agents?.filter((agent) => agent.installed).map((agent) => agent.agentId) ?? [], [props.agents]);
    const testID = `hub-machines.${machine.id}`;
    const status = online ? t('systemStatus.machine.online') : t('systemStatus.machine.offline');
    const openMachine = React.useCallback(() => {
        router.push(machineCollectionHref({ machineId: machine.id, serverId: props.serverId }) as never);
    }, [machine.id, props.serverId, router]);
    const openUpdates = React.useCallback(() => router.push(UPDATES_ROUTE as never), [router]);
    return (
        <View style={stylesheet.cardFrame}>
            <SurfaceCard testID={testID} padding="sm" fill onPress={openMachine}>
                <View style={stylesheet.card}>
                    <View style={stylesheet.cardTop}>
                        <Icon
                            name={props.isThisComputer ? 'laptop' : 'desktop'}
                            size={20}
                            color={online ? theme.colors.text.secondary : theme.colors.text.tertiary}
                        />
                        <View testID={`${testID}.status`} style={stylesheet.status} accessible accessibilityLabel={status}>
                            <StatusDot
                                testID={`${testID}.presence`}
                                size={6}
                                color={online ? theme.colors.status.connected : theme.colors.status.disconnected}
                            />
                            <Text style={stylesheet.statusText}>{status}</Text>
                        </View>
                    </View>
                    <Text style={[stylesheet.name, online ? null : stylesheet.nameOffline]} numberOfLines={1}>{props.name}</Text>
                    <Text style={stylesheet.fact} numberOfLines={1}>
                        {describeMachineFact(machine, online, props.isThisComputer)}
                    </Text>
                    <View style={stylesheet.footer}>
                        {agentIds.length > 0 ? (
                            <MachineCliLogoRow testID={`${testID}.agents`} agentIds={agentIds} />
                        ) : null}
                    </View>
                </View>
            </SurfaceCard>
            {/* The Update button is its own control over the card's footer, never a button inside a button. */}
            {props.hasUpdate ? (
                <View style={stylesheet.footerAction}>
                    <RoundButton
                        testID={`${testID}.update`}
                        size="small"
                        display="secondary"
                        title={t('settingsOverview.update')}
                        onPress={openUpdates}
                    />
                </View>
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    cardFrame: {
        flex: 1,
    },
    card: {
        flex: 1,
        minHeight: 108,
    },
    cardTop: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 10,
    },
    status: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    statusText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
    },
    name: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
        lineHeight: 19,
    },
    nameOffline: {
        color: theme.colors.text.secondary,
    },
    fact: {
        color: theme.colors.text.secondary,
        fontSize: 12.5,
        lineHeight: 17,
        marginTop: 2,
    },
    footer: {
        marginTop: 'auto',
        paddingTop: 10,
        minHeight: 38,
        flexDirection: 'row',
        alignItems: 'center',
    },
    footerAction: {
        position: 'absolute',
        right: SURFACE_CARD_PADDING_PX.sm.horizontal,
        bottom: SURFACE_CARD_PADDING_PX.sm.vertical,
    },
}));
