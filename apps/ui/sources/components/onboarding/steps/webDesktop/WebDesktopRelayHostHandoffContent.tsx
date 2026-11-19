import * as React from 'react';

import { StepOrDivider } from '@/components/onboarding/unauthShell/StepFormParts';

import { t } from '@/text';

import { buildCliInstallAndRunCommandForCurrentApp, buildCliInstallAndRunPowershellCommandForCurrentApp } from '../../commands/wizardCliCommands';
import { buildWebDesktopRelayHostHandoffSteps } from '../../commands/webDesktopHandoffSteps';
import {
    WizardGuidedHandoff,
    WizardGuidedHandoffDownloadCta,
    WizardGuidedHandoffTerminal,
} from '../../ui/WizardGuidedHandoff';

export type WebDesktopRelayHostHandoffContentProps = Readonly<{
    testID: string;
}>;

export function WebDesktopRelayHostHandoffContent(props: WebDesktopRelayHostHandoffContentProps) {
    const installAndSetupRelayCommand = React.useMemo(() => buildCliInstallAndRunCommandForCurrentApp({ action: 'home-create' }), []);
    const installAndSetupRelayWindowsCommand = React.useMemo(() => buildCliInstallAndRunPowershellCommandForCurrentApp({ action: 'home-create' }), []);

    return (
        <WizardGuidedHandoff testID={props.testID}>
            <WizardGuidedHandoffTerminal
                testID={`${props.testID}-terminal`}
                steps={buildWebDesktopRelayHostHandoffSteps({
                    installAndSetupRelayCommand,
                    installAndSetupRelayWindowsCommand,
                })}
            />
            <StepOrDivider label={t('common.or')} />
            <WizardGuidedHandoffDownloadCta testIDPrefix={props.testID} />
        </WizardGuidedHandoff>
    );
}
