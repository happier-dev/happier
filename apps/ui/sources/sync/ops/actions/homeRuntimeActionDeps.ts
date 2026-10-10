import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { buildLocalRelayRuntimeSystemTaskSpec, type LocalRelayRuntimeTaskOptions } from '@/components/systemTasks/specs/localControl/buildLocalRelayRuntimeSystemTaskSpec';
import { buildRelayAccessStatusSystemTaskSpec, buildRelayAccessDisableSystemTaskSpec, buildRelayAccessExecutionSystemTaskSpec } from '@/components/systemTasks/specs/relayAccess/buildRelayAccessSystemTaskSpec';
import { buildRemoteSshManageHostSystemTaskSpec } from '@/components/systemTasks/specs/remoteSsh/buildRemoteSshManageHostSystemTaskSpec';
import { startAdmittedRemoteHostSystemTask } from '@/components/settings/remoteHosts/remoteHostTaskOperations';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { findPersonalHomeBootstrapCompletedProfile, listServerProfiles, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { withRemoteHostSshConfig } from '@/sync/ops/remoteHosts/remoteHostOperations';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { isDesktopHost, invokeDesktopHost } from '@/utils/platform/desktopHost';
import type { LazyActionAccountContext } from './actionAccountContext';
import { settleClientSystemTaskAction } from './systemTaskActionSettlement';
import { LOCAL_RELAY_RUNTIME_ACTION_IDS } from './homeRuntimeTaskActions';

/** Action admission surrounds the existing task and desktop transports; it owns no task lifecycle. */
export function createUiHomeRuntimeActionExecute(
    account?: LazyActionAccountContext,
    runner: SystemTaskRunner = getDefaultSystemTaskRunner(),
): NonNullable<ActionExecutorDeps['homeRuntimeActionExecute']> {
    return async (request, context) => {
        const assertCurrent = () => { context.signal?.throwIfAborted(); account?.assertCurrent(); };
        const admission = { runner, assertCurrent, signal: context.signal };
        const startTask = async (spec: Parameters<SystemTaskRunner['start']>[0], assertAdmittedCurrent = assertCurrent) => {
            if (runner.mode === 'unavailable') return { status: 'unavailable' as const, reason: 'system_tasks_unavailable' };
            const started = await startAdmittedRemoteHostSystemTask({ ...admission, assertCurrent: assertAdmittedCurrent }, spec);
            return await settleClientSystemTaskAction(runner, started, context, assertAdmittedCurrent);
        };
        assertCurrent();
        if (request.actionId === 'home.runtime.get') {
            const snapshot = await getServerFeaturesSnapshot({ serverId: account?.serverId ?? context.serverId, force: request.input.force });
            assertCurrent();
            return { ok: true, result: snapshot.status === 'ready'
                ? { status: 'ready', serverRelease: snapshot.features.capabilities.serverRelease ?? null }
                : { status: 'unavailable', reason: snapshot.reason } };
        }
        if (request.actionId === 'relay.runtime.open_path' || request.actionId === 'relay.runtime.reveal_output') {
            if (!isDesktopHost()) return { ok: true, result: { status: 'unavailable', reason: 'desktop_host_unavailable' } };
            await invokeDesktopHost(request.actionId === 'relay.runtime.open_path' ? 'system_tasks_open_log_path' : 'system_tasks_reveal_output_path', { path: request.input.path });
            assertCurrent();
            return { ok: true, result: { status: 'completed' } };
        }
        if (request.actionId === 'relay.runtime.personal_home.choose_archive' || request.actionId === 'relay.runtime.personal_home.choose_backup_destination') {
            if (!isDesktopHost()) return { ok: true, result: { status: 'unavailable', reason: 'desktop_host_unavailable' } };
            const path = await invokeDesktopHost<string | null>(request.actionId === 'relay.runtime.personal_home.choose_archive'
                ? 'desktop_pick_personal_home_backup_archive' : 'desktop_save_personal_home_backup_archive');
            assertCurrent();
            return { ok: true, result: { path } };
        }
        if (request.actionId === 'relay.runtime.personal_home.relocate') {
            if (runner.mode === 'unavailable') return { ok: true, result: { status: 'unavailable', reason: 'system_tasks_unavailable' } };
            if (!account) return { ok: true, result: { status: 'unavailable', reason: 'not_authenticated' } };
            const input = request.input;
            const source = findPersonalHomeBootstrapCompletedProfile(listServerProfiles());
            if (!source?.serverIdentityId || resolveServerProfileScopeId(source) !== input.sourceServerId
                || (source.homeConnectionDescriptor?.revision ?? 1) !== input.sourceDescriptorRevision) {
                return { ok: true, result: { status: 'unavailable', reason: 'personal_home_source_changed' } };
            }
            return { ok: true, result: await withRemoteHostSshConfig(account, input, async ({ config, assertCurrent }) => {
                assertCurrent();
                const current = findPersonalHomeBootstrapCompletedProfile(listServerProfiles());
                if (!current || current.id !== source.id || current.serverIdentityId !== source.serverIdentityId
                    || (current.homeConnectionDescriptor?.revision ?? 1) !== input.sourceDescriptorRevision) {
                    return { status: 'unavailable', reason: 'personal_home_source_changed' };
                }
                const channel = resolvePreferredPublicReleaseRingLabelForCurrentApp();
                return await startTask(buildRemoteSshManageHostSystemTaskSpec({
                    action: 'personalHome.relocate', channel,
                    sshTarget: config.value.sshTarget, sshPort: config.value.sshPort ? String(config.value.sshPort) : '',
                    sshAuth: config.value.sshAuth, identityFilePath: config.value.identityFilePath,
                    identityPrivateKey: config.value.identityPrivateKey, sshConfigFilePath: config.value.sshConfigFilePath,
                    sshPassword: config.value.password, knownHostsMode: 'app', serviceMode: 'user',
                    relayRuntime: { channel, mode: 'user' },
                    personalHomeRelocation: { operationId: input.operationId, destinationMachineId: input.hostId,
                        sourceDescriptorRevision: input.sourceDescriptorRevision,
                        ...(input.recoveryAction ? { recoveryAction: input.recoveryAction } : {}) },
                }), assertCurrent);
            }, context.signal) };
        }
        if (request.actionId === 'relay.access.status') return { ok: true, result: await startTask(buildRelayAccessStatusSystemTaskSpec()) };
        if (request.actionId === 'relay.access.disable') return { ok: true, result: await startTask(buildRelayAccessDisableSystemTaskSpec()) };
        if (request.actionId === 'relay.access.configure') return { ok: true, result: await startTask(buildRelayAccessExecutionSystemTaskSpec(request.input)) };
        if (request.actionId === 'relay.runtime.personal_home.recover_restore') {
            return { ok: true, result: await startTask(buildLocalRelayRuntimeSystemTaskSpec('relay.runtime.personal_home.restore.v1', {
                ...request.input, personalHomeOperation: { action: 'recover' },
            })) };
        }
        const taskKind = (Object.keys(LOCAL_RELAY_RUNTIME_ACTION_IDS) as (keyof typeof LOCAL_RELAY_RUNTIME_ACTION_IDS)[])
            .find(kind => LOCAL_RELAY_RUNTIME_ACTION_IDS[kind] === request.actionId);
        if (!taskKind) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        return { ok: true, result: await startTask(
            buildLocalRelayRuntimeSystemTaskSpec(taskKind, request.input as LocalRelayRuntimeTaskOptions)) };
    };
}
