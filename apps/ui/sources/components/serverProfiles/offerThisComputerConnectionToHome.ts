import { Modal } from '@/modal';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { getServerProfileById, resolveServerProfileScopeId, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import { resolveThisComputerConnection } from '@/sync/domains/server/relayDrift/thisComputerConnection';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { confirmThisComputerAccountMove } from '@/components/settings/machines/localControl/thisComputerConnectionPresentation';
import { readLocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { readLocalDaemonSharedState, startLocalComputerSetup } from '@/components/settings/machines/localControl/localDaemonSharedState';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { waitForSystemTaskResult } from '@/components/systemTasks/createSystemTaskRunner';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { buildLocalMachineSetupSystemTaskSpec } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';
import { readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

/** Explicit Add/select intent only; ordinary focus, group and notification navigation never call this. */
export async function offerThisComputerConnectionToHome(
    profile: ServerProfile,
    runner: SystemTaskRunner = getSystemTasksRunner(),
): Promise<void> {
    if (!isDesktopHost() || runner.mode === 'unavailable' || runner.mode === 'native') return;
    const serverId = resolveServerProfileScopeId(profile);
    const initial = await resolveServerCredentialAccountScope(serverId);
    if (initial.kind !== 'bound') return;
    const accountId = initial.scope.accountId;
    const home = resolveHomeDisplayLabel(profile, profile.id);
    try {
        // Read the selected Home, not the terminal's default or a cached status from another Home.
        const statusTaskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1', {
            relayUrl: profile.serverUrl, serverIdentityId: profile.serverIdentityId,
        }));
        const statusResult = await waitForSystemTaskResult(runner, statusTaskId);
        const status = readLocalDaemonStatusData(statusResult);
        if (!status) {
            Modal.alert(t('common.error'), statusResult.ok ? t('settings.systemTaskStartFailed') : statusResult.error.message);
            return;
        }
        const connection = resolveThisComputerConnection({
            daemon: status, activeRelayUrl: profile.serverUrl, activeLocalRelayUrl: null,
            appAccountId: accountId, appAccountLabel: null,
        });
        if (connection?.status === 'aligned') return;
        if (!await Modal.confirm(t('machine.thisComputer.connectHome.title', { home }),
            t('machine.thisComputer.connectHome.body', { home }), {
                confirmText: t('machine.thisComputer.connectHome.connect'),
                cancelText: t('machine.thisComputer.connectHome.keep'),
            })) return;
        // Other Homes get a pin and keep serving their accounts. Only replacing this exact Home's
        // account moves an existing account, and uses the established named-account consent.
        if (connection?.status === 'daemon_account_mismatch'
            && !await confirmThisComputerAccountMove({ ...connection, homeLabel: home, daemonHomeLabel: home })) return;
        const currentProfile = getServerProfileById(serverId);
        const current = await resolveServerCredentialAccountScope(serverId);
        if (!currentProfile || currentProfile.serverUrl !== profile.serverUrl
            || currentProfile.serverIdentityId !== profile.serverIdentityId
            || current.kind !== 'bound' || current.scope.accountId !== accountId) return;
        const taskId = await startLocalComputerSetup(runner, buildLocalMachineSetupSystemTaskSpec({
            activeRelayUrl: profile.serverUrl,
            activeWebappUrl: resolveWebappUrlFromServerUrl(profile.serverUrl),
            activeServerIdentityId: profile.serverIdentityId,
            activeAccountId: accountId,
            installService: true, startService: true, verifyService: true,
        }), { expectedRelayUrl: profile.serverUrl, serverId, expectedAccountId: accountId }, readLocalDaemonStatusData);
        if (!taskId) Modal.alert(t('common.error'), readLocalDaemonSharedState(runner).setup.errorMessage ?? t('settings.systemTaskStartFailed'));
    } catch (error) {
        Modal.alert(t('common.error'), readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed'));
    }
}
