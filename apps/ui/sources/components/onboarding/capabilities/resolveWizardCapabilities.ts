import type { WizardPlatform } from '../state/wizardTypes';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';

export type WizardCapabilities = Readonly<{
    allowRemoteSshRelayChoice: boolean;
    thisComputerLabelVariant: 'this' | 'your';
}>;

export function resolveWizardCapabilities(params: Readonly<{
    platform: WizardPlatform;
    isDesktopShell: boolean;
}>): WizardCapabilities {
    const platform = params.platform;
    const setupPolicy = resolveSetupSurfacePolicy();
    return {
        allowRemoteSshRelayChoice:
            platform === 'desktop'
            && params.isDesktopShell
            && setupPolicy.relay.allowRemoteSshRelayHost,
        thisComputerLabelVariant: platform === 'native' ? 'your' : 'this',
    };
}
