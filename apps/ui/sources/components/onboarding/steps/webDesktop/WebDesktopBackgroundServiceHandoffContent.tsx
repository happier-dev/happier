import * as React from 'react';

import { t } from '@/text';

import { buildCliInstallAndRunCommandForCurrentApp } from '../../commands/wizardCliCommands';
import { buildCliInstallAndRunPowershellCommandForCurrentApp } from '../../commands/wizardCliCommands';
import { buildWebDesktopBackgroundServiceHandoffSteps } from '../../commands/webDesktopHandoffSteps';
import {
    WizardGuidedHandoff,
    WizardGuidedHandoffDownloadCta,
    WizardGuidedHandoffNote,
    WizardGuidedHandoffTerminal,
} from '@/components/onboarding';

export type WebDesktopBackgroundServiceHandoffContentProps = Readonly<{
    testID: string;
    relayUrl: string;
}>;

export function WebDesktopBackgroundServiceHandoffContent(props: WebDesktopBackgroundServiceHandoffContentProps) {
    const installAndSetupCommand = React.useMemo(() => buildCliInstallAndRunCommandForCurrentApp({
        action: 'setup',
        args: ['--relay-url', props.relayUrl, '--skip-providers', '--yes'],
    }), [props.relayUrl]);
    const installAndSetupWindowsCommand = React.useMemo(() => buildCliInstallAndRunPowershellCommandForCurrentApp({
        action: 'setup',
        args: ['--relay-url', props.relayUrl, '--skip-providers', '--yes'],
    }), [props.relayUrl]);
    const steps = React.useMemo(() => buildWebDesktopBackgroundServiceHandoffSteps({
        installAndSetupCommand,
        installAndSetupWindowsCommand,
        relayUrl: props.relayUrl,
    }), [installAndSetupCommand, installAndSetupWindowsCommand, props.relayUrl]);

    return (
        <WizardGuidedHandoff testID={props.testID}>
            <WizardGuidedHandoffTerminal
                testID={`${props.testID}-terminal`}
                steps={steps}
            />
            <WizardGuidedHandoffDownloadCta testIDPrefix={props.testID} />
            <WizardGuidedHandoffNote
                testID={`${props.testID}-optional`}
                title={t('setupOnboarding.webDesktopOnlyOptionalNextTitle')}
                subtitle={t('setupOnboarding.webDesktopOnlyOptionalNextBody')}
            />
        </WizardGuidedHandoff>
    );
}
