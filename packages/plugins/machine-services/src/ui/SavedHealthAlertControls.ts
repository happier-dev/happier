import { createElement as h, type ReactElement } from 'react';
import type { HealthCheckSetupInputV1 } from '@happier-dev/plugin-sdk';
import { Field, Stack, Text, usePluginTranslation } from '@happier-dev/plugin-ui';

/** Saved subject choices stay visible while another check is being added. */
export function SavedHealthAlertControls(props: Readonly<{
    alerts: HealthCheckSetupInputV1['alerts'];
}>): ReactElement {
    const t = usePluginTranslation();
    const alerts = props.alerts;
    return h(Field, { label: t('machineServices.healthSetup.alerts', 'Alerts') }, h(Stack, {},
        h(Text, { value: alerts === undefined
            ? t('machineServices.healthSetup.alerts.default', 'Alert destinations have not been configured for this subject.')
            : alerts.channels.length === 0
                ? t('machineServices.healthSetup.alerts.off', 'Off')
                : t('machineServices.healthSetup.alerts.saved', 'Saved destinations are kept when you add a check.') }),
        alerts && alerts.channels.length > 0 ? h(Text, { tone: 'secondary', value: alerts.phases.includes('open')
            ? alerts.phases.includes('recovered')
                ? t('machineServices.healthSetup.alerts.both', 'Failure and recovery')
                : t('machineServices.healthSetup.alerts.failure', 'Failure only')
            : alerts.phases.includes('recovered')
                ? t('machineServices.healthSetup.alerts.recovery', 'Recovery only')
                : t('machineServices.healthSetup.alerts.noPhases', 'No delivery phases selected') }) : null,
    ));
}
