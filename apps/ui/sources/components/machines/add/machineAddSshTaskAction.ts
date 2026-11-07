import { z } from 'zod/mini';
import { MachineAddSshStartInputSchema, MachineAddSshTaskInputSchema, MachineAddSshRespondInputSchema, MachineAddSshCancelInputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { areServerProfileIdentifiersEquivalent, buildHomeConnectionDescriptorForProfile, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import { buildSshCredentialsDraftFromRemoteHostConfig, resolveRemoteHostBootstrapRelayUrls } from '@/components/settings/remoteHosts/remoteHostOutcomeActions';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { withRemoteHostSshConfig } from '@/sync/ops/remoteHosts/remoteHostOperations';
import { startAdmittedRemoteHostSystemTask } from '@/components/settings/remoteHosts/remoteHostTaskOperations';
import { buildRemoteSshBootstrapFormStateFromSshConfig, resolveRemoteSshBootstrapFormState } from '@/components/onboarding/checklists/remoteSsh/resolveRemoteSshBootstrapFormState';
import { persistRemoteHostAfterRemoteSshCompletion } from '@/components/onboarding/checklists/remoteSsh/persistRemoteHostAfterRemoteSshCompletion';
import { readRemoteHostCatalogForOperationInContext } from '@/sync/api/account/apiRemoteHostCatalog';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { resolveRemoteSshBootstrapPrompt, type RemoteSshBootstrapFormState } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import { startRemoteSshBootstrapTask, continueRemoteSshBootstrapTask } from '@/components/systemTasks/remoteSshBootstrap/remoteSshBootstrapTask';
import { readMachineAddFlowDraft, updateMachineAddFlowDraft, type MachineAddTaskHandle, type MachineAddSshDraft } from './machineAddFlowStore';
import { beginMachineAddWatch, startMachineAddTask } from './machineAddTaskLifetime';
import { getMachineAddSshSupportedAuthModes } from './machineAddSshTask';
import { answerManagedCreationEstablish } from '@/components/settings/machines/managed/managedCreationPrompt';

const ResolutionSchema = z.object({
    hostTrust: z.optional(z.object({ kind: z.enum(['ssh.trustHost', 'ssh.replaceHostKey']), fingerprint: z.string(), existingFingerprint: z.optional(z.nullable(z.string())) })),
    authApproval: z.optional(z.object({ publicKey: z.string() })),
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
        if (context.expectedAccountId && context.expectedAccountId !== scope.accountId
            || context.runtimeAccountId && context.runtimeAccountId !== scope.accountId) return fail('action_account_scope_changed');
        const profile = getServerProfileById(serverId);
        if (!profile) return fail('target_unavailable');
        const retained = readMachineAddFlowDraft();
        const runner = runnerOverride ?? retained.sshTask?.runner ?? getSystemTasksRunner();
        if (!resolveSetupSurfacePolicy().machine.allowRemoteSshMachineSetup || runner.mode === 'unavailable'
            || (runner.mode === 'native' && runner.capabilities?.nativeSsh?.available === false)) return fail('machine_enroll_unavailable');
        const target = () => {
            const relay = resolveRemoteHostBootstrapRelayUrls(active);
            const descriptor = buildHomeConnectionDescriptorForProfile(profile);
            return { runner, relayUrl: relay?.relayUrl ?? profile.serverUrl,
                webappUrl: relay?.webappUrl ?? resolveWebappUrlFromServerUrl(profile.serverUrl), publicRelayUrl: relay?.publicRelayUrl ?? undefined,
                ...(descriptor ? { homeTarget: resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile',
                    profile: { id: profile.id, serverUrl: profile.serverUrl, webappUrl: resolveWebappUrlFromServerUrl(profile.serverUrl) } }) } : {}) };
        };
        const assertCurrent = () => {
            if (!areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)) throw new Error('action_account_scope_changed');
        };
        const enabled = (featureId: 'remoteHosts.management' | 'remoteHosts.secretMaterial') => resolveRuntimeFeatureDecisionFromSnapshot({
            featureId, settings: storage.getState().settings, snapshot: getCachedServerFeaturesSnapshot({ serverId }) ?? { status: 'loading' },
            scope: { scopeKind: 'spawn', serverId },
        })?.state === 'enabled';
        const runWithForm = async <T,>(submission: NonNullable<MachineAddTaskHandle['sshSubmission']>,
            run: (form: RemoteSshBootstrapFormState, startSpec: (spec: SystemTaskSpec) => Promise<string>, host?: RemoteHost) => Promise<T>): Promise<T> => {
            assertCurrent();
            const currentDraft = readMachineAddFlowDraft().sshDraft;
            // Only a present user's same-target password edit can amend private task custody.
            const presentUser = context.authority === 'present_user' && context.surface === 'ui';
            const sameTarget = submission.draft.savedHostId ? currentDraft.savedHostId === submission.draft.savedHostId
                : currentDraft.savedHostId === submission.draft.savedHostId && currentDraft.host === submission.draft.host
                    && currentDraft.username === submission.draft.username && currentDraft.port === submission.draft.port
                    && currentDraft.authMode === submission.draft.authMode;
            const draft = presentUser && sameTarget ? { ...submission.draft, password: currentDraft.password }
                : !presentUser && submission.draft.savedHostId ? { ...submission.draft, password: '', privateKeyMaterial: undefined } : submission.draft;
            if (draft.savedHostId) {
                if (submission.savedHostRevision === null) throw new Error('remote_host_catalog_unavailable');
                const account = await captureLazyActionAccountContext(serverId, context.signal);
                try {
                    if (account.accountId !== scope.accountId) throw new Error('action_account_scope_changed');
                    return await withRemoteHostSshConfig(account, { hostId: draft.savedHostId, expectedRevision: submission.savedHostRevision },
                        async ({ config, host, assertCurrent: assertHostCurrent }) => {
                            assertCurrent();
                            if (!getMachineAddSshSupportedAuthModes(runner).some(mode => mode === config.value.sshAuth)) throw new Error('ssh_auth_mode_unavailable');
                            const form = buildRemoteSshBootstrapFormStateFromSshConfig({ config: config.value, draft, installRelayRuntime: false });
                            return run(form, async spec => (await startAdmittedRemoteHostSystemTask({ runner, assertCurrent: () => {
                                assertCurrent(); assertHostCurrent();
                            }, assertAccountCurrent: assertCurrent }, spec)).taskId, host);
                        }, context.signal);
                } finally { account.dispose(); }
            }
            const form = await resolveRemoteSshBootstrapFormState({ draft, usingSavedHost: false, selectedSavedHost: null,
                privateKeyMaterialDraft: draft.privateKeyMaterial ?? '', saveSecretMaterial: false, installRelayRuntime: false,
                remoteHostsSecretMaterialEnabled: enabled('remoteHosts.secretMaterial') });
            return run(form, async spec => (await startAdmittedRemoteHostSystemTask({ runner, assertCurrent, signal: context.signal }, spec)).taskId);
        };
        if (actionId === 'machines.add.ssh.start') {
            const request = MachineAddSshStartInputSchema.parse(input);
            if (!areServerProfileIdentifiersEquivalent(request.serverId, serverId)) return fail('server_scope_mismatch');
            if ([retained.sshTask, retained.thisComputerTask].some((handle) => handle && (handle.starting || (handle.taskId && !handle.runner.getSnapshot(handle.taskId)?.result)))) return fail('machine_enroll_in_progress');
            if ('host' in request && !getMachineAddSshSupportedAuthModes(runner).some(mode => mode === request.authMode)) return fail('ssh_auth_mode_unavailable');
            const requestedDraft: MachineAddSshDraft = 'savedHostId' in request
                ? { ...createDefaultSshCredentialsDraft(), savedHostId: request.savedHostId }
                : { ...createDefaultSshCredentialsDraft(request.authMode), host: request.host, username: request.username,
                    port: request.port === undefined ? '' : String(request.port), identityFilePath: request.identityFilePath ?? '', savedHostId: null };
            const sameTarget = 'savedHostId' in request ? retained.sshDraft.savedHostId === request.savedHostId
                : retained.sshDraft.host.trim() === request.host && retained.sshDraft.username === request.username
                    && (retained.sshDraft.port.trim() ? Number(retained.sshDraft.port) : undefined) === request.port
                    && retained.sshDraft.authMode === request.authMode && retained.sshDraft.identityFilePath === (request.identityFilePath ?? '');
            // The normalized Action input captures identity once; SSH credential edits never select it.
            const submitted: MachineAddSshDraft = { ...(context.authority === 'present_user' && context.surface === 'ui' && sameTarget
                && retained.serverId !== null && areServerProfileIdentifiersEquivalent(retained.serverId, serverId) ? retained.sshDraft : requestedDraft),
                enrollmentIdentity: request.enrollmentIdentity };
            // Capture private task custody once, separately from the editable public draft.
            const submission = { draft: JSON.parse(JSON.stringify(submitted)) as MachineAddSshDraft,
                savedHostRevision: 'savedHostId' in request ? request.expectedHostRevision : null };
            const lifetime = captureActiveServerAccountScopeLifetime();
            let submittedHost: RemoteHost | undefined;
            let expectedRevision: number | 'absent' | null = submission.savedHostRevision;
            let managementEnabled = enabled('remoteHosts.management');
            const secretMaterialEnabled = enabled('remoteHosts.secretMaterial');
            const observeCompletion = (taskId: string) => {
                let settled = false;
                let unsubscribe: (() => void) | undefined;
                let retirement: Readonly<{ dispose(): void }> | undefined;
                const release = () => { unsubscribe?.(); retirement?.dispose(); };
                let passwordAnswered = false;
                const finish = () => {
                    const snapshot = runner.getSnapshot(taskId);
                    if (!submitted.savedHostId && submitted.password.trim() && !passwordAnswered
                        && resolveRemoteSshBootstrapPrompt(snapshot)?.kind === 'ssh.password' && lifetime?.isCurrent()
                        && areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)) {
                        passwordAnswered = true;
                        void runner.respond(taskId, { password: submitted.password.trim() }).catch(() => { passwordAnswered = false; });
                    }
                    const result = snapshot?.result;
                    if (!result || settled) return;
                    settled = true;
                    release();
                    if (!result.ok || !lifetime?.isCurrent() || expectedRevision === null
                        || !areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)) return;
                    const data: unknown = result.data;
                    const machineId = data && typeof data === 'object' && !Array.isArray(data) && 'machineId' in data && typeof data.machineId === 'string' ? data.machineId : null;
                    void persistRemoteHostAfterRemoteSshCompletion({ managementEnabled, secretMaterialEnabled,
                        scope, expectedRevision, host: submittedHost,
                        assertCurrent: () => { assertCurrent(); if (!lifetime.isCurrent()) throw new Error('action_account_scope_changed'); },
                        selectedSavedRemoteHostId: submitted.savedHostId ?? '__new__', newHostSentinelId: '__new__',
                        runContext: { selectedSavedRemoteHostId: submitted.savedHostId ?? '__new__', saveHost: true, saveSecretMaterial: false },
                        draft: submitted, privateKeyMaterialDraft: submitted.privateKeyMaterial ?? '', completion: { machineId, relayRuntimeUrl: null },
                    }).catch(() => {});
                };
                unsubscribe = runner.subscribe(taskId, finish);
                retirement = lifetime?.onRetire(() => {
                    release();
                    void runner.cancel(taskId).catch(() => {});
                });
                finish();
                if (settled) release();
                return release;
            };
            updateMachineAddFlowDraft((draft) => ({ ...draft, serverId, path: 'ssh', sshDraft: submitted }));
            const taskId = await startMachineAddTask('ssh', runner, async (isCurrent) => {
                context.signal?.throwIfAborted();
                if (!isCurrent() || !areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)) return null;
                if (managementEnabled && !submitted.savedHostId) {
                    const account = await captureLazyActionAccountContext(serverId, context.signal);
                    try {
                        if (account.accountId !== scope.accountId) throw new Error('action_account_scope_changed');
                        const catalog = await readRemoteHostCatalogForOperationInContext(account, context.signal);
                        expectedRevision = catalog.status === 'ready' ? catalog.revision : null;
                    } finally { account.dispose(); }
                }
                return runWithForm(submission, async (form, startSpec, host) => {
                    if (!isCurrent()) return null;
                    submittedHost = host;
                    if (host) managementEnabled = true; // The canonical saved-host reader has admitted this capability.
                    if (host) updateMachineAddFlowDraft(draft => ({ ...draft, sshDraft: { ...buildSshCredentialsDraftFromRemoteHostConfig({
                        sshTarget: host.ssh.target, sshPort: host.ssh.port ?? null, sshAuth: host.ssh.authMode,
                        identityFilePath: form.identityFilePath, identityPrivateKey: '', password: submitted.password, sshConfigFilePath: '',
                    }), savedHostId: host.id, enrollmentIdentity: submission.draft.enrollmentIdentity } }));
                    beginMachineAddWatch(serverId, 'ssh');
                    return startRemoteSshBootstrapTask({ ...target(), startSpec, enrollmentIdentity: submission.draft.enrollmentIdentity }, form);
                });
            }, observeCompletion, undefined, submission);
            return taskId ? { taskId } : fail(readMachineAddFlowDraft().sshTask ? 'machine_enroll_not_started' : 'cancelled');
        }
        const { taskId } = actionId === 'machines.add.ssh.cancel' ? MachineAddSshCancelInputSchema.parse(input)
            : MachineAddSshTaskInputSchema.parse(actionId === 'machines.add.ssh.respond'
                ? { taskId: MachineAddSshRespondInputSchema.parse(input).taskId } : input);
        const handle = retained.sshTask;
        if (!handle || !retained.serverId || !areServerProfileIdentifiersEquivalent(retained.serverId, serverId)) return fail('target_unavailable');
        if (!areAccountSettingsScopesEqual(handle.accountScope, scope)) return fail('action_account_scope_changed');
        if (actionId === 'machines.add.ssh.cancel' && !taskId) {
            if (!handle.starting || !handle.startPromise) return fail('target_unavailable');
            handle.unsubscribeCompletion?.();
            // The retained promise owner cancels a native id arriving after custody is released.
            updateMachineAddFlowDraft(draft => draft.sshTask !== handle ? draft : { ...draft, sshTask: null, startedAtMs: null, baseline: null });
            if (handle.taskId) {
                try { await handle.runner.cancel(handle.taskId); }
                catch { return fail('machine_enroll_cancel_failed'); }
            }
            return { pendingCanceled: true };
        }
        if (!taskId || handle.taskId !== taskId) return fail('target_unavailable');
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
                    ...('promptId' in prompt ? { promptId: prompt.promptId } : {}),
                    ...('administratorUsername' in prompt ? { administratorUsername: prompt.administratorUsername } : {}),
                    requiresPresentUser: prompt.kind === 'administrator.establish' || prompt.kind === 'ssh.password' && !handle.sshSubmission?.draft.savedHostId,
                }, machineId, errorCode: result && !result.ok ? result.error.code : null };
        }
        if (actionId === 'machines.add.ssh.cancel') {
            handle.unsubscribeCompletion?.();
            try { await handle.runner.cancel(taskId); }
            catch { return fail('machine_enroll_cancel_failed'); }
            updateMachineAddFlowDraft(draft => draft.sshTask !== handle ? draft : { ...draft, startedAtMs: null, baseline: null });
            return { taskId };
        }
        const { answer } = MachineAddSshRespondInputSchema.parse(input);
        if (!prompt || snapshot.cancelRequested) return fail('no_prompt');
        if (!handle.sshSubmission) return fail('machine_enroll_submission_unavailable');
        if (prompt.kind === 'ssh.password' && !handle.sshSubmission.draft.savedHostId && context.authority !== 'present_user') return fail('present_user_secret_required');
        if (answer.kind !== prompt.kind) return fail('prompt_mismatch');
        if (answer.kind === 'administrator.establish') {
            if (prompt.kind !== 'administrator.establish' || prompt.promptId !== answer.promptId || snapshot.result || !snapshot.awaitingInput) return fail('no_prompt');
            const isCurrent = () => {
                const current = handle.runner.getSnapshot(taskId);
                const pending = resolveRemoteSshBootstrapPrompt(current);
                return !context.signal?.aborted && readMachineAddFlowDraft().sshTask === handle && areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
                    && current?.awaitingInput === true && !current.result && !current.cancelRequested
                    && pending?.kind === 'administrator.establish' && pending.promptId === answer.promptId;
            };
            try {
                const response = await answerManagedCreationEstablish({ prompt, isCurrent,
                    respond: async password => { await handle.runner.respond(taskId, { password }); return { kind: 'completed', value: { taskId } }; },
                    decline: async () => { await handle.runner.cancel(taskId); return { kind: 'failed', code: 'cancelled' }; } });
                return response.kind === 'completed' ? { taskId } : fail(response.code);
            } catch { return fail('machine_enroll_response_failed'); }
        }
        if (answer.kind === 'ssh.password') {
            return runWithForm(handle.sshSubmission, async form => {
                const password = form.sshPassword.trim();
                if (!password) return fail('ssh_password_required');
                assertCurrent();
                try { await handle.runner.respond(taskId, { password }); }
                catch { return fail('machine_enroll_response_failed'); }
                return { taskId };
            });
        }
        const accepted = 'trusted' in answer ? answer.trusted : 'approved' in answer ? answer.approved
            : 'replaceExistingServices' in answer ? answer.replaceExistingServices : answer.switchDefaultReleaseChannel;
        const spec = handle.runner.getTaskSpec?.(taskId);
        const params = spec?.params;
        const resolution = ResolutionSchema.parse(params && typeof params === 'object' && !Array.isArray(params) && 'promptResolution' in params ? params.promptResolution ?? {} : {});
        const nextTaskId = await startMachineAddTask('ssh', handle.runner, async (isCurrent) => {
            if (!isCurrent() || !areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)) return null;
            return runWithForm(handle.sshSubmission!, async (form, startSpec) => (await continueRemoteSshBootstrapTask({
                options: { ...target(), runner: handle.runner, startSpec, enrollmentIdentity: handle.sshSubmission!.draft.enrollmentIdentity }, form,
                taskId, snapshot, prompt, resolution, accept: accepted })).taskId);
        }, handle.observeCompletion, handle);
        return nextTaskId ? { taskId: nextTaskId } : fail('machine_enroll_not_started');
    };
}
