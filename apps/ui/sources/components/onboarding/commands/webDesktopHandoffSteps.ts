import { t } from '@/text';

import type { CommandOs } from '@/components/ui/code/blocks/OsCommandBlock';
import type { WizardTerminalHandoffStep } from '../ui/WizardTerminalHandoff';

export function buildWebDesktopRelayHostHandoffSteps(input: Readonly<{
    installAndSetupRelayCommand: string;
    installAndSetupRelayWindowsCommand?: string;
}>): readonly WizardTerminalHandoffStep[] {
    return [
        {
            title: t('setupOnboarding.webDesktopOnlyRelayInstallTitle'),
            subtitle: t('setupOnboarding.webDesktopOnlyRelayInstallSubtitle'),
            ...(input.installAndSetupRelayWindowsCommand ? { commands: {
                macos: input.installAndSetupRelayCommand, linux: input.installAndSetupRelayCommand, windows: input.installAndSetupRelayWindowsCommand,
            } } : { code: input.installAndSetupRelayCommand }),
            scrollTestIDSuffix: 'relay-setup',
        },
    ];
}

export function buildWebDesktopBackgroundServiceHandoffSteps(input: Readonly<{
    commands: Readonly<Record<CommandOs, string | null>>;
    relayUrl: string;
}>): readonly WizardTerminalHandoffStep[] {
    return [
        {
            title: t('setupOnboarding.webDesktopOnlySetupCommandTitle'),
            subtitle: t('setupOnboarding.webDesktopOnlySetupCommandSubtitle'),
            commands: input.commands,
            scrollTestIDSuffix: 'setup',
        },
    ];
}
