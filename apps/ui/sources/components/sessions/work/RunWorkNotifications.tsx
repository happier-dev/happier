import * as React from 'react';
import { View } from 'react-native';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { AutomationRunLifecycleSource } from '@happier-dev/protocol/automations/automationRunLifecycle';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { WorkflowTriggerAddRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { buildTriggerTarget, readTriggerThen } from '@/components/workflows/triggers/sessionTriggerForm';
import type { WorkflowActionExecute } from '@/sync/domains/workflows/callWorkflowAction';
import { addWorkflowTrigger, listWorkflowTriggerSets, removeWorkflowTrigger, type WorkflowTriggerWriteResult } from '@/sync/domains/workflows/workflowTriggerActions';
import { getStorage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createWorkflowTriggerChangeSelector, createWorkflowTriggerSetSelector } from '@/sync/store/domains/automations';
import { t } from '@/text';
import { WorkNotificationOperation } from './WorkNotificationOperation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';

export type RunTriggersRead = Readonly<{
    status: 'loading' | 'ready' | 'failed';
    sets: readonly WorkflowTriggerSetV1[];
    add: (input: WorkflowTriggerAddRequestV1) => Promise<WorkflowTriggerWriteResult>;
    remove: (automationId: string, triggerId: string) => Promise<WorkflowTriggerWriteResult>;
}>;

export function RunWorkNotifyOperation(props: Readonly<{
    source: AutomationRunLifecycleSource;
    project: WorkflowProjectTargetV1;
    read: RunTriggersRead;
    execute?: WorkflowActionExecute;
}>) {
    const conditions = props.source.kind === 'workflow_run' ? ['terminal', 'needs_attention'] as const : ['terminal'] as const;
    // The two offers sit side by side and wrap when the pane is narrow, so they never stack as two
    // full-width rows above what the run actually needs.
    return <View style={{ minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8 }}>
        {conditions.map((condition) => {
            const message = condition === 'terminal' ? t('sessionWork.notify.runFinished') : t('sessionWork.notify.runNeedsYou');
            const match = (set: WorkflowTriggerSetV1) => {
                const then = set.target ? readTriggerThen(set.target) : null;
                if (!set.enabled || set.health !== 'available' || then?.kind !== 'notifyMe' || then.message !== message) return null;
                return set.triggers.find((trigger) => trigger.kind === 'runLifecycle' && trigger.enabled
                    && trigger.status.state === 'waiting' && trigger.remainingOccurrences !== 0
                    && trigger.condition === condition && sameStrictJsonValue(trigger.source, props.source))?.id ?? null;
            };
            const add = async () => {
                const target = buildTriggerTarget({ kind: 'notifyMe', message, title: '', channels: [] }, 'account');
                if (!target) throw new Error('Invalid notification target');
                return props.read.add({ project: props.project, target,
                    trigger: { kind: 'runLifecycle', source: props.source, condition, enabled: true } });
            };
            return <WorkNotificationOperation key={condition} sourceId={props.source.runId} testIDPrefix={`notify-run-${condition}`}
                title={condition === 'terminal' ? t('sessionWork.notify.run') : t('sessionWork.notify.attention')}
                sets={props.read.sets} ready={props.read.status === 'ready'} machineId={props.project.machineId}
                match={match} add={add} remove={(triggerId, automationId) => props.read.remove(automationId, triggerId)} execute={props.execute} />;
        })}
    </View>;
}

/** Run sources and writes are views of the existing Account-inline Automation projection. */
export function RunWorkNotifications(props: Readonly<{
    source: AutomationRunLifecycleSource;
    project: WorkflowProjectTargetV1;
    serverId?: string | null;
}>) {
    const scope = useActiveServerAccountScope();
    if (!scope || (props.serverId && !areServerProfileIdentifiersEquivalent(props.serverId, scope.serverId))) return null;
    return <RunWorkNotificationsForAccount key={`${scope.serverId}:${scope.accountId}:${props.source.kind}:${props.source.runId}`} {...props} />;
}

function RunWorkNotificationsForAccount(props: Readonly<{ source: AutomationRunLifecycleSource; project: WorkflowProjectTargetV1 }>) {
    const selector = React.useMemo(() => createWorkflowTriggerSetSelector('account_inline'), []);
    const sets = getStorage()(selector);
    const changeSelector = React.useMemo(() => createWorkflowTriggerChangeSelector(null), []);
    const changeSignal = getStorage()(changeSelector);
    const [status, setStatus] = React.useState<RunTriggersRead['status']>('loading');
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        const controller = new AbortController();
        void listWorkflowTriggerSets({ scope: 'account_inline' }, { signal: controller.signal })
            .then(() => { if (!controller.signal.aborted) setStatus('ready'); })
            .catch(() => { if (!controller.signal.aborted) setStatus('failed'); });
        return () => controller.abort();
    }, [attempt, changeSignal]);
    return <>
        <RunWorkNotifyOperation source={props.source} project={props.project} read={{ status, sets,
            add: (input) => addWorkflowTrigger(input), remove: (automationId, triggerId) => removeWorkflowTrigger({ automationId, triggerId }) }} />
        {status === 'failed' ? <RoundButton display="inverted" size="small" style={{ minHeight: 44 }}
            title={t('common.retry')} onPress={() => setAttempt((value) => value + 1)} /> : null}
    </>;
}
