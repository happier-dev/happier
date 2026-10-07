import { z } from 'zod';
import { MachineAddSshStartInputSchema, MachineAddSshTaskInputSchema, MachineAddSshRespondInputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { areServerProfileIdentifiersEquivalent, buildHomeConnectionDescriptorForProfile, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import { resolveRemoteHostBootstrapRelayUrls } from '@/components/settings/remoteHosts/remoteHostOutcomeActions';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { resolveRemoteSshBootstrapPrompt, type RemoteSshBootstrapFormState } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import { startRemoteSshBootstrapTask, continueRemoteSshBootstrapTask } from '@/components/systemTasks/remoteSshBootstrap/remoteSshBootstrapTask';
import { readMachineAddFlowDraft, updateMachineAddFlowDraft } from './machineAddFlowStore';
import { beginMachineAddWatch, startMachineAddTask } from './machineAddTaskLifetime';

const ResolutionSchema = z.object({
    hostTrust: z.object({ kind: z.enum(['ssh.trustHost', 'ssh.replaceHostKey']), fingerprint: z.string(), existingFingerprint: z.string().nullable().optional() }).optional(),
    authApproval: z.object({ publicKey: z.string() }).optional(),
});

/** Actions consume the existing retained draft and system task, never a parallel task registry. */
export function createMachineAddSshTaskAction(runnerOverride?: SystemTaskRunner): NonNullable<ActionExecutorDeps['machineAddSshTaskAction']> {
    return async (actionId, input, context) => {
        const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
        const active = getActiveServerSnapshot();
        const serverId = context.serverId ?? active.serverId;
        const scope = storage.getState().settingsScope;
        if (!scope || !scope.accountId || !areServerProfileIdentifiersEquivalent(serverId, active.serverId)
            || !areServerProfileIdentifiersEquivalent(scope.serverId, serverId)) return fail('active_home_required');
        const profile = getServerProfileById(serverId);
        if (!profile) return fail('target_unavailable');
        const retained = readMachineAddFlowDraft();
        const runner = runnerOverride ?? retained.sshTask?.runner ?? getSystemTasksRunner();
        if (!resolveSetupSurfacePolicy().machine.allowRemoteSshMachineSetup || runner.mode === 'unavailable'
            || (runner.mode === 'native' && runner.capabilities?.nativeSsh?.available === false)) return fail('machine_setup_unavailable');
        const target = () => {
            const relay = resolveRemoteHostBootstrapRelayUrls(active);
            const descriptor = buildHomeConnectionDescriptorForProfile(profile);
            return { runner, relayUrl: relay?.relayUrl ?? profile.serverUrl,
                webappUrl: relay?.webappUrl ?? resolveWebappUrlFromServerUrl(profile.serverUrl), publicRelayUrl: relay?.publicRelayUrl ?? undefined,
                ...(descriptor ? { homeTarget: resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile',
                    profile: { id: profile.id, serverUrl: profile.serverUrl, webappUrl: resolveWebappUrlFromServerUrl(profile.serverUrl) } }) } : {}) };
        };
        const form = (): RemoteSshBootstrapFormState => {
            const draft = readMachineAddFlowDraft().sshDraft;
            return { sshHost: draft.host, sshUsername: draft.username, sshPort: draft.port, sshAuth: draft.authMode,
                sshPassword: draft.password, identityFilePath: draft.identityFilePath, identityPrivateKey: draft.privateKeyMaterial ?? '', installRelayRuntime: false };
        };
        if (actionId === 'machines.add.ssh.start') {
            const request = MachineAddSshStartInputSchema.parse(input);
            if (!areServerProfileIdentifiersEquivalent(request.serverId, serverId)) return fail('server_scope_mismatch');
            if ([retained.sshTask, retained.thisComputerTask].some((handle) => handle && (handle.starting || (handle.taskId && !handle.runner.getSnapshot(handle.taskId)?.result)))) return fail('machine_setup_in_progress');
            updateMachineAddFlowDraft((draft) => ({ ...draft, serverId, path: 'ssh',
                sshDraft: { ...createDefaultSshCredentialsDraft(request.authMode), host: request.host, username: request.username,
                    port: request.port === undefined ? '' : String(request.port), identityFilePath: request.identityFilePath ?? '' } }));
            const taskId = await startMachineAddTask('ssh', runner, async (isCurrent) => {
                context.signal?.throwIfAborted();
                if (!isCurrent() || !areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)) return null;
                beginMachineAddWatch(serverId, 'ssh');
                return startRemoteSshBootstrapTask(target(), form());
            });
            return taskId ? { taskId } : fail('machine_setup_not_started');
        }
        const { taskId } = MachineAddSshTaskInputSchema.parse(actionId === 'machines.add.ssh.respond'
            ? { taskId: MachineAddSshRespondInputSchema.parse(input).taskId } : input);
        const handle = retained.sshTask;
        if (!handle || handle.taskId !== taskId || !retained.serverId || !areServerProfileIdentifiersEquivalent(retained.serverId, serverId)) return fail('target_unavailable');
        if (!areAccountSettingsScopesEqual(handle.accountScope, scope)) return fail('action_account_scope_changed');
        const snapshot = handle.runner.getSnapshot(taskId);
        if (!snapshot) return fail('target_unavailable');
        const prompt = resolveRemoteSshBootstrapPrompt(snapshot);
        if (actionId === 'machines.add.ssh.status') {
            const result = snapshot.result;
            const data = result?.ok ? result.data : null;
            const machineId = data && typeof data === 'object' && !Array.isArray(data) && 'machineId' in data && typeof data.machineId === 'string' ? data.machineId : null;
            return { taskId, status: snapshot.status, currentStepId: snapshot.currentStepId, awaitingInput: prompt !== null && !snapshot.cancelRequested,
                prompt: snapshot.cancelRequested || !prompt ? null : {
                    kind: prompt.kind, message: prompt.message,
                    ...('fingerprint' in prompt ? { fingerprint: prompt.fingerprint } : {}),
                    ...('existingFingerprint' in prompt ? { existingFingerprint: prompt.existingFingerprint } : {}),
                    ...('target' in prompt ? { target: prompt.target } : {}),
                    ...('publicKey' in prompt ? { publicKey: prompt.publicKey } : {}),
                    requiresPresentUser: prompt.kind === 'ssh.password' || prompt.kind === 'auth.approveRemoteProvisioning'
                        || prompt.kind === 'daemon.replaceRemoteBackgroundServices' || prompt.kind === 'releaseChannel.switchDefaultForSetup',
                }, machineId, errorCode: result && !result.ok ? result.error.code : null };
        }
        if (actionId === 'machines.add.ssh.cancel') { await handle.runner.cancel(taskId); return { taskId }; }
        const { answer } = MachineAddSshRespondInputSchema.parse(input);
        if (!prompt || snapshot.cancelRequested) return fail('no_prompt');
        if (prompt.kind === 'ssh.password') return fail('present_user_secret_required');
        if ((prompt.kind === 'auth.approveRemoteProvisioning' || prompt.kind === 'daemon.replaceRemoteBackgroundServices'
            || prompt.kind === 'releaseChannel.switchDefaultForSetup') && context.authority !== 'present_user') return fail('present_user_required');
        if (answer.kind !== prompt.kind) return fail('prompt_mismatch');
        const accepted = 'trusted' in answer ? answer.trusted : 'approved' in answer ? answer.approved
            : 'replaceExistingServices' in answer ? answer.replaceExistingServices : answer.switchDefaultReleaseChannel;
        const spec = handle.runner.getTaskSpec?.(taskId);
        const params = spec?.params;
        const resolution = ResolutionSchema.parse(params && typeof params === 'object' && !Array.isArray(params) && 'promptResolution' in params ? params.promptResolution ?? {} : {});
        const nextTaskId = await startMachineAddTask('ssh', handle.runner, async (isCurrent) => {
            if (!isCurrent() || !areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)) return null;
            return (await continueRemoteSshBootstrapTask({ options: { ...target(), runner: handle.runner }, form: form(),
                taskId, snapshot, prompt, resolution, accept: accepted })).taskId;
        }, handle.observeCompletion, handle);
        return nextTaskId ? { taskId: nextTaskId } : fail('machine_setup_not_started');
    };
}
