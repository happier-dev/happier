import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { callWorkflowAction, type WorkflowActionExecute } from '@/sync/domains/workflows/callWorkflowAction';
import type { WorkflowTriggerWriteResult } from '@/sync/domains/workflows/workflowTriggerActions';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    operation: { minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
    button: { minHeight: 44, flexShrink: 1 },
    status: { color: theme.colors.text.secondary, fontSize: 14 },
    error: { color: theme.colors.state.danger.foreground, fontSize: 14 },
}));

/** One quiet presentation of the canonical trigger owner, shared by Session and Run details. */
export function WorkNotificationOperation(props: Readonly<{
    sourceId: string;
    testIDPrefix: string;
    title: string;
    sets: readonly WorkflowTriggerSetV1[];
    ready: boolean;
    machineId: string | null;
    match: (set: WorkflowTriggerSetV1) => string | null;
    add: () => Promise<WorkflowTriggerWriteResult>;
    remove: (triggerId: string, automationId: string) => Promise<WorkflowTriggerWriteResult>;
    execute?: WorkflowActionExecute;
}>) {
    const [acknowledged, setAcknowledged] = React.useState<WorkflowTriggerSetV1 | null>(null);
    const [error, setError] = React.useState(false);
    const [needsSetup, setNeedsSetup] = React.useState(false);
    const router = useRouter();
    React.useEffect(() => { setAcknowledged(null); }, [props.sets]);
    const sets = acknowledged ? [acknowledged, ...props.sets.filter((set) => set.automationId !== acknowledged.automationId)] : props.sets;
    const registered = sets.flatMap((set) => {
        const triggerId = props.match(set);
        return triggerId ? [{ triggerId, automationId: set.automationId }] : [];
    })[0];
    const id = (suffix: string) => `${props.testIDPrefix}${suffix}:${props.sourceId}`;
    const register = async () => {
        setError(false);
        try {
            // Resolve on intent, never per-row mount. Only the existing delivery
            // owner decides whether push, webhook or plugin channels are configured.
            const configured = await callWorkflowAction({
                actionId: 'action.options.resolve',
                // Notify me is a workflow/agent Action, not a direct UI send.
                // Its declared options source remains available to the trigger UI.
                input: { optionsSourceId: 'notifications.channels.available' },
                context: props.machineId ? { externalActionTarget: { kind: 'machine', machineId: props.machineId } } : undefined,
                execute: props.execute,
                parseResult: (value) => {
                    const schema = getActionSpec('action.options.resolve').outputSchema;
                    if (!schema) throw new Error('Missing channel options schema');
                    const result: unknown = schema.parse(value);
                    if (!result || typeof result !== 'object' || !('options' in result) || !Array.isArray(result.options)) {
                        throw new Error('Invalid channel options');
                    }
                    return result.options.some((option: unknown) => option !== null && typeof option === 'object'
                        && 'value' in option && typeof option.value === 'string'
                        && (!('disabled' in option) || option.disabled !== true));
                },
            });
            setNeedsSetup(!configured);
            if (!configured) return;
            setAcknowledged((await props.add()).set);
        } catch { setError(true); }
    };
    const cancel = async () => {
        if (!registered) return;
        setError(false);
        try { setAcknowledged((await props.remove(registered.triggerId, registered.automationId)).set); }
        catch { setError(true); }
    };
    return <View>
        <View style={stylesheet.operation}>
            {registered ? <>
                <Text testID={id('-armed')} accessibilityLiveRegion="polite" style={stylesheet.status}>{t('sessionWork.notify.armed')}</Text>
                <RoundButton testID={id('-cancel')} style={stylesheet.button} display="inverted" size="small"
                    title={t('common.cancel')} accessibilityLabel={t('sessionWork.notify.cancel')} action={cancel} />
            </> : needsSetup ? <RoundButton testID={id('-setup')} style={stylesheet.button} display="inverted" size="small"
                title={t('sessionWork.notify.setup')} titleNumberOfLines="complete" onPress={() => {
                    setNeedsSetup(false);
                    router.push('/settings/notifications');
                }} /> : <RoundButton testID={id('')} style={stylesheet.button} display="inverted" size="small"
                title={props.title} titleNumberOfLines="complete" disabled={!props.ready} action={register} />}
        </View>
        {error ? <Text testID={id('-error')} accessibilityLiveRegion="polite" style={stylesheet.error}>{t('sessionWork.notify.failed')}</Text> : null}
    </View>;
}
