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
import { buildTriggerExecutionTarget, type SessionLifecycleWhen } from './sessionTriggerForm';
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
        {opened === null ? null : <ActivityEventTriggerPopover source={{ kind: 'plugin', evidence: props.evidence }} lifetime={opened}
            anchorRef={anchorRef} onRequestClose={() => setOpened(null)} />}
    </>;
}

/**
 * A trigger from an observed event, written to a saved workflow through `workflow.trigger.add`: a retained plugin
 * Event from its Run detail, or an Events-tab Session start ("Add to a workflow…", which starts on Run a workflow).
 * The When is the event's; the person picks the workflow and where it runs.
 */
export function ActivityEventTriggerPopover(props: Readonly<{
    source: Readonly<{ kind: 'plugin'; evidence: AutomationRunPluginEventTriggerEvidenceV1 }>
        | Readonly<{ kind: 'when'; when: SessionLifecycleWhen }>;
    lifetime: ActiveServerAccountScopeLifetime;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    testID?: string;
    newTitle?: string;
}>) {
    const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(null);
    const thenOptions = useTriggerThenOptions({ accountLifetime: props.lifetime });
    const { source } = props;
    const testID = props.testID ?? 'activity-event-trigger';
    return <TriggerPopover testID={testID} anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose} sessionId={null} initial={null}
            {...(source.kind === 'plugin'
                ? { whenKinds: ['pluginEvent'] as const, activityEvent: source.evidence,
                    initialWhen: { kind: 'pluginEvent', value: null, eventRef: source.evidence.eventRef } as const }
                : { whenKinds: [source.when.kind], initialWhen: source.when, initialThenKind: 'runWorkflow' as const })}
            {...(props.newTitle === undefined ? {} : { newTitle: props.newTitle })}
            workflowOptions={thenOptions.workflowOptions}
            accountLifetime={props.lifetime}
            machineId={project?.machineId ?? null} serverId={props.lifetime.scope.serverId} hostComplete={project !== null}
            setRows={<TriggerRunsOnRow testID={`${testID}-runs-on`} target={project} onChange={setProject} accountLifetime={props.lifetime}
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
