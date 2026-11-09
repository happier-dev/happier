import { describe, expect, it, vi } from 'vitest';
import type { AgentAcpRuntimeOptions, AgentRuntimeContext, AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { CODEBUDDY_PLUGIN } from '../../manifest.js';
import { createCodeBuddyAgentRuntime } from './factory.js';

async function resolver() {
  let options: AgentAcpRuntimeOptions | undefined;
  const runtime: AgentSessionRuntime = {
    async send() { return { status: 'admitted' }; }, watch() { return { dispose() {} }; }, async dispose() {},
  };
  // The ACP host and connected-account service are external boundaries to this plugin leaf.
  const context = { services: { connectedAccounts: { getBinding: async () => null } },
    protocols: { acp: { open: async (_request: AgentSessionOpenRequest, value: AgentAcpRuntimeOptions) => {
      options = value; return runtime;
    } } } } as unknown as AgentRuntimeContext;
  await createCodeBuddyAgentRuntime().sessions!.open({ kind: 'create', cwd: '/repo',
    profile: { pluginId: 'happier.agent.codebuddy', localId: 'codebuddy' } }, context);
  return options?.definition?.toolNameResolver;
}

describe('CodeBuddy native deferred tool codec', () => {
  it('unwraps only transport-proven deferred calls and keeps the inner task operation', async () => {
    const resolve = await resolver();
    const request = { toolName: 'other', toolCallId: 'call', context: { toolCallCountSincePrompt: 0 },
      input: { toolName: 'TaskList', params: {}, _acp: { kind: 'other', title: 'DeferExecuteTool' } } };
    expect(resolve?.(request)).toEqual({ toolName: 'TaskList', input: {} });
    expect(resolve?.({ ...request, input: { ...request.input, toolName: 'Bash', params: { command: 'pwd' } } }))
      .toEqual({ toolName: 'Bash', input: { command: 'pwd' } });
    expect(resolve?.({ ...request, toolName: 'mcp__fixture__save_record' })).toBeNull();
    expect(resolve?.({ ...request, input: { ...request.input, _acp: { kind: 'other', title: 'Save record' } } })).toBeNull();
    expect(resolve?.({ ...request, input: { ...request.input, toolName: '' } })).toBeNull();
  });
});

describe('CodeBuddy selected account default', () => {
  it('uses the same model refusal for selected-account preflight before materialization', async () => {
    const activation = await createPluginTestkit({ manifest: CODEBUDDY_PLUGIN.manifest, module: CODEBUDDY_PLUGIN });
    const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'selected' };
    const materialize = vi.fn(async () => { throw new Error('Model selection must precede credential acquisition'); });
    const getBinding = vi.fn<ConnectedAccountsService['getBinding']>(async () => ({ account, service: account.service,
      purpose: 'openai-codex-model-request', target: { kind: 'account' as const, displayName: 'Selected' } }));
    try {
      const prepare = activation.registration('agents', 'codebuddy')?.preflightSessionControls?.prepareLaunchEnvironment;
      expect(prepare).toBeTypeOf('function');
      if (!prepare) throw new Error('Missing native account preparation');
      const input = { environment: { CODEBUDDY_API_KEY: 'ambient' },
        connectedAccounts: { getBinding, materialize, watch: () => ({ dispose() {} }) }, signal: new AbortController().signal };
      await expect(prepare(input)).rejects.toMatchObject({ code: 'model_selection_required' });
      expect(materialize).not.toHaveBeenCalled();
      getBinding.mockResolvedValueOnce(null);
      const native = await prepare(input);
      expect(native.environment).toEqual(input.environment);
      await native.dispose();
    } finally { await activation.dispose(); }
  });

  it.each([
    { value: null, selectionSource: 'explicit' as const },
    { value: 'foreign-model', selectionSource: 'inherited' as const },
  ])('requires a deliberate account model before native effects ($selectionSource)', async model => {
    const activation = await createPluginTestkit({ manifest: CODEBUDDY_PLUGIN.manifest, module: CODEBUDDY_PLUGIN });
    const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'selected' };
    const materialize = vi.fn(async () => { throw new Error('Model selection must precede credential acquisition'); });
    const open = vi.fn(async () => { throw new Error('Model selection must precede native startup'); });
    const context = { services: { connectedAccounts: { getBinding: async () => ({ account, service: account.service,
      purpose: 'openai-codex-model-request', target: { kind: 'account', displayName: 'Selected' } }), materialize } },
      protocols: { acp: { open } } } as unknown as AgentRuntimeContext;
    try {
      const factory = activation.registration('agents', 'codebuddy')?.factory;
      if (!factory) throw new Error('Missing CodeBuddy runtime');
      const runtime = await factory({ plugin: { id: CODEBUDDY_PLUGIN.manifest.id, version: '0.0.0' },
        agent: { id: 'codebuddy' }, signal: new AbortController().signal });
      await expect(runtime.sessions!.open({ kind: 'create', sessionId: 'default-model', cwd: '/repo', configuration: {
        mode: { value: null, updatedAtMs: 0 }, model: { ...model, updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
      } }, context)).rejects.toMatchObject({ code: 'model_selection_required' });
      expect(materialize).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally { await activation.dispose(); }
  });
});
