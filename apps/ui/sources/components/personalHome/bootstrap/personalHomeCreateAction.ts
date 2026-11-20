import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import { buildRemoteSshBootstrapFormStateFromSshConfig, resolveRemoteSshBootstrapFormState } from '@/components/onboarding/checklists/remoteSsh/resolveRemoteSshBootstrapFormState';
import { startAdmittedRemoteHostSystemTask } from '@/components/settings/remoteHosts/remoteHostTaskOperations';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import { resolveRemoteRelayCompletionUrl, startRemoteSshBootstrapTask } from '@/components/systemTasks/remoteSshBootstrap/remoteSshBootstrapTask';
import { createSshSystemTaskPromptContinuation } from '@/components/systemTasks/ssh/answerSshSystemTaskPrompt';
import type { RemoteSshBootstrapFormState } from '@/components/systemTasks/remoteSshBootstrap/useRemoteSshBootstrapTask';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { canSetUpPersonalHomeOverSsh } from '@/sync/domains/server/setup/setupSurfacePolicy';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { settleClientSystemTaskAction } from '@/sync/ops/actions/systemTaskActionSettlement';
import { withRemoteHostSshConfig } from '@/sync/ops/remoteHosts/remoteHostOperations';
import { requestMountedPersonalHomeBootstrap } from './personalHomeBootstrapRequest';

/** Delivers an approved request to the setup owners on the answering desktop. */
export function createPersonalHomeCreateAction(account: LazyActionAccountContext, runnerOverride?: SystemTaskRunner): NonNullable<ActionExecutorDeps['personalHomeCreate']> {
    return async (input, context) => {
        const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (account.credentialAuthorityKind !== 'account' || !lifetime || !areServerAccountScopesEqual(lifetime.scope, account.accountLifetime.scope)) {
            return fail('active_home_required');
        }
        const assertCurrent = () => {
            account.assertAccountCurrent();
            if (!lifetime.isCurrent()) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        };
        context.signal?.throwIfAborted();
        assertCurrent();
        if (input.method === 'this_computer') {
            return requestMountedPersonalHomeBootstrap() ? { status: 'setup_started' } : fail('personal_home_setup_unavailable');
        }

        if (!canSetUpPersonalHomeOverSsh()) return fail('personal_home_setup_unavailable');
        const runner = runnerOverride ?? getSystemTasksRunner();
        if (runner.mode !== 'tauri') return fail('personal_home_setup_unavailable');
        const start = (form: RemoteSshBootstrapFormState, assertTargetCurrent = assertCurrent) => startRemoteSshBootstrapTask({
            runner, relayUrl: account.endpointUrl, intent: 'personalHome.create',
            startSpec: async spec => (await startAdmittedRemoteHostSystemTask({ runner, assertCurrent: assertTargetCurrent, assertAccountCurrent: assertCurrent,
                signal: context.signal, accountScope: lifetime.scope }, spec)).taskId,
        }, form);
        const taskId = 'savedHostId' in input
            ? await withRemoteHostSshConfig(account, { hostId: input.savedHostId, expectedRevision: input.expectedHostRevision },
                ({ config, assertCurrent: assertHostCurrent }) => start(buildRemoteSshBootstrapFormStateFromSshConfig({
                    config: config.value, draft: createDefaultSshCredentialsDraft(), installRelayRuntime: true,
                }), assertHostCurrent), context.signal)
            : await start(await resolveRemoteSshBootstrapFormState({
                draft: { ...createDefaultSshCredentialsDraft(input.authMode), host: input.host, username: input.username ?? '',
                    port: input.port?.toString() ?? '', identityFilePath: input.identityFilePath ?? '' },
                usingSavedHost: false, selectedSavedHost: null, privateKeyMaterialDraft: '', saveSecretMaterial: false,
                installRelayRuntime: true, remoteHostsSecretMaterialEnabled: false,
            }));
        runner.registerPromptContinuation?.(taskId, createSshSystemTaskPromptContinuation(runner, taskId, lifetime.isCurrent));
        const settled = await settleClientSystemTaskAction(runner, { status: 'task_started', taskId }, context, assertCurrent);
        if (settled.status === 'unavailable') return fail(settled.reason);
        if (settled.status !== 'completed') return settled;
        if (!settled.result.ok) return fail(settled.result.error.code);
        return { status: 'created', address: resolveRemoteRelayCompletionUrl(settled.result) };
    };
}
