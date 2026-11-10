import { describe, expect, it } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { openCodexNativeAppServerSession } from './native.js';
import { prepareCodexConnectedAccountKeyRequest } from '../connectedAccountKeys.js';

const configuration = {
  mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
  permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {},
  allowedTools: ['mcp__wilson-intake__*'], unlistedTools: 'deny',
} as const;

describe('Codex tool restriction launch boundaries', () => {
  it('refuses a selected key before attaching to an already-running server with another upstream', async () => {
    const request = prepareCodexConnectedAccountKeyRequest({
      kind: 'resume' as const, sessionId: 'selected-key-proxy', cwd: '/workspace', providerSessionId: 'thread-1',
      connectedAccounts: [{ purpose: 'kimi-code-api-key', account: {
        service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, accountId: 'selected' } }],
      launchEnvironment: { values: { KIMI_API_KEY: 'fake-key', KIMI_CODE_BASE_URL: 'https://api.kimi.com/coding/v1' }, unset: [] },
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: 'kimi-for-coding', updatedAtMs: 0 },
        permissionIntent: { value: 'default' as const, updatedAtMs: 0 }, options: {} },
      runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: {
        backendMode: 'appServer', providerSessionId: 'thread-1', appServerTransport: 'daemonProxy',
      } },
    });
    await expect(openCodexNativeAppServerSession(request, {} as AgentSessionRuntimeContext))
      .rejects.toMatchObject({ code: 'agent_startup_transport_failed', retryable: false });
  });

  it('refuses a proxy whose already-running server cannot receive the confinement overrides', async () => {
    // The refusal must precede any process/host service access.
    const unavailableContext = {} as AgentSessionRuntimeContext;
    await expect(openCodexNativeAppServerSession({
      kind: 'resume', sessionId: 'restricted', cwd: '/workspace', providerSessionId: 'thread-1',
      configuration,
      runtimeDescriptorV1: {
        v: 1, agentId: 'codex', agent: {
          backendMode: 'appServer', providerSessionId: 'thread-1', appServerTransport: 'daemonProxy',
        },
      },
    }, unavailableContext)).rejects.toMatchObject({ code: 'codex_tool_restriction_unsupported_transport',
      diagnostic: { code: 'codex_tool_restriction_unsupported_transport', severity: 'error' } });
  });

});
