import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { AutomationEventTestResultV1Schema } from '@happier-dev/protocol/automations/automationEventTestV1';
import { type AutomationEventTestResultV1 } from '@happier-dev/protocol/automations/automationEventTestV1';
import type { AutomationRunPluginEventTriggerEvidenceV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import type { PluginEventAutomationSetupSeed } from '@/components/automations/editor/pluginEventAutomationSetup';

import { PluginEventAutomationEditor, type PluginEventEditorPresentation } from '@/components/automations/editor/PluginEventAutomationEditor';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import { Modal } from '@/modal';
import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import type { TriggerWhenValue } from './sessionTriggerForm';

const styles = StyleSheet.create((theme) => ({
    testResult: { color: theme.colors.text.primary },
    inFlowFoot: { alignItems: 'flex-start' },
}));

type EventWhen = Extract<TriggerWhenValue, { kind: 'pluginEvent' }>;

/**
 * An Event's setup is its own step wherever a trigger's rows stand, as on the Link sheet: it replaces the trigger's
 * rows, with one footer, and comes back on Done or Cancel. A popover that hosts the rows (the sentence's detail chip)
 * provides the step; without one, the trigger card holds it in flow.
 */
export type TriggerEventStep = Readonly<{
    editing: boolean;
    onEditingChange: (editing: boolean) => void;
    maxHeight?: number;
}>;

export const TriggerEventStepContext = React.createContext<TriggerEventStep | null>(null);

export function TriggerPluginEventRows(props: Readonly<{
    testID: string;
    when: EventWhen;
    onChange: (next: TriggerWhenValue) => void;
    machineId: string | null;
    serverId: string | null;
    eventTitle?: string;
    eventEdit?: Readonly<{ automationId: string; triggerId: string }>;
    activityEvent?: AutomationRunPluginEventTriggerEvidenceV1;
    editing?: boolean;
    onEditingChange?: (editing: boolean) => void;
    editorMaxHeight?: number;
    editorPresentation?: PluginEventEditorPresentation;
    initialEventSeed?: PluginEventAutomationSetupSeed;
    initialEventEditSeed?: PluginEventAutomationEditSeed;
    onEditSeedApplied?: React.ComponentProps<typeof PluginEventAutomationEditor>['onEditSeedApplied'];
    /**
     * The resting entry that opens the Event editor, drawn by a host that lays rows on its own label track
     * (the "When it runs" card); the editor, its seed read and its test stay here.
     */
    /** `configured`: the trigger has a saved source (its sealed setup is read only when opened), so it isn't "Set up". */
    renderEntry?: (entry: Readonly<{ detail: string | undefined; configured: boolean; onPress: () => void }>) => React.ReactNode;
}>) {
    const [inlineEditing, setInlineEditing] = React.useState(false);
    const editing = props.editing ?? inlineEditing;
    const setEditing = (next: boolean) => {
        setInlineEditing(next);
        props.onEditingChange?.(next);
    };
    const [seedRead, setSeedRead] = React.useState<Readonly<{ status: 'loading' | 'unavailable' | 'ready'; seed: PluginEventAutomationEditSeed | null;
        automationId?: string; triggerId?: string; lifetime?: ActiveServerAccountScopeLifetime }>>({ status: 'loading', seed: null });
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
        if (!needsSeed || props.initialEventEditSeed || !automationId || !triggerId) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        let alive = true;
        setSeedRead({ status: 'loading', seed: null, automationId, triggerId });
        void sync.getAutomationPluginEventEditSeed(automationId, triggerId).then((seed) => {
            if (alive && lifetime.isCurrent()) setSeedRead({ status: seed ? 'ready' : 'unavailable', seed, automationId, triggerId, lifetime });
        }).catch(() => {
            if (alive && lifetime.isCurrent()) setSeedRead({ status: 'unavailable', seed: null, automationId, triggerId, lifetime });
        });
        return () => { alive = false; };
    }, [automationId, triggerId, needsSeed, props.initialEventEditSeed, retry]);
    const configured = props.when.value !== null || props.eventEdit !== undefined;
    const matchingSeedRead = seedRead.automationId === automationId && seedRead.triggerId === triggerId
        && seedRead.lifetime?.isCurrent() === true ? seedRead : null;
    const sourceLabel = props.when.value?.displayLabel
        ?? (props.initialEventEditSeed ?? matchingSeedRead?.seed)?.source.displayLabel;
    const eventRef = props.when.value?.eventRef ?? props.when.eventRef;
    const readStatus = props.initialEventEditSeed ? 'ready'
        : matchingSeedRead?.status ?? 'loading';
    const renderSeedRead = () => {
        const read = <Item testID={`${props.testID}-event-read`}
            title={t(readStatus === 'loading' ? 'common.loading' : 'automations.form.trigger.sourceUnavailable')}
            onPress={readStatus === 'unavailable' ? () => setRetry((value) => value + 1) : undefined}
            detail={readStatus === 'unavailable' ? t('common.retry') : undefined} showChevron={false} />;
        const cancel = <RoundButton testID="automation-plugin-event-cancel" size="small" display="inverted"
            title={t('common.cancel')} onPress={() => setEditing(false)} />;
        return props.editorPresentation === 'inFlow' ? <>{read}<View style={styles.inFlowFoot}>{cancel}</View></>
            : <FloatingOverlay maxHeight={props.editorMaxHeight} surfaceChrome="theme" footer={cancel}>{read}</FloatingOverlay>;
    };
    return <>
        {editing ? needsSeed && readStatus !== 'ready' ? renderSeedRead() : <PluginEventAutomationEditor
                automationId={automationId ?? 'trigger-draft'} clientId={triggerId ?? 'event-draft'}
                value={props.when.value} seed={needsSeed ? props.initialEventEditSeed ?? matchingSeedRead?.seed ?? null : null} initialEventRef={eventRef ?? null}
                authoringMachineId={props.initialEventSeed?.monitoringMachineId ?? props.machineId} serverId={props.serverId}
                initialSetupSeed={props.initialEventSeed}
                onEditSeedApplied={props.onEditSeedApplied}
                observationOnly={props.when.observationOnly}
                maxHeight={props.editorMaxHeight}
                presentation={props.editorPresentation}
                onComplete={(value, intent) => { props.onChange({ kind: 'pluginEvent', value, ...intent }); setEditing(false); }}
                onCancel={() => setEditing(false)} /> : props.renderEntry ? props.renderEntry({
                    detail: sourceLabel ?? (configured ? t('automations.form.trigger.sourceConfigured') : undefined), configured,
                    onPress: () => setEditing(true) }) : <Item testID={`${props.testID}-configure-event`}
                title={t(props.when.value || props.eventEdit ? 'workflows.triggers.popover.editEvent' : 'workflows.triggers.popover.configureEvent')}
                subtitle={props.eventTitle}
                detail={sourceLabel} onPress={() => setEditing(true)} />}
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
            ? <Text testID={`${props.testID}-test-result`} accessibilityLiveRegion="polite" style={styles.testResult}>{t(`workflows.triggers.activity.${tested.result}`)}</Text> : null}
    </>;
}
