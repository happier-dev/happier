import { t } from '@/text';
import type { WizardCapabilities } from '../../capabilities/resolveWizardCapabilities';
import type { WizardChoice } from './relaySelectionTypes';

export function buildRelayChoices(params: Readonly<{
    wizardCapabilities: WizardCapabilities;
    setupPolicy: Readonly<{
        relay: Readonly<{
            allowHappierCloud: boolean;
            allowLocalRelayHost: boolean;
        }>;
    }>;
}>): readonly WizardChoice[] {
    const thisComputerTitleKey = params.wizardCapabilities.thisComputerLabelVariant === 'your'
        ? 'setupOnboarding.relayOnYourComputerTitle'
        : 'setupOnboarding.relayOnThisComputerTitle';
    const thisComputerSubtitleKey = params.wizardCapabilities.thisComputerLabelVariant === 'your'
        ? 'setupOnboarding.relayOnYourComputerSubtitle'
        : 'setupOnboarding.relayOnThisComputerSubtitle';

    const choices: WizardChoice[] = [];

    if (params.setupPolicy.relay.allowHappierCloud) {
        choices.push({
            id: 'cloud',
            title: t('setupOnboarding.relayCloudTitle'),
            subtitle: t('setupOnboarding.relayCloudSubtitle'),
            icon: 'cloud-outline',
            badge: t('setupOnboarding.recommendedBadge'),
        });
    }

    if (params.setupPolicy.relay.allowLocalRelayHost) {
        choices.push({
            id: 'thisComputer',
            title: t(thisComputerTitleKey),
            subtitle: t(thisComputerSubtitleKey),
            icon: 'laptop-outline',
            disabled: false,
        });
    }

    if (params.wizardCapabilities.allowRemoteSshRelayChoice) {
        choices.push({
            id: 'remoteComputer',
            title: t('setupOnboarding.relayOnRemoteComputerTitle'),
            subtitle: t('setupOnboarding.relayOnRemoteComputerSubtitle'),
            icon: 'desktop-outline',
        });
    }

    return choices;
}
