import * as React from 'react';
import { View } from 'react-native';

import type { MachineAgent, MachineAgentSignInSession } from '@/agents/machineAgents/machineAgentTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { splitMachineAgents, type MachineAgentRowAction } from './machineAgentPresentation';
import { MachineAgentRow } from './MachineAgentRow';

/** The "Add an agent" list shows this many before "Show all" (lab M1: five, then 14 more). */
const ADD_LIST_PREVIEW = 5;

export type MachineAgentsSectionViewProps = Readonly<{
    agents: readonly MachineAgent[];
    status: 'loading' | 'ready' | 'offline' | 'error';
    lastCheckedAt: number | null;
    machineName: string;
    renderMark: (agent: MachineAgent) => React.ReactNode;
    sessionFor: (agent: MachineAgent) => MachineAgentSignInSession | null;
    renderForm: (agent: MachineAgent) => React.ReactNode;
    expandedAgentIds: ReadonlySet<string>;
    onExpandedChange: (agentId: string, expanded: boolean) => void;
    onAction: (agent: MachineAgent, action: MachineAgentRowAction) => void;
    onCheckAgain: () => void;
    testID: string;
}>;


/**
 * The machine's Agents (lab M1): one row per installed agent — its state in one line and one action —
 * then "Add an agent" with what isn't installed but runs on this machine. Any row opens in place into the
 * setup form (M2). An offline machine shows what it last reported, without actions.
 */
export const MachineAgentsSectionView = React.memo(function MachineAgentsSectionView(props: MachineAgentsSectionViewProps) {
    const { installed, available } = splitMachineAgents(props.agents);
    const [showAll, setShowAll] = React.useState(false);
    const shownAvailable = showAll ? available : available.slice(0, ADD_LIST_PREVIEW);
    const row = (agent: MachineAgent, index: number, list: readonly MachineAgent[]) => (
        <MachineAgentRow
            key={agent.agentId}
            testID={`${props.testID}.${agent.agentId}`}
            agent={agent}
            mark={props.renderMark(agent)}
            session={props.sessionFor(agent)}
            onAction={(action) => props.onAction(agent, action)}
            form={agent.stale ? undefined : props.renderForm(agent)}
            expanded={props.expandedAgentIds.has(agent.agentId)}
            onExpandedChange={(expanded) => props.onExpandedChange(agent.agentId, expanded)}
            showDivider={index < list.length - 1}
        />
    );
    const firstLoad = props.status === 'loading' && props.agents.length === 0;
    return (
        <View testID={props.testID}>
            <ItemGroup
                title={t('machineAgents.sectionTitle')}
                description={t('machineAgents.sectionDescription')}
                action={props.status === 'offline' || (props.status === 'error' && props.agents.length === 0) ? undefined : (
                    <RoundButton
                        testID={`${props.testID}.checkAgain`}
                        size="small"
                        display="inverted"
                        title={t('machineAgents.checkAgain')}
                        loading={props.status === 'loading' && props.agents.length > 0}
                        onPress={props.onCheckAgain}
                    />
                )}
            >
                {props.status === 'offline' ? (
                    <SurfaceFreshnessLine
                        testID={`${props.testID}.offline`}
                        asOf={props.lastCheckedAt}
                        reason={t('machineAgents.offlineNote', { machine: props.machineName })}
                    />
                ) : null}
                {firstLoad ? (
                    <SurfaceStateCard testID={`${props.testID}.loading`} size="line" kind="loading" title={t('machineAgents.checking')} />
                ) : props.status === 'error' && props.agents.length === 0 ? (
                    <SurfaceStateCard
                        testID={`${props.testID}.error`}
                        size="line"
                        kind="error"
                        title={t('machineAgents.unknown')}
                        action={{ label: t('machineAgents.checkAgain'), onPress: props.onCheckAgain }}
                    />
                ) : installed.length === 0 ? (
                    <SurfaceStateCard testID={`${props.testID}.empty`} size="line" kind="empty" title={t('machineAgents.emptyInstalled')} />
                ) : installed.map(row)}
            </ItemGroup>
            {available.length > 0 && props.status !== 'offline' ? (
                <ItemGroup
                    title={t('machineAgents.addTitle')}
                    description={t('machineAgents.addMore', { count: available.length })}
                    action={available.length > ADD_LIST_PREVIEW ? (
                        <RoundButton
                            testID={`${props.testID}.showAll`}
                            size="small"
                            display="inverted"
                            title={showAll ? t('machineAgents.showFewer') : t('machineAgents.showAll')}
                            onPress={() => setShowAll((value) => !value)}
                        />
                    ) : undefined}
                >
                    {shownAvailable.map(row)}
                </ItemGroup>
            ) : null}
        </View>
    );
});
