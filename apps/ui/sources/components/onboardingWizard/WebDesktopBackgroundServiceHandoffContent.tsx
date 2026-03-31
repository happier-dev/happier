import * as React from 'react';

import { t } from '@/text';

import { buildCliInstallCommandForCurrentApp } from './wizardCliCommands';
import { buildWebDesktopBackgroundServiceHandoffSteps } from './webDesktopHandoffSteps';
import {
    WizardGuidedHandoff,
    WizardGuidedHandoffDownloadCta,
    WizardGuidedHandoffNote,
    WizardGuidedHandoffTerminal,
} from './WizardGuidedHandoff';

export type WebDesktopBackgroundServiceHandoffContentProps = Readonly<{
    testID: string;
    relayUrl: string;
}>;

export function WebDesktopBackgroundServiceHandoffContent(props: WebDesktopBackgroundServiceHandoffContentProps) {
    const cliInstallCommand = React.useMemo(() => buildCliInstallCommandForCurrentApp(), []);
    const steps = React.useMemo(() => buildWebDesktopBackgroundServiceHandoffSteps({
        cliInstallCommand,
        relayUrl: props.relayUrl,
    }), [cliInstallCommand, props.relayUrl]);

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
