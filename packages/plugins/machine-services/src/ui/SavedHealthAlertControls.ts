import { createElement as h, useState, type ReactElement } from 'react';
import type { HealthCheckSetupInputV1, HealthCheckSetupPreviewResultV1 } from '@happier-dev/plugin-sdk';
import { NOTIFICATION_NOTIFY_ME_ACTION_ID, SAVED_HEALTH_ALERT_TEST_ACTION_ID,
    SavedHealthAlertTestResultSchema } from '@happier-dev/plugin-sdk/actions';
import { Action, Button, Field, SelectionTiles, Stack, Text, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';

type AlertPhaseChoice = 'both' | 'open' | 'recovered';

/** Saved subject choices stay visible while another check is being added. */
export function SavedHealthAlertControls(props: Readonly<{
    alerts: HealthCheckSetupInputV1['alerts'];
    testContext?: HealthCheckSetupPreviewResultV1['testContext'];
    destinationSelectionContext?: HealthCheckSetupPreviewResultV1['destinationSelectionContext'];
    onChange: (alerts: NonNullable<HealthCheckSetupInputV1['alerts']>) => void;
}>): ReactElement {
    const t = usePluginTranslation();
    const host = usePluginHostApi();
    const [selecting, setSelecting] = useState(false);
    const [selectionUnavailable, setSelectionUnavailable] = useState(false);
    const [testResult, setTestResult] = useState<Readonly<{
        channel: NonNullable<HealthCheckSetupInputV1['alerts']>['channels'][number]; message: string;
    }> | null>(null);
    // Preparation supplies this context only for the actual unchanged saved source.
    const [prepared, setPrepared] = useState(() => ({ context: props.testContext, alerts: props.alerts }));
    if (prepared.context !== props.testContext) setPrepared({ context: props.testContext, alerts: props.alerts });
    const preparedAlerts = prepared.alerts;
    const alerts = props.alerts;
    return h(Field, { label: t('machineServices.healthSetup.alerts', 'Alerts') }, h(Stack, {},
        alerts ? h(Text, { value: alerts.channels.length === 0
                ? t('machineServices.healthSetup.alerts.off', 'Off')
                : t('machineServices.healthSetup.alerts.saved', 'Saved destinations are kept when you add a check.') }) : null,
        ...(alerts?.channels.map((channel, index) => h(Stack, { key: `${channel.channelId}:${index}` },
            h(Text, { value: channel.channelId }),
            props.testContext ? h(Action.Control, {
                action: SAVED_HEALTH_ALERT_TEST_ACTION_ID,
                title: t('machineServices.healthSetup.alerts.test', 'Test'),
                disabled: selecting || alerts !== preparedAlerts,
                controller: {
                    prepare: async () => alerts === preparedAlerts && props.testContext
                        ? { input: { ...props.testContext, channelId: channel.channelId, channelIndex: index } } : null,
                    onSettled: execution => {
                        if (!execution.ok) {
                            setTestResult({ channel, message: execution.errorCode });
                            return;
                        }
                        try {
                            const result = SavedHealthAlertTestResultSchema.parse(execution.result);
                            const message = result.status === 'sent' ? t('machineServices.healthSetup.alerts.testSent', 'Test sent')
                                : result.status === 'paused' ? t('machineServices.healthSetup.alerts.testPaused', 'Test paused')
                                    : result.status === 'off' ? t('machineServices.healthSetup.alerts.testOff', 'Alerts are off')
                                        : result.reason;
                            setTestResult({ channel, message });
                        } catch { setTestResult({ channel,
                            message: t('machineServices.healthSetup.alerts.testUnavailable', 'Test result is unavailable.') }); }
                    },
                },
                fallback: h(Text, { value: t('machineServices.healthSetup.alerts.testUnavailable', 'Test is unavailable on this device.') }),
            }) : null,
            testResult?.channel === channel ? h(Text, { value: testResult.message }) : null,
            h(Button, { title: t('machineServices.healthSetup.alerts.changeDestination', 'Change destination'),
                variant: 'plain', disabled: selecting || !props.destinationSelectionContext, onPress: async () => {
                    const target = props.destinationSelectionContext;
                    if (!target) return;
                    setSelecting(true);
                    setSelectionUnavailable(false);
                    try {
                        const selected = await host.selectActionInput({ hostAction: {
                            action: NOTIFICATION_NOTIFY_ME_ACTION_ID, projection: 'notificationDestination',
                        }, channelId: channel.channelId, target });
                        if (selected.kind === 'notificationDestination') props.onChange({ ...alerts,
                            channels: alerts.channels.map((value, position) => position === index ? selected.channel : value) });
                    } catch { setSelectionUnavailable(true); }
                    finally { setSelecting(false); }
                } }),
            h(Button, { title: t('machineServices.healthSetup.alerts.removeDestination', 'Remove destination'),
                variant: 'plain', disabled: selecting,
                onPress: () => props.onChange({ ...alerts,
                    channels: alerts.channels.filter((_, position) => position !== index) }) }),
        )) ?? []),
        h(Button, { title: t('machineServices.healthSetup.alerts.addDestination', 'Add destination'),
            variant: 'plain', disabled: selecting || !props.destinationSelectionContext, onPress: async () => {
                const target = props.destinationSelectionContext;
                if (!target) return;
                setSelecting(true);
                setSelectionUnavailable(false);
                try {
                    const selected = await host.selectActionInput({ hostAction: {
                        action: NOTIFICATION_NOTIFY_ME_ACTION_ID, projection: 'notificationDestination',
                    }, target });
                    if (selected.kind === 'notificationDestination') props.onChange({
                        channels: [...(alerts?.channels ?? []), selected.channel],
                        phases: alerts?.phases ?? ['open', 'recovered'],
                    });
                } catch { setSelectionUnavailable(true); }
                finally { setSelecting(false); }
            } }),
        selectionUnavailable ? h(Text, { value: t('machineServices.healthSetup.alerts.selectionUnavailable',
            'Alert destinations are unavailable. Try again.') }) : null,
        alerts && alerts.channels.length > 0 ? h(SelectionTiles<AlertPhaseChoice>, {
            accessibilityLabel: t('machineServices.healthSetup.alerts.phases', 'Send alerts for'),
            maximumColumns: 3,
            value: alerts.phases.includes('open') ? alerts.phases.includes('recovered') ? 'both' : 'open'
                : alerts.phases.includes('recovered') ? 'recovered' : null,
            options: [
                { id: 'both', title: t('machineServices.healthSetup.alerts.both', 'Failure and recovery') },
                { id: 'open', title: t('machineServices.healthSetup.alerts.failure', 'Failure only') },
                { id: 'recovered', title: t('machineServices.healthSetup.alerts.recovery', 'Recovery only') },
            ],
            onChange: (phase: AlertPhaseChoice) => props.onChange({ ...alerts, phases: phase === 'both' ? ['open', 'recovered'] : [phase] }),
        }) : null,
        alerts && alerts.channels.length > 0 ? h(Button, {
            title: t('machineServices.healthSetup.alerts.turnOff', 'Turn alerts off'), variant: 'plain',
            onPress: () => props.onChange({ channels: [], phases: alerts.phases }),
        }) : null,
    ));
}
