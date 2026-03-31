import { t } from '@/text';

import type { WizardTerminalHandoffStep } from './WizardTerminalHandoff';

export function buildWebDesktopRelayHostHandoffSteps(input: Readonly<{
    cliInstallCommand: string;
    includeDaemonInstall: boolean;
}>): readonly WizardTerminalHandoffStep[] {
    const steps: WizardTerminalHandoffStep[] = [
        {
            title: t('setupOnboarding.webDesktopOnlyCliTitle'),
            subtitle: t('setupOnboarding.webDesktopOnlyCliSubtitle'),
            code: input.cliInstallCommand,
            scrollTestIDSuffix: 'cli-install',
        },
    ];

    if (input.includeDaemonInstall) {
        steps.push({
            title: t('sessionGettingStarted.steps.daemonInstall.title'),
            subtitle: t('sessionGettingStarted.steps.daemonInstall.description'),
            code: 'happier daemon install',
            scrollTestIDSuffix: 'daemon-install',
        });
    }

    steps.push(
        {
            title: t('setupOnboarding.webDesktopOnlyRelayInstallTitle'),
            subtitle: t('setupOnboarding.webDesktopOnlyRelayInstallSubtitle'),
            code: 'happier relay host install --mode user',
            scrollTestIDSuffix: 'relay-install',
        },
        {
            title: t('setupOnboarding.webDesktopOnlyRelayStatusTitle'),
            subtitle: t('setupOnboarding.webDesktopOnlyRelayStatusSubtitle'),
            code: 'happier relay host status --json',
            scrollTestIDSuffix: 'relay-status',
        },
    );

    return steps;
}

