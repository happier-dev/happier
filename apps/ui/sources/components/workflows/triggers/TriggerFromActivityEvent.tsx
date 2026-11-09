import * as React from 'react';
import { View } from 'react-native';
import type { AutomationRunPluginEventTriggerEvidenceV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';

import { Item } from '@/components/ui/lists/Item';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { addWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import { t } from '@/text';
import { TriggerPopover } from './TriggerPopover';
import { TriggerRunsOnRow } from './TriggerRunsOnRow';
import { buildTriggerExecutionTarget } from './sessionTriggerForm';
import { useTriggerThenOptions } from './useTriggerThenOptions';
import { WorkflowAccountLifetimeProvider } from '../workflowAccountScope';

/** The direct Run-detail observation seeds intent, never a source credential or a new admission. */
export function TriggerFromActivityEvent(props: Readonly<{ evidence: AutomationRunPluginEventTriggerEvidenceV1; accountLifetime?: ServerAccountScopeLifetime | null }>) {
    const activeScope = useActiveServerAccountScope();
    const scope = props.accountLifetime === undefined ? activeScope : props.accountLifetime?.scope;
    return <WorkflowAccountLifetimeProvider value={props.accountLifetime}>
        <TriggerFromActivityEventContent key={scope ? serverAccountScopeKeySuffix(scope) : 'unscoped'} {...props} /></WorkflowAccountLifetimeProvider>;
}

function TriggerFromActivityEventContent(props: Readonly<{ evidence: AutomationRunPluginEventTriggerEvidenceV1; accountLifetime?: ServerAccountScopeLifetime | null }>) {
    const anchorRef = React.useRef<View>(null);
    const [opened, setOpened] = React.useState<ReturnType<typeof captureActiveServerAccountScopeLifetime>>(null);
    return <>
        <View ref={anchorRef} collapsable={false}>
            <Item testID="automation-run-event-create-trigger" title={t('workflows.triggers.activity.create')}
                onPress={() => setOpened(props.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : props.accountLifetime)} showChevron={false} />
        </View>
        {opened === null ? null : <ActivityEventTriggerPopover evidence={props.evidence} lifetime={opened}
            anchorRef={anchorRef} onRequestClose={() => setOpened(null)} />}
    </>;
}

function ActivityEventTriggerPopover(props: Readonly<{
    evidence: AutomationRunPluginEventTriggerEvidenceV1;
    lifetime: ActiveServerAccountScopeLifetime;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
}>) {
    const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(null);
    const thenOptions = useTriggerThenOptions({ accountLifetime: props.lifetime });
    return <TriggerPopover testID="activity-event-trigger" anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose} whenKinds={['pluginEvent']} sessionId={null} initial={null}
            initialWhen={{ kind: 'pluginEvent', value: null, eventRef: props.evidence.eventRef }}
            activityEvent={props.evidence} workflowOptions={thenOptions.workflowOptions}
            accountLifetime={props.lifetime}
            machineId={project?.machineId ?? null} serverId={props.lifetime.scope.serverId} hostComplete={project !== null}
            setRows={<TriggerRunsOnRow testID="activity-event-trigger-runs-on" target={project} onChange={setProject} accountLifetime={props.lifetime}
                description={t('workflows.triggers.editor.runsOnAccountDescription')} />}
            onSubmit={async (value, write) => {
                if (!props.lifetime.isCurrent()) throw new Error('action_account_scope_changed');
                if (write.observationOnly && write.trigger !== null) {
                    await addWorkflowTrigger({ trigger: write.trigger, observationOnly: write.observationOnly }, { accountLifetime: props.lifetime });
                    return;
                }
                if (project === null || write.trigger === null || write.target === null) return;
                await addWorkflowTrigger({ trigger: write.trigger, target: write.target, project,
                    inputs: write.inputs, executionTarget: buildTriggerExecutionTarget(value.then) }, { accountLifetime: props.lifetime });
            }} />;
}
