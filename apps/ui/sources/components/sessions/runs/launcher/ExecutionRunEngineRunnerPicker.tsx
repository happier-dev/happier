import * as React from 'react';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { ExecutionRunAgentModelPicker } from './ExecutionRunAgentModelPicker';
import { selectReviewLauncherRunner } from './executionRunChildChoice';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';

/** Engine rows delegate model/account authoring to the same picker as ordinary Agent rows. */
export function ExecutionRunEngineRunnerPicker(props: Readonly<{
    engine: ExecutionRunLauncherBackendChoice;
    sessionId: string | null;
    serverId: string | null;
    machineId: string | null;
    actionInput: Record<string, unknown>;
    selected: React.ComponentProps<typeof ExecutionRunAgentModelPicker>['selected'];
    setActionInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
    onAddMember?: () => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const runners = props.engine.reviewRunnerChoices ?? [];
    const target = AgentExecutionTargetV1Schema.safeParse(props.actionInput.runnerAgentTarget);
    const selectedKey = target.success ? buildBackendTargetKeyV2(target.data) : null;
    const selected = runners.find(runner => runner.choice.targetKey === selectedKey);
    return <>
        <DropdownMenu open={open} onOpenChange={setOpen} selectedId={selectedKey}
            // One runner per engine row: the singular Agent label, and each runner with its mark as in the Who list.
            itemTrigger={{ title: t('newSession.wizardSection.agent') }}
            items={runners.map(({ choice }) => ({ id: choice.targetKey, title: choice.title, disabled: choice.disabled,
                icon: <SessionAgentCatalogIdentityIcon agentId={choice.agentId} machineId={props.machineId}
                    serverId={props.serverId} size={ICON_SIZE.md} />,
                subtitle: choice.unavailableReason, testID: `review-runner:${choice.targetKey}` }))}
            onSelect={key => {
                const runner = runners.find(candidate => candidate.choice.targetKey === key);
                if (!runner) return;
                props.setActionInput(previous => selectReviewLauncherRunner(previous, runner.agentTarget));
            }} />
        {selected ? <ExecutionRunAgentModelPicker choice={selected.choice} providerProtocols={selected.providerProtocols}
            connectedAccountPurposes={selected.connectedAccountPurposes} sessionId={props.sessionId}
            serverId={props.serverId} machineId={props.machineId} actionInput={props.actionInput}
            selected={props.selected} inheritedTeamCredentialModel={null} selectBackend={() => undefined}
            setActionInput={props.setActionInput} /> : null}
        {/* The same add row as Add a step and Add an agent: a plus mark and a noun. */}
        {props.onAddMember ? <Item title={t('reviewWalkthrough.start.addPanelMember')} testID="review-runner-add-member"
            icon={<Icon name="plus" size={ICON_SIZE.sm} />}
            onPress={props.onAddMember} showChevron={false} /> : null}
    </>;
}
