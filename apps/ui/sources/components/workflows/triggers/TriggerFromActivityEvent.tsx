import * as React from 'react';
import { View } from 'react-native';
import type { AutomationRunPluginEventTriggerEvidenceV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';

import { Item } from '@/components/ui/lists/Item';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { addWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import { t } from '@/text';
import { TriggerPopover } from './TriggerPopover';
import { TriggerRunsOnRow } from './TriggerRunsOnRow';
import { buildTriggerExecutionTarget } from './sessionTriggerForm';
import { useTriggerThenOptions } from './useTriggerThenOptions';

/** The direct Run-detail observation seeds intent, never a source credential or a new admission. */
export function TriggerFromActivityEvent(props: Readonly<{ evidence: AutomationRunPluginEventTriggerEvidenceV1 }>) {
    const scope = useActiveServerAccountScope();
    return <TriggerFromActivityEventContent key={scope ? serverAccountScopeKeySuffix(scope) : 'unscoped'} {...props} />;
}

function TriggerFromActivityEventContent(props: Readonly<{ evidence: AutomationRunPluginEventTriggerEvidenceV1 }>) {
    const anchorRef = React.useRef<View>(null);
    const [opened, setOpened] = React.useState<ReturnType<typeof captureActiveServerAccountScopeLifetime>>(null);
    return <>
        <View ref={anchorRef} collapsable={false}>
            <Item testID="automation-run-event-create-trigger" title={t('workflows.triggers.activity.create')}
                onPress={() => setOpened(captureActiveServerAccountScopeLifetime())} showChevron={false} />
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
    const thenOptions = useTriggerThenOptions();
    return <TriggerPopover testID="activity-event-trigger" anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose} whenKinds={['pluginEvent']} sessionId={null} initial={null}
            initialWhen={{ kind: 'pluginEvent', value: null, eventRef: props.evidence.eventRef }}
            activityEvent={props.evidence} workflowOptions={thenOptions.workflowOptions}
            machineId={project?.machineId ?? null} serverId={props.lifetime.scope.serverId} hostComplete={project !== null}
            setRows={<TriggerRunsOnRow testID="activity-event-trigger-runs-on" target={project} onChange={setProject}
                description={t('workflows.triggers.editor.runsOnAccountDescription')} />}
            onSubmit={async (value, write) => {
                if (!props.lifetime.isCurrent()) throw new Error('action_account_scope_changed');
                if (project === null || write.trigger === null || write.target === null) return;
                await addWorkflowTrigger({ trigger: write.trigger, target: write.target, project,
                    inputs: write.inputs, executionTarget: buildTriggerExecutionTarget(value.then) });
            }} />;
}
