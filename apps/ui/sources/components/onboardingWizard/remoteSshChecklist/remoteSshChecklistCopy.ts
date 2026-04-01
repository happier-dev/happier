import { t } from '@/text';

import type { RemoteSshChecklistMode } from './remoteSshChecklistTypes';

export type RemoteSshChecklistCopy = Readonly<{
    credentialsTitle: string;
    credentialsSubtitle: string;
    planTitle: string;
    planSubtitle: string;
    executionTitle: string;
    executionSubtitle: string;
    completeTitle: string;
    completeSubtitle: string;
    trustHostTitle: string;
    trustHostSubtitle: string;
    trustHostDetails: string;
    installCliTitle: string;
    installCliSubtitle: string;
    installCliDetails: string;
    configureRelayTitle: string;
    configureRelaySubtitle: string;
    configureRelayDetails: string;
    installDaemonTitle: string;
    installDaemonSubtitle: string;
    installDaemonDetails: string;
    installRelayRuntimeTitle: string;
    installRelayRuntimeSubtitle: string;
    installRelayRuntimeDetails: string;
}>;

function resolveModeCopy(mode: RemoteSshChecklistMode): Readonly<{
    credentialsTitle: string;
    credentialsSubtitle: string;
    planSubtitle: string;
    completeSubtitle: string;
}> {
    if (mode === 'remoteRelayHost') {
        return {
            credentialsTitle: t('setupOnboarding.remoteRelayHostInstallTitle'),
            credentialsSubtitle: t('setupOnboarding.relayOnRemoteComputerSubtitle'),
            planSubtitle: t('setupOnboarding.remoteSshChecklist.planSubtitleRelayHost'),
            completeSubtitle: t('settings.machineSetupRemoteRelayRuntimeReadySubtitle'),
        };
    }

    return {
        credentialsTitle: t('settings.machineSetupSshMachineTitle'),
        credentialsSubtitle: t('settings.machineSetupSshMachineSubtitle'),
        planSubtitle: t('setupOnboarding.remoteSshChecklist.planSubtitleMachine'),
        completeSubtitle: t('setupOnboarding.remoteSshChecklist.completeSubtitleMachine'),
    };
}

export function getRemoteSshChecklistCopy(mode: RemoteSshChecklistMode): RemoteSshChecklistCopy {
    const modeCopy = resolveModeCopy(mode);
    return {
        credentialsTitle: modeCopy.credentialsTitle,
        credentialsSubtitle: modeCopy.credentialsSubtitle,
        planTitle: t('setupOnboarding.remoteSshChecklist.planTitle'),
        planSubtitle: modeCopy.planSubtitle,
        executionTitle: t('setupOnboarding.remoteSshChecklist.executionTitle'),
        executionSubtitle: t('setupOnboarding.remoteSshChecklist.executionSubtitle'),
        completeTitle: t('setupOnboarding.remoteSshChecklist.completeTitle'),
        completeSubtitle: modeCopy.completeSubtitle,
        trustHostTitle: t('setupOnboarding.remoteSshChecklist.trustHostTitle'),
        trustHostSubtitle: t('setupOnboarding.remoteSshChecklist.trustHostSubtitle'),
        trustHostDetails: t('setupOnboarding.remoteSshChecklist.trustHostDetails'),
        installCliTitle: t('setupOnboarding.remoteSshChecklist.installCliTitle'),
        installCliSubtitle: t('setupOnboarding.remoteSshChecklist.installCliSubtitle'),
        installCliDetails: t('setupOnboarding.remoteSshChecklist.installCliDetails'),
        configureRelayTitle: t('setupOnboarding.remoteSshChecklist.configureRelayTitle'),
        configureRelaySubtitle: t('setupOnboarding.remoteSshChecklist.configureRelaySubtitle'),
        configureRelayDetails: t('setupOnboarding.remoteSshChecklist.configureRelayDetails'),
        installDaemonTitle: t('setupOnboarding.remoteSshChecklist.installDaemonTitle'),
        installDaemonSubtitle: t('setupOnboarding.remoteSshChecklist.installDaemonSubtitle'),
        installDaemonDetails: t('setupOnboarding.remoteSshChecklist.installDaemonDetails'),
        installRelayRuntimeTitle: t('settings.machineSetupRemoteRelayRuntimeTitle'),
        installRelayRuntimeSubtitle: t('settings.machineSetupRemoteRelayRuntimeLabel'),
        installRelayRuntimeDetails: t('settings.machineSetupRemoteRelayRuntimeReadySubtitle'),
    };
}
