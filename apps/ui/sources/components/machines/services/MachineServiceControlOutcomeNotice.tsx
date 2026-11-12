import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import type { MachineServiceControlOutcome } from './useMachineServiceDetail';

/** Every service control preserves the Action owner's typed refusal, remedy and diagnostics. */
export function MachineServiceControlOutcomeNotice(props: Readonly<{
    outcome: MachineServiceControlOutcome; service: string; machine: string; testID: string; style?: StyleProp<TextStyle>;
}>) {
    const { theme } = useUnistyles();
    const { outcome } = props;
    const title = controlOutcomeCopy(outcome, props.service, props.machine);
    if (outcome.kind === 'unavailable' || outcome.kind === 'failed') return <SurfaceStateCard
        testID={props.testID} kind={outcome.kind === 'unavailable' ? 'unavailable' : 'error'} size="line"
        title={outcome.failure && outcome.failure.error !== outcome.errorCode
            ? presentActionExecutionFailure({ ...outcome.failure, message: outcome.failure.error }).reason : title}
        reason={outcome.kind === 'unavailable' ? t('machineServices.control.unavailableRemedy') : undefined}
        diagnosticCode={outcome.errorCode}
        diagnosticDetail={outcome.failure ? presentActionExecutionFailure(outcome.failure).technicalDetails
            .filter(line => line.key !== 'code').map(line => line.label + ': ' + line.value).join('\n') : undefined} />;
    return <Text variant="meta" testID={props.testID}
        style={[props.style, outcome.kind === 'approval' ? null : { color: theme.colors.state.warning.foreground }]}>{title}</Text>;
}

function controlOutcomeCopy(outcome: MachineServiceControlOutcome, service: string, machine: string): string {
    switch (outcome.kind) {
        case 'approval': return t('machineServices.control.approval');
        case 'unknown': return t('machineServices.control.unknown', { machine });
        case 'unsupported': return t('machineServices.control.unsupported', { machine, service });
        case 'unavailable': return t('machineServices.control.unavailable');
        case 'failed': return t('machineServices.control.failed', { service });
    }
}
