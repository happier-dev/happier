import { describe, expect, it } from 'vitest';

import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentSessionNativeToolBridgeConfig, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { parsePluginManifest } from '../manifest.js';
import {
  externalOpenRequest,
  externalShellBridgeAgentDeclaration,
  resolveExternalHappierToolsBridge,
} from '../../fixtures/external-targeted-packages/agent-runtime-source.js';

describe('external Agent Happier tools bridge authoring', () => {
  it('admits the shell delivery declaration and carries the opaque host launch unchanged', async () => {
    let resolved: AgentSessionNativeToolBridgeConfig | undefined;
    const plugin = definePlugin({
      id: 'acme.shell-agent', version: '1.0.0',
      agents: {
        shell: {
          declaration: externalShellBridgeAgentDeclaration,
          factory: () => ({ sessions: { async open(request, context) {
            resolved = await resolveExternalHappierToolsBridge(request, context);
            return { async send() { return { status: 'admitted' as const }; },
              watch() { return { dispose() {} }; }, async dispose() {} };
          } } }),
          sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        },
      },
    });
    const parsed = parsePluginManifest(plugin.manifest);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes.agents[0]).toMatchObject({ capabilities: { tools: { delivery: 'shell_bridge' } } });
    const agent = { ...externalShellBridgeAgentDeclaration, id: 'shell' };
    expect(parsePluginManifest({ ...plugin.manifest, contributes: { ...plugin.manifest.contributes,
      agents: [{ ...agent, capabilities: { ...agent.capabilities,
        tools: { delivery: 'shell_bridge', bearer: 'synthetic-forged-authority' } } }],
    } }).ok).toBe(false);
    const activation = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    try {
      const factory = activation.registration('agents', 'shell')?.factory;
      if (!factory) throw new Error('External Agent was not registered');
      const signal = new AbortController().signal;
      const runtime = await factory({ plugin: { id: plugin.manifest.id, version: '1.0.0' },
        agent: { id: 'shell' }, signal });
      const bridge: AgentSessionNativeToolBridgeConfig = {
        v: 1, sessionId: externalOpenRequest.sessionId, directory: externalOpenRequest.cwd,
        systemPrompt: '', tools: [],
        launch: { executablePath: '/managed/happier', argsPrefix: ['tools', 'call', '--agent-bridge'],
          env: { OPAQUE_HOST_CONTEXT: 'synthetic-private-context' } },
      };
      // Host Session services are the genuine external boundary for an Agent plugin.
      const context = { signal, session: { id: externalOpenRequest.sessionId, services: {
        happierTools: { async resolveNativeBridge(
          request: Parameters<NonNullable<AgentSessionRuntimeContext['session']['services']['happierTools']>['resolveNativeBridge']>[0],
          options?: Parameters<NonNullable<AgentSessionRuntimeContext['session']['services']['happierTools']>['resolveNativeBridge']>[1],
        ) {
          expect(request.systemPrompt).toBe(externalOpenRequest.startupInstructions?.instructions);
          expect(options?.signal).toBe(signal);
          return bridge;
        } },
      } } } as unknown as AgentSessionRuntimeContext;
      const session = await runtime.sessions!.open(externalOpenRequest, context);
      expect(resolved).toBe(bridge);
      expect(resolved?.launch.env).toBe(bridge.launch.env);
      await session.dispose();
    } finally { await activation.dispose(); }
  });
});
