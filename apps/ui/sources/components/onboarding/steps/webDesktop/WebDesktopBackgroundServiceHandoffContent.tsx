import * as React from 'react';

import { StepOrDivider } from '@/components/onboarding/unauthShell/StepFormParts';

import { buildMachineAddCommand } from '@/components/machines/add/machineAddCommand';
import { useMachineAddHomeTargetAtUrl } from '@/components/machines/add/machineAddHomeTarget';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { buildWebDesktopBackgroundServiceHandoffSteps } from '../../commands/webDesktopHandoffSteps';
import {
    WizardGuidedHandoff,
    WizardGuidedHandoffDownloadCta,
    WizardGuidedHandoffTerminal,
} from '../../ui/WizardGuidedHandoff';

export type WebDesktopBackgroundServiceHandoffContentProps = Readonly<{
    testID: string;
    relayUrl: string;
}>;

export function WebDesktopBackgroundServiceHandoffContent(props: WebDesktopBackgroundServiceHandoffContentProps) {
    const target = useMachineAddHomeTargetAtUrl(props.relayUrl);
    const commands = React.useMemo(() => ({
        macos: buildMachineAddCommand({ ...target, kind: 'joinHome', os: 'macos', remote: true, skipProviders: true }),
        linux: buildMachineAddCommand({ ...target, kind: 'joinHome', os: 'linux', remote: true, skipProviders: true }),
        windows: buildMachineAddCommand({ ...target, kind: 'joinHome', os: 'windows', remote: true, skipProviders: true }),
    }), [target]);
    const steps = React.useMemo(() => Object.values(commands).some(Boolean) ? buildWebDesktopBackgroundServiceHandoffSteps({
        commands, relayUrl: props.relayUrl,
    }) : [], [commands, props.relayUrl]);

    return (
        <WizardGuidedHandoff testID={props.testID}>
            {steps.length ? <WizardGuidedHandoffTerminal
                testID={`${props.testID}-terminal`}
                steps={steps}
            /> : <Text>{t('common.unavailable')}</Text>}
            <StepOrDivider label={t('common.or')} />
            <WizardGuidedHandoffDownloadCta testIDPrefix={props.testID} />
        </WizardGuidedHandoff>
    );
}
