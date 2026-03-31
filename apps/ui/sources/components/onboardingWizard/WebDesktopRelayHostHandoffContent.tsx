import * as React from 'react';

import { t } from '@/text';

import { buildCliInstallCommandForCurrentApp } from './wizardCliCommands';
import { buildWebDesktopRelayHostHandoffSteps } from './webDesktopHandoffSteps';
import {
    WizardGuidedHandoff,
    WizardGuidedHandoffDownloadCta,
    WizardGuidedHandoffNote,
    WizardGuidedHandoffTerminal,
} from './WizardGuidedHandoff';

export type WebDesktopRelayHostHandoffContentProps = Readonly<{
    testID: string;
}>;

export function WebDesktopRelayHostHandoffContent(props: WebDesktopRelayHostHandoffContentProps) {
    const cliInstallCommand = React.useMemo(() => buildCliInstallCommandForCurrentApp(), []);

    return (
        <WizardGuidedHandoff testID={props.testID}>
            <WizardGuidedHandoffTerminal
                testID={`${props.testID}-terminal`}
                steps={buildWebDesktopRelayHostHandoffSteps({
                    cliInstallCommand,
                    includeDaemonInstall: false,
                })}
            />
            <WizardGuidedHandoffDownloadCta testIDPrefix={props.testID} showSubtitle={false} />
            <WizardGuidedHandoffNote
                testID={`${props.testID}-optional`}
                title={t('setupOnboarding.webDesktopOnlyOptionalNextTitle')}
                subtitle={t('setupOnboarding.webDesktopOnlyOptionalNextBody')}
            />
        </WizardGuidedHandoff>
    );
}
