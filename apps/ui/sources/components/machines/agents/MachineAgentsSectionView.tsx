import * as React from 'react';
import { View } from 'react-native';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';

import type { MachineAgent, MachineAgentSignInSession } from '@/agents/machineAgents/machineAgentTypes';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { resolveMachineAgentStatus, splitMachineAgents, type MachineAgentRowAction } from './machineAgentPresentation';
import { formatMachineAgentStatus } from './machineAgentCopy';
import { MachineAgentRow } from './MachineAgentRow';

/** The "Add an agent" list shows this many before "Show all" (lab M1: five, then 14 more). */
const ADD_LIST_PREVIEW = 5;

export type MachineAgentsSectionViewProps = Readonly<{
    agents: readonly MachineAgent[];
    status: MachineAgentsSnapshot['status'];
    lastCheckedAt: number | null;
    failure?: MachineAgentsSnapshot['failure'];
    machineName: string;
    renderMark: (agent: MachineAgent) => React.ReactNode;
    sessionFor: (agent: MachineAgent) => MachineAgentSignInSession | null;
    renderForm: (agent: MachineAgent) => React.ReactNode;
    expandedAgentIds: ReadonlySet<string>;
    onExpandedChange: (agentId: string, expanded: boolean) => void;
    onAction: (agent: MachineAgent, action: MachineAgentRowAction) => void;
    onCheckAgain: () => void;
    /** A page whose own header already says "Agents" hosts the section without repeating its title. Default: titled. */
    titled?: boolean;
    testID: string;
}>;


/**
 * The machine's Agents (lab M1): one row per installed agent — its state in one line and one action —
 * then "Add an agent" with what isn't installed but runs on this machine. Any row opens in place into the
 * setup form (M2). An offline machine shows what it last reported, without row actions, and keeps the section's
 * one Check again: an inventory that could not be read is recoverable from where it is said.
 */
export const MachineAgentsSectionView = React.memo(function MachineAgentsSectionView(props: MachineAgentsSectionViewProps) {
    const { installed, available: listed, anyInstalled } = splitMachineAgents(
        props.agents, (agent) => props.expandedAgentIds.has(buildMachineAgentInventoryKey(agent)));
    // Only a finished check makes an agent one "to add"; a row still checking (or unreadable) may turn out installed
    // and would jump groups when its answer lands.
    const available = listed.filter((agent) => agent.state !== 'checking' && agent.state !== 'unknown');
    const [showAll, setShowAll] = React.useState(false);
    const shownAvailable = showAll ? available : available.slice(0, ADD_LIST_PREVIEW);
    const row = (agent: MachineAgent, index: number, list: readonly MachineAgent[]) => (
        <MachineAgentRow
            key={buildMachineAgentInventoryKey(agent)}
            testID={`${props.testID}.${buildMachineAgentInventoryKey(agent)}`}
            agent={agent}
            mark={props.renderMark(agent)}
            session={props.sessionFor(agent)}
            onAction={(action) => props.onAction(agent, action)}
            form={agent.stale ? undefined : props.renderForm(agent)}
            expanded={props.expandedAgentIds.has(buildMachineAgentInventoryKey(agent))}
            onExpandedChange={(expanded) => props.onExpandedChange(buildMachineAgentInventoryKey(agent), expanded)}
            showDivider={index < list.length - 1}
        />
    );
    // "No agent here" is a claim about a finished check. Descriptor-only rows (still checking, or the machine could not
    // answer) say nothing about installation, so they keep the section on its checking / unavailable lines.
    const unresolved = !anyInstalled && (
        (props.status === 'offline' && props.lastCheckedAt === null)
        || props.agents.some((agent) => agent.state === 'checking' || agent.state === 'unknown')
    );
    const checking = (props.status === 'loading' && props.agents.length === 0) || (unresolved && props.status === 'loading');
    // A check that is not running and has no answer (an error, or a machine that never answered) is said with its retry.
    const unreadable = !anyInstalled && (props.status === 'error' || (unresolved && (props.status === 'ready' || props.status === 'idle')));
    // An offline machine that never reported its agents has nothing retained: it says so with its Check again,
    // never a "this is what it last reported" line over an empty body.
    const offlineCold = props.status === 'offline' && unresolved;
    return (
        <View testID={props.testID}>
            <ItemGroup
                title={props.titled === false ? undefined : t('machineAgents.sectionTitle')}
                description={t('machineAgents.sectionDescription')}
                action={unreadable || checking || offlineCold ? undefined : (
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
                {offlineCold ? (
                    <SurfaceStateCard
                        testID={`${props.testID}.offline`}
                        size="line"
                        kind="unavailable"
                        title={t('machineAgents.offlineUnknown')}
                        action={{ label: t('machineAgents.checkAgain'), onPress: props.onCheckAgain }}
                    />
                ) : props.status === 'offline' ? (
                    <SurfaceFreshnessLine
                        testID={`${props.testID}.offline`}
                        asOf={props.lastCheckedAt}
                        reason={t('machineAgents.offlineNote', { machine: props.machineName })}
                    />
                ) : null}
                {checking ? (
                    <SurfaceStateCard testID={`${props.testID}.loading`} size="line" kind="loading" title={t('machineAgents.checking')} />
                ) : unreadable ? (
                    <SurfaceStateCard
                        testID={`${props.testID}.error`}
                        size="line"
                        kind={props.status === 'error' ? 'error' : 'unavailable'}
                        title={formatMachineAgentStatus(resolveMachineAgentStatus(null, undefined, props.status, props.failure))}
                        action={{ label: t('machineAgents.checkAgain'), onPress: props.onCheckAgain }}
                    />
                ) : unresolved ? null : !anyInstalled ? (
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
