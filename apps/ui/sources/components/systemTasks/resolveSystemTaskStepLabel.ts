import { t, type TranslationKey } from '@/text';

const SYSTEM_TASK_STEP_TRANSLATION_KEYS: Readonly<Record<string, TranslationKey>> = {
    prepare: 'settings.systemTaskStepPrepare',
    'task.step.prepare': 'settings.systemTaskStepPrepare',
    install: 'settings.systemTaskStepInstallRuntime',
    'task.step.installRuntime': 'settings.systemTaskStepInstallRuntime',
    'task.step.finish': 'settings.systemTaskStepFinish',
    finish: 'settings.systemTaskStepFinish',
    'install.runtime': 'settings.systemTaskStepInstallRuntime',
    'setup.thisComputer.cliChoice': 'settings.systemTaskStepPrepare',
    'setup.thisComputer.ensureCli': 'settings.systemTaskStepInstallRuntime',
    'setup.thisComputer.resolveRelay': 'settings.machineEnrollStepResolveRelay',
    'setup.thisComputer.checkAuth': 'settings.machineEnrollStepCheckAuth',
    'setup.thisComputer.preflight.releaseChannel': 'setupOnboarding.thisComputerStages.backgroundServiceTitle',
    'setup.thisComputer.preflight.manualRelayTakeover': 'setupOnboarding.thisComputerStages.backgroundServiceTitle',
    'setup.thisComputer.preflight.serviceConflict': 'setupOnboarding.thisComputerStages.backgroundServiceTitle',
    'setup.thisComputer.configureRelay': 'settings.machineEnrollStepConfigureRelay',
    'setup.thisComputer.auth.request': 'settings.machineEnrollStepAuthRequest',
    'setup.thisComputer.auth.wait': 'settings.machineEnrollStepAuthWait',
    'setup.thisComputer.installService': 'settings.machineEnrollStepInstallService',
    'setup.thisComputer.startService': 'settings.machineEnrollStepStartService',
    'setup.thisComputer.restartService': 'settings.machineEnrollStepRestartService',
    'setup.thisComputer.verifyService': 'settings.machineEnrollStepVerifyService',
    'setup.repairThisComputer.prepare': 'server.relayDrift.progressStepPrepare',
    'setup.repairThisComputer.configureRelay': 'server.relayDrift.progressStepConfigureRelay',
    'setup.repairThisComputer.authRequest': 'server.relayDrift.progressStepAuthenticate',
    'setup.repairThisComputer.authenticate': 'server.relayDrift.progressStepAuthenticate',
    'setup.repairThisComputer.installService': 'settings.machineEnrollStepInstallService',
    'setup.repairThisComputer.startService': 'settings.machineEnrollStepStartService',
    'setup.repairThisComputer.restartService': 'settings.machineEnrollStepRestartService',
    'setup.repairThisComputer.waitForReady': 'settings.machineEnrollStepVerifyService',
    'setup.repairThisComputer.finish': 'server.relayDrift.progressStepFinish',
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
    'ssh.trust': 'settings.machineEnrollStageConnect',
    'ssh.hostTrust': 'settings.machineEnrollStageConnect',
    'ssh.auth.request': 'settings.machineEnrollStageConnect',
    'ssh.auth.approval': 'settings.machineEnrollStageConnect',
    'ssh.auth.wait': 'settings.machineEnrollStageConnect',
    'ssh.installCli': 'settings.machineEnrollStageInstall',
    'relay.runtime.install': 'settings.machineEnrollStageInstall',
    'ssh.complete': 'settings.machineEnrollStageFinish',
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
