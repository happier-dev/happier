import { t } from '@/text';

import { buildHappierSetupCommand } from './wizardCliCommands';
import type { WizardTerminalHandoffStep } from '../ui/WizardTerminalHandoff';

export function buildWebDesktopRelayHostHandoffSteps(input: Readonly<{
    installAndSetupRelayCommand: string;
    installAndSetupRelayWindowsCommand?: string;
}>): readonly WizardTerminalHandoffStep[] {
    return [
        {
            title: t('setupOnboarding.webDesktopOnlyRelayInstallTitle'),
            subtitle: t('setupOnboarding.webDesktopOnlyRelayInstallSubtitle'),
            code: input.installAndSetupRelayCommand,
            windowsCode: input.installAndSetupRelayWindowsCommand,
            windowsLanguage: input.installAndSetupRelayWindowsCommand ? 'powershell' : undefined,
            scrollTestIDSuffix: 'relay-setup',
        },
    ];
}

export function buildWebDesktopBackgroundServiceHandoffSteps(input: Readonly<{
    installAndSetupCommand: string;
    installAndSetupWindowsCommand?: string;
    relayUrl: string;
}>): readonly WizardTerminalHandoffStep[] {
    return [
        {
            title: t('setupOnboarding.webDesktopOnlySetupCommandTitle'),
            subtitle: t('setupOnboarding.webDesktopOnlySetupCommandSubtitle'),
            code: input.installAndSetupCommand,
            windowsCode: input.installAndSetupWindowsCommand,
            windowsLanguage: input.installAndSetupWindowsCommand ? 'powershell' : undefined,
            scrollTestIDSuffix: 'setup',
        },
    ];
}
