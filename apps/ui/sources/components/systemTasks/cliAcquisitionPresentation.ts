import { CLI_ACQUISITION_PROGRESS_EVENT, parseCliAcquisitionProgress, readCliAcquisitionFailurePhase, type CliAcquisitionPhase } from '@happier-dev/protocol/system/tasks/acquisitionProgress';
import type { SystemTaskEvent } from '@happier-dev/protocol/system/tasks/spec';

import { t, type TranslationKeyNoParams } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';
import type { SystemTaskRunState } from './types';

const STATUS_KEYS = {
    resolvingRelease: 'cliAcquisitionProgress.acquisitionResolvingReleaseStatus',
    downloading: 'cliAcquisitionProgress.acquisitionDownloadingStatus',
    verifying: 'cliAcquisitionProgress.acquisitionVerifyingStatus',
    unpacking: 'cliAcquisitionProgress.acquisitionUnpackingStatus',
    installing: 'cliAcquisitionProgress.acquisitionInstallingStatus',
    finalizing: 'cliAcquisitionProgress.acquisitionFinalizingStatus',
    checkingCli: 'cliAcquisitionProgress.acquisitionCheckingCliStatus',
    checkingDaemon: 'cliAcquisitionProgress.acquisitionCheckingDaemonStatus',
} as const satisfies Record<CliAcquisitionPhase, TranslationKeyNoParams>;

const FAILURE_KEYS = {
    resolvingRelease: 'cliAcquisitionProgress.acquisitionReleaseFailed',
    downloading: 'cliAcquisitionProgress.acquisitionDownloadFailed',
    verifying: 'cliAcquisitionProgress.acquisitionVerificationFailed',
    unpacking: 'cliAcquisitionProgress.acquisitionInstallFailed',
    installing: 'cliAcquisitionProgress.acquisitionInstallFailed',
    finalizing: 'cliAcquisitionProgress.acquisitionInstallFailed',
    checkingCli: 'cliAcquisitionProgress.blockedCliUnavailableStatus',
    checkingDaemon: 'cliAcquisitionProgress.blockedCliFailedStatus',
} as const satisfies Record<CliAcquisitionPhase, TranslationKeyNoParams>;

export function resolveCliAcquisitionFailureMessage(code: string): string | undefined {
    const phase = readCliAcquisitionFailurePhase(code);
    if (phase) return t(FAILURE_KEYS[phase]);
    if (code === 'first_party_component_install_failed') return t(FAILURE_KEYS.installing);
    return undefined;
}

/** One presentation owner for live status, task cards and checklist history. */
export function presentCliAcquisitionEvent(event: SystemTaskEvent | undefined): Readonly<{
    status: string;
    downloadProgress?: string;
}> | null {
    const progress = event?.type === CLI_ACQUISITION_PROGRESS_EVENT ? parseCliAcquisitionProgress(event.data) : null;
    if (!progress) return null;
    if (progress.failure) return { status: t(FAILURE_KEYS[progress.phase]) };
    const downloadProgress = progress.phase === 'downloading' && progress.receivedBytes !== undefined
        ? progress.totalBytes !== undefined
            ? t('cliAcquisitionProgress.acquisitionDownloadBytesTotal', {
                received: formatByteSize(progress.receivedBytes), total: formatByteSize(progress.totalBytes),
            })
            : t('cliAcquisitionProgress.acquisitionDownloadBytes', { received: formatByteSize(progress.receivedBytes) })
        : undefined;
    return { status: t(STATUS_KEYS[progress.phase]), downloadProgress };
}

export function presentActiveCliAcquisition(
    snapshot: SystemTaskRunState | null | undefined,
): ReturnType<typeof presentCliAcquisitionEvent> {
    if (!snapshot || snapshot.result || snapshot.status !== 'running' || snapshot.awaitingInput) return null;
    return presentCliAcquisitionEvent(snapshot.events.at(-1));
}
