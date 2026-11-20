import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import { resolveRemoteSshBootstrapFormState } from '@/components/onboarding/checklists/remoteSsh/resolveRemoteSshBootstrapFormState';
import { startAdmittedRemoteHostSystemTask } from '@/components/settings/remoteHosts/remoteHostTaskOperations';
import { createDefaultSshCredentialsDraft } from '@/components/ssh/sshCredentialsDraft';
import { resolveRemoteRelayCompletionUrl, startRemoteSshBootstrapTask } from '@/components/systemTasks/remoteSshBootstrap/remoteSshBootstrapTask';
import { createSshSystemTaskPromptContinuation } from '@/components/systemTasks/ssh/answerSshSystemTaskPrompt';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { canSetUpPersonalHomeOverSsh } from '@/sync/domains/server/setup/setupSurfacePolicy';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { settleClientSystemTaskAction } from '@/sync/ops/actions/systemTaskActionSettlement';
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
        const form = await resolveRemoteSshBootstrapFormState({
            draft: { ...createDefaultSshCredentialsDraft(), host: input.host, username: input.username ?? '', port: input.port?.toString() ?? '' },
            usingSavedHost: false, selectedSavedHost: null, privateKeyMaterialDraft: '', saveSecretMaterial: false,
            installRelayRuntime: true, remoteHostsSecretMaterialEnabled: false,
        });
        const taskId = await startRemoteSshBootstrapTask({ runner, relayUrl: account.endpointUrl, intent: 'personalHome.create',
            startSpec: async spec => (await startAdmittedRemoteHostSystemTask({ runner, assertCurrent,
                signal: context.signal, accountScope: lifetime.scope }, spec)).taskId,
        }, form);
        runner.registerPromptContinuation?.(taskId, createSshSystemTaskPromptContinuation(runner, taskId, lifetime.isCurrent));
        const settled = await settleClientSystemTaskAction(runner, { status: 'task_started', taskId }, context, assertCurrent);
        if (settled.status === 'unavailable') return fail(settled.reason);
        if (settled.status !== 'completed') return settled;
        if (!settled.result.ok) return fail(settled.result.error.code);
        return { status: 'created', address: resolveRemoteRelayCompletionUrl(settled.result) };
    };
}
