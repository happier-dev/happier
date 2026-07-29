import { getNativeSshAvailability } from '@happier-dev/ssh-native';

import type { WizardPlatform } from '../state/wizardTypes';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';

export type WizardCapabilities = Readonly<{
    allowRemoteSshRelayChoice: boolean;
    allowNativeSshMachineSetup: boolean;
    thisComputerLabelVariant: 'this' | 'your';
}>;

export function resolveWizardCapabilities(params: Readonly<{
    platform: WizardPlatform;
    isDesktopShell: boolean;
}>): WizardCapabilities {
    const platform = params.platform;
    const setupPolicy = resolveSetupSurfacePolicy();
    const nativeSshAvailability = platform === 'native'
        ? getNativeSshAvailability()
        : null;
    return {
        allowRemoteSshRelayChoice:
            platform === 'desktop'
            && params.isDesktopShell
            && setupPolicy.relay.allowRemoteSshRelayHost,
        allowNativeSshMachineSetup:
            platform === 'native'
            && setupPolicy.machine.allowRemoteSshMachineSetup
            && nativeSshAvailability?.available === true,
        thisComputerLabelVariant: platform === 'native' ? 'your' : 'this',
    };
}
