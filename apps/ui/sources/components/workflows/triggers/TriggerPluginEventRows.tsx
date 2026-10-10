import * as React from 'react';
import { AutomationEventTestResultV1Schema, type AutomationEventTestResultV1 } from '@happier-dev/protocol';
import type { AutomationRunPluginEventTriggerEvidenceV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';

import { PluginEventAutomationEditor } from '@/components/automations/editor/PluginEventAutomationEditor';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import { Modal } from '@/modal';
import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import type { TriggerWhenValue } from './sessionTriggerForm';

type EventWhen = Extract<TriggerWhenValue, { kind: 'pluginEvent' }>;

export function TriggerPluginEventRows(props: Readonly<{
    testID: string;
    when: EventWhen;
    onChange: (next: TriggerWhenValue) => void;
    machineId: string | null;
    serverId: string | null;
    eventEdit?: Readonly<{ automationId: string; triggerId: string }>;
    activityEvent?: AutomationRunPluginEventTriggerEvidenceV1;
    editing?: boolean;
    onEditingChange?: (editing: boolean) => void;
    editorMaxHeight?: number;
}>) {
    const [inlineEditing, setInlineEditing] = React.useState(false);
    const editing = props.editing ?? inlineEditing;
    const setEditing = (next: boolean) => {
        setInlineEditing(next);
        props.onEditingChange?.(next);
    };
    const [seedRead, setSeedRead] = React.useState<Readonly<{ status: 'loading' | 'unavailable' | 'ready'; seed: PluginEventAutomationEditSeed | null;
        automationId?: string; triggerId?: string }>>({ status: 'loading', seed: null });
    const [retry, setRetry] = React.useState(0);
    const [tested, setTested] = React.useState<Readonly<{ when: EventWhen; evidence: AutomationRunPluginEventTriggerEvidenceV1;
        result: AutomationEventTestResultV1['result'] }> | null>(null);
    const [testing, setTesting] = React.useState(false);
    const current = React.useRef({ when: props.when, evidence: props.activityEvent, editing });
    current.current = { when: props.when, evidence: props.activityEvent, editing };
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const automationId = props.eventEdit?.automationId;
    const triggerId = props.eventEdit?.triggerId;
    const needsSeed = editing && props.when.value === null && automationId !== undefined && triggerId !== undefined;
    React.useEffect(() => {
        if (!needsSeed || !automationId || !triggerId) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        let alive = true;
        setSeedRead({ status: 'loading', seed: null, automationId, triggerId });
        void sync.getAutomationPluginEventEditSeed(automationId, triggerId).then((seed) => {
            if (alive && lifetime?.isCurrent()) setSeedRead({ status: seed ? 'ready' : 'unavailable', seed, automationId, triggerId });
        }).catch(() => {
            if (alive && lifetime?.isCurrent()) setSeedRead({ status: 'unavailable', seed: null, automationId, triggerId });
        });
        return () => { alive = false; };
    }, [automationId, triggerId, needsSeed, retry]);
    const eventRef = props.when.value?.eventRef ?? props.when.eventRef;
    const readStatus = seedRead.automationId === automationId && seedRead.triggerId === triggerId ? seedRead.status : 'loading';
    return <>
        {editing ? needsSeed && readStatus !== 'ready' ? <FloatingOverlay maxHeight={props.editorMaxHeight}
            surfaceChrome="theme" footer={<RoundButton testID="automation-plugin-event-cancel" size="small" display="inverted"
                title={t('common.cancel')} onPress={() => setEditing(false)} />}><Item
            testID={`${props.testID}-event-read`} title={t(readStatus === 'loading' ? 'common.loading' : 'automations.form.trigger.sourceUnavailable')}
            onPress={readStatus === 'unavailable' ? () => setRetry((value) => value + 1) : undefined}
            detail={readStatus === 'unavailable' ? t('common.retry') : undefined} showChevron={false} /></FloatingOverlay> : <PluginEventAutomationEditor
                automationId={automationId ?? 'trigger-draft'} clientId={triggerId ?? 'event-draft'}
                value={props.when.value} seed={needsSeed ? seedRead.seed : null} initialEventRef={eventRef ?? null}
                authoringMachineId={props.machineId} serverId={props.serverId}
                maxHeight={props.editorMaxHeight}
                onComplete={(value) => { props.onChange({ kind: 'pluginEvent', value }); setEditing(false); }}
                onCancel={() => setEditing(false)} /> : <Item testID={`${props.testID}-configure-event`}
                title={t(props.when.value || props.eventEdit ? 'workflows.triggers.popover.editEvent' : 'workflows.triggers.popover.configureEvent')}
                subtitle={eventRef ? <Text style={Typography.mono()}>{`${eventRef.pluginId}/${eventRef.localId}`}</Text> : undefined}
                detail={props.when.value?.displayLabel} onPress={() => setEditing(true)} />}
        {props.activityEvent ? <Item testID={`${props.testID}-test`} title={t('workflows.triggers.activity.test')}
            disabled={props.when.value === null || editing || testing} loading={testing} showChevron={false}
            onPress={() => {
                if (!props.activityEvent || editing || testing) return;
                const when = props.when;
                const value = props.when.value;
                const evidence = props.activityEvent;
                const lifetime = captureActiveServerAccountScopeLifetime();
                const isCurrent = () => mounted.current && lifetime?.isCurrent() === true
                    && current.current.when === when && current.current.evidence === evidence && !current.current.editing;
                setTesting(true);
                setTested(null);
                // Supply diagnostic facts only, not retained occurrence custody or admission evidence.
                void callWorkflowAction({ actionId: 'workflow.trigger.test', accountLifetime: lifetime,
                    ...(props.serverId ? { context: { serverId: props.serverId } } : {}),
                    parseResult: (result) => AutomationEventTestResultV1Schema.parse(result), input: {
                    trigger: value ? { eventRef: value.eventRef, sourceInstanceId: value.sourceInstanceId,
                        sourceContractVersion: value.sourceContractVersion, filter: value.filter,
                        maximumObservationAgeMs: value.maximumObservationAgeMs } : null,
                    observation: { eventRef: evidence.eventRef, sourceInstanceId: evidence.sourceInstanceId,
                        sourceContractVersion: evidence.sourceContractVersion, occurredAt: evidence.occurredAt,
                        observationReceivedAt: evidence.observationReceivedAt, payload: evidence.payload },
                } }).then(({ result }) => {
                    if (isCurrent()) setTested({ when, evidence, result });
                }).catch((error: unknown) => {
                    if (isCurrent()) void Modal.alert(t('common.error'), formatWorkflowProblemMessage(error));
                }).finally(() => {
                    if (mounted.current) setTesting(false);
                });
            }} /> : null}
        {tested?.when === props.when && tested.evidence === props.activityEvent
            ? <Text testID={`${props.testID}-test-result`} accessibilityLiveRegion="polite">{t(`workflows.triggers.activity.${tested.result}`)}</Text> : null}
    </>;
}
