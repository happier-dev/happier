import { t, type TranslationKey } from '@/text';

const SYSTEM_TASK_STEP_TRANSLATION_KEYS: Readonly<Record<string, TranslationKey>> = {
    'task.step.prepare': 'settings.systemTaskStepPrepare',
    'task.step.installRuntime': 'settings.systemTaskStepInstallRuntime',
    'task.step.finish': 'settings.systemTaskStepFinish',
    'install.runtime': 'settings.systemTaskStepInstallRuntime',
    'setup.thisComputer.resolveRelay': 'settings.machineSetupStageConnect',
    'setup.thisComputer.checkAuth': 'settings.machineSetupStageConnect',
    'setup.thisComputer.configureRelay': 'settings.machineSetupStageConnect',
    'setup.thisComputer.installService': 'settings.machineSetupStageInstall',
    'setup.thisComputer.startService': 'settings.machineSetupStageInstall',
    'setup.thisComputer.verifyService': 'settings.machineSetupStageFinish',
    'relay.connectBackgroundService.prepare': 'server.relayDrift.progressStepPrepare',
    'relay.connectBackgroundService.configureRelay': 'server.relayDrift.progressStepConfigureRelay',
    'relay.connectBackgroundService.authenticate': 'server.relayDrift.progressStepAuthenticate',
    'relay.connectBackgroundService.finish': 'server.relayDrift.progressStepFinish',
    'relay.drift.repair.start': 'server.relayDrift.progressStepPrepare',
    'ssh.trust': 'settings.machineSetupStageConnect',
    'ssh.hostTrust': 'settings.machineSetupStageConnect',
    'ssh.auth.request': 'settings.machineSetupStageConnect',
    'ssh.auth.approval': 'settings.machineSetupStageConnect',
    'ssh.auth.wait': 'settings.machineSetupStageConnect',
    'ssh.installCli': 'settings.machineSetupStageInstall',
    'relay.runtime.install': 'settings.machineSetupStageInstall',
    'ssh.complete': 'settings.machineSetupStageFinish',
};

export function resolveSystemTaskStepLabel(stepId: string | null): string | null {
    if (!stepId) {
        return null;
    }

    const translationKey = SYSTEM_TASK_STEP_TRANSLATION_KEYS[stepId];
    return translationKey ? t(translationKey) : stepId;
}
