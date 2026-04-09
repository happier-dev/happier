import * as React from 'react';

import { buildCliInstallAndRunCommandForCurrentApp, buildCliInstallAndRunPowershellCommandForCurrentApp } from '../../commands/wizardCliCommands';
import { buildWebDesktopRelayHostHandoffSteps } from '../../commands/webDesktopHandoffSteps';
import {
    WizardGuidedHandoff,
    WizardGuidedHandoffDownloadCta,
    WizardGuidedHandoffNote,
    WizardGuidedHandoffTerminal,
} from '../../ui/WizardGuidedHandoff';

export type WebDesktopRelayHostHandoffContentProps = Readonly<{
    testID: string;
}>;

export function WebDesktopRelayHostHandoffContent(props: WebDesktopRelayHostHandoffContentProps) {
    const installAndSetupRelayCommand = React.useMemo(() => buildCliInstallAndRunCommandForCurrentApp({ action: 'setup-relay' }), []);
    const installAndSetupRelayWindowsCommand = React.useMemo(() => buildCliInstallAndRunPowershellCommandForCurrentApp({ action: 'setup-relay' }), []);

    return (
        <WizardGuidedHandoff testID={props.testID}>
            <WizardGuidedHandoffTerminal
                testID={`${props.testID}-terminal`}
                steps={buildWebDesktopRelayHostHandoffSteps({
                    installAndSetupRelayCommand,
                    installAndSetupRelayWindowsCommand,
                })}
            />
            <WizardGuidedHandoffDownloadCta testIDPrefix={props.testID} />
        </WizardGuidedHandoff>
    );
}
