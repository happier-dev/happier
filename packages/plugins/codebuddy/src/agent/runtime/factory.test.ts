import { describe, expect, it } from 'vitest';
import type { AgentAcpRuntimeOptions, AgentRuntimeContext, AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
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
