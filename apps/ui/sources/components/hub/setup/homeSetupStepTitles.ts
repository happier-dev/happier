import { t, type TranslationKey } from '@/text';

export const HOME_SETUP_STEP_TITLES = {
    addPhone: 'settings.addYourPhone',
    addMachine: 'settingsOverview.addMachineTitle',
    recoveryKey: 'settingsOverview.saveRecoveryKeyTitle',
    connectComputer: 'homeSetup.connectComputerTitle',
    browsePlugins: 'settingsOverview.browsePluginsTitle',
    installComputer: 'homeSetup.installComputerTitle',
    personalize: 'personalize.cardTitle',
    askHappier: 'bots.guide.offer',
} as const satisfies Record<string, TranslationKey>;

export function readHomeSetupStepTitle(stepId: string): string | null {
    if (!Object.prototype.hasOwnProperty.call(HOME_SETUP_STEP_TITLES, stepId)) return null;
    return t(HOME_SETUP_STEP_TITLES[stepId as keyof typeof HOME_SETUP_STEP_TITLES]);
}
