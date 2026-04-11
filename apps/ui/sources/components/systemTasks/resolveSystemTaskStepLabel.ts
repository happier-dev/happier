import { t, type TranslationKey } from '@/text';

const SYSTEM_TASK_STEP_TRANSLATION_KEYS: Readonly<Record<string, TranslationKey>> = {
    prepare: 'settings.systemTaskStepPrepare',
    'task.step.prepare': 'settings.systemTaskStepPrepare',
    install: 'settings.systemTaskStepInstallRuntime',
    'task.step.installRuntime': 'settings.systemTaskStepInstallRuntime',
    'task.step.finish': 'settings.systemTaskStepFinish',
    finish: 'settings.systemTaskStepFinish',
    'install.runtime': 'settings.systemTaskStepInstallRuntime',
    'setup.thisComputer.ensureCli': 'settings.systemTaskStepInstallRuntime',
    'setup.thisComputer.resolveRelay': 'settings.machineSetupStepResolveRelay',
    'setup.thisComputer.checkAuth': 'settings.machineSetupStepCheckAuth',
    'setup.thisComputer.preflight.releaseChannel': 'setupOnboarding.thisComputerStages.backgroundServiceTitle',
    'setup.thisComputer.preflight.serviceConflict': 'setupOnboarding.thisComputerStages.backgroundServiceTitle',
    'setup.thisComputer.configureRelay': 'settings.machineSetupStepConfigureRelay',
    'setup.thisComputer.auth.request': 'settings.machineSetupStepAuthRequest',
    'setup.thisComputer.auth.wait': 'settings.machineSetupStepAuthWait',
    'setup.thisComputer.installService': 'settings.machineSetupStepInstallService',
    'setup.thisComputer.startService': 'settings.machineSetupStepStartService',
    'setup.thisComputer.verifyService': 'settings.machineSetupStepVerifyService',
    'relay.connectBackgroundService.prepare': 'server.relayDrift.progressStepPrepare',
    'relay.connectBackgroundService.configureRelay': 'server.relayDrift.progressStepConfigureRelay',
    'relay.connectBackgroundService.authenticate': 'server.relayDrift.progressStepAuthenticate',
    'relay.connectBackgroundService.finish': 'server.relayDrift.progressStepFinish',
    'relay.drift.repair.start': 'server.relayDrift.progressStepPrepare',
    'relay.status.inspect': 'settings.localRelayRuntime.progressStepInspect',
    'relay.status.health': 'settings.localRelayRuntime.progressStepHealth',
    'relay.install': 'settings.localRelayRuntime.progressStepInstall',
    'relay.start': 'settings.localRelayRuntime.progressStepStart',
    'relay.stop': 'settings.localRelayRuntime.progressStepStop',
    'tailscale.detect': 'settings.localTailscale.progressStepDetect',
    'tailscale.install': 'settings.localTailscale.progressStepInstall',
    'tailscale.login': 'settings.localTailscale.progressStepLogin',
    'tailscale.serveEnable': 'settings.localTailscale.progressStepServeEnable',
    'tailscale.verifyUrl': 'settings.localTailscale.progressStepVerifyUrl',
    'relay.access.status.inspect': 'settings.relayAccess.progressStepInspect',
    'relay.access.status.check': 'settings.relayAccess.progressStepCheck',
    'relay.access.configure.persist': 'settings.relayAccess.progressStepPersist',
    'relay.access.configure.apply': 'settings.relayAccess.progressStepApply',
    'relay.access.configure.verify': 'settings.relayAccess.progressStepVerify',
    'relay.access.disable': 'settings.relayAccess.progressStepDisable',
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

    const normalizedStepId = String(stepId).trim();
    if (!normalizedStepId) {
        return null;
    }

    const translationKey = SYSTEM_TASK_STEP_TRANSLATION_KEYS[normalizedStepId];
    if (translationKey) {
        return t(translationKey);
    }
    return normalizedStepId;
}
