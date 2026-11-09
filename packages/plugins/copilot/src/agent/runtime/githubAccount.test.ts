import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { COPILOT_AUTH_ENV_VARS } from '../auth/services/copilotAuth.js';
import { COPILOT_PROVIDER_OWNED_ENV_KEYS } from '../providerBinding.js';
import { prepareCopilotConnectedAccount } from './connectedAccount.js';
import { createCopilotAgentRuntime } from './factory.js';
import { materializeGithubCredential } from '../../../../scm-github/src/auth/credentialMaterialization.js';

const service = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };
const account = { service, accountId: 'selected-github' };
const signal = new AbortController().signal;
const request = {
  kind: 'create' as const, sessionId: 'copilot-github', cwd: '/workspace',
  configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: 'native-model', updatedAtMs: 1 },
    permissionIntent: { value: 'read-only' as const, updatedAtMs: 1 }, options: {} },
  launchEnvironment: { values: {
    PATH: '/bin', ...Object.fromEntries([...COPILOT_AUTH_ENV_VARS, ...COPILOT_PROVIDER_OWNED_ENV_KEYS]
      .map(key => [key, `competing-${key}`])),
  }, unset: ['UNRELATED'] },
};

function fixture(purposes: readonly string[] = ['github-copilot']) {
  // Connected Accounts and ACP are host service/process boundaries; internal selection remains real.
  const materializationContext = { account, signal, services: {},
    configuration: { target: { kind: 'account', account, modeId: 'copilot-token' }, revision: 'config-1', values: {}, async getSecret() { return null; } },
    credentials: { async get(key: string) { return key === 'token' ? 'gho_selected-fake-token' : null; } },
  } as Parameters<typeof materializeGithubCredential>[1];
  const materialize = vi.fn<ConnectedAccountsService['materialize']>(async (_purpose, request, options) => (
    materializeGithubCredential(request, materializationContext, options)
  ));
  const context = { signal, services: { connectedAccounts: {
    getBinding: async (purpose: string) => purposes.includes(purpose)
      ? { purpose, service, account, target: { kind: 'account', displayName: 'GitHub' } } : null,
    materialize,
  } } } as unknown as AgentSessionRuntimeContext;
  return { context, materialize };
}

describe('Copilot selected native GitHub account', () => {
  it('materializes only the selected purpose and removes inherited GitHub and BYOK inputs', async () => {
    const { context, materialize } = fixture();
    const prepared = await prepareCopilotConnectedAccount(request, context);
    expect(prepared.request.launchEnvironment?.values).toEqual({ PATH: '/bin', COPILOT_GITHUB_TOKEN: 'gho_selected-fake-token' });
    expect(prepared.request.launchEnvironment?.unset).toEqual(expect.arrayContaining([
      'UNRELATED', 'GH_TOKEN', 'GITHUB_TOKEN', ...COPILOT_PROVIDER_OWNED_ENV_KEYS,
    ]));
    expect(prepared.request.launchEnvironment?.unset).not.toContain('COPILOT_GITHUB_TOKEN');
    // The host has any number of unrelated SCM accounts; launch acquires only its admitted selection.
    expect(materialize.mock.calls).toEqual([['github-copilot', { kind: 'environment', keys: ['COPILOT_GITHUB_TOKEN'] },
      { signal, expectedAccount: account }]]);
    expect(prepared.models).toBeUndefined();
  });

  it('rejects incompatible explicit purposes before acquiring either credential', async () => {
    const { context, materialize } = fixture(['github-copilot', 'openai-codex']);
    await expect(prepareCopilotConnectedAccount(request, context)).rejects.toMatchObject({ code: 'copilot_account_provider_conflict' });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('rejects an explicit Provider route before acquiring GitHub credentials', async () => {
    const { context, materialize } = fixture();
    await expect(prepareCopilotConnectedAccount({ ...request, providerBinding: {} as never }, context))
      .rejects.toMatchObject({ code: 'copilot_account_provider_conflict' });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('propagates native materialization refusal without falling back to inherited credentials', async () => {
    const { context, materialize } = fixture();
    const refusal = new Error('synthetic selected credential refusal');
    materialize.mockRejectedValueOnce(refusal);
    await expect(prepareCopilotConnectedAccount(request, context)).rejects.toBe(refusal);
  });

  it('refuses missing selected material instead of opening with ambient authentication', async () => {
    const { context, materialize } = fixture();
    materialize.mockResolvedValueOnce({ kind: 'environment', env: {} });
    await expect(prepareCopilotConnectedAccount(request, context))
      .rejects.toMatchObject({ code: 'copilot_account_materialization_unavailable' });
  });

  it('surfaces a native seat refusal without changing the GitHub account', async () => {
    const { context: hostContext } = fixture();
    const refusal = new Error('Copilot subscription required by the organization');
    const open = vi.fn(async () => { throw refusal; });
    const context = { ...hostContext, protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext;
    const runtime = await createCopilotAgentRuntime({} as never);
    await expect(runtime.sessions.open(request, context)).rejects.toBe(refusal);
    expect(await context.services.connectedAccounts.getBinding('github-copilot')).toMatchObject({ account });
  });

  it('preserves native-default launch inputs when neither purpose is selected', async () => {
    const { context, materialize } = fixture([]);
    expect((await prepareCopilotConnectedAccount(request, context)).request).toBe(request);
    expect(materialize).not.toHaveBeenCalled();
  });

  it('uses the same native preparation for create, resume, finite and retained work', async () => {
    const { context: hostContext, materialize } = fixture();
    const open = vi.fn(async () => ({ dispose: async () => {} }));
    const context = { ...hostContext, protocols: {
      acp: { open, openExecutionRunV1: open, openExecutionRunConversationV1: open },
    } } as unknown as AgentSessionRuntimeContext;
    const runtime = await createCopilotAgentRuntime({} as never);
    await runtime.sessions.open(request, context);
    await runtime.sessions.open({ ...request, kind: 'resume', providerSessionId: 'native-session' }, context);
    await runtime.sessions.executionRunContextV1!.open({ ...request, executionRunId: 'finite-run' }, context);
    await runtime.sessions.executionRunContextV1!.openConversation!({ ...request, executionRunId: 'retained-run' }, context);
    expect(materialize).toHaveBeenCalledTimes(4);
    expect(open).toHaveBeenCalledTimes(4);
    for (const [prepared] of open.mock.calls as unknown as Array<[typeof request]>) {
      expect(prepared.launchEnvironment.values).toEqual({ PATH: '/bin', COPILOT_GITHUB_TOKEN: 'gho_selected-fake-token' });
    }
  });
});
