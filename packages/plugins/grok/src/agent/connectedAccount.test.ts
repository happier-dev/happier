import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  AgentAcpRuntimeOptions, AgentExecutionRunRuntime, AgentExecutionRunRuntimeContextV1,
  AgentRuntime, AgentSessionRuntime, AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate, PLUGIN_MANIFEST } from '../manifest.js';

let host: PluginTestkit;
let runtime: AgentRuntime;
beforeAll(async () => {
  host = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const factory = host.registration('agents', 'grok')?.factory;
  if (!factory) throw new Error('Grok Agent factory unavailable');
  runtime = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
    agent: { id: 'grok' }, signal: new AbortController().signal });
});
afterAll(async () => { await host?.dispose(); });

it.each(['subscription', 'api-key'] as const)('uses selected %s for registered Session create, resume and finite Run', async mode => {
  const selected: unknown[] = [];
  const observe = (options: AgentAcpRuntimeOptions) => selected.push(options.definition?.auth?.selectMethod?.({
    advertisedMethodIds: ['cached_token', 'xai.api_key'], initializeMetadata: { defaultAuthMethodId: 'xai.api_key' },
  }));
  const sessionBoundary: AgentSessionRuntime = {
    async send() { return { status: 'admitted' }; }, watch() { return { dispose() {} }; }, async dispose() {},
  };
  const runBoundary: AgentExecutionRunRuntime = {
    async send() { return { status: 'admitted' }; }, async stop() { return { status: 'notRunning' }; },
    watch() { return { dispose() {} }; }, async dispose() {},
  };
  // ACP transport is a host boundary; the registered plugin builds each real runtime definition.
  const context = {
    protocols: { acp: {
      async open(_request: unknown, options: AgentAcpRuntimeOptions) { observe(options); return sessionBoundary; },
      async openExecutionRunV1(_request: unknown, options: AgentAcpRuntimeOptions) { observe(options); return runBoundary; },
    } },
    services: { sessions: { current: null } },
    workState: { publisher: () => ({ publish: async () => ({ status: 'applied' }) }) },
  } as unknown as AgentSessionRuntimeContext;
  const sessions = runtime.sessions;
  const runs = sessions?.executionRunContextV1;
  if (!sessions || !runs) throw new Error('Grok Session and finite Run runtimes unavailable');
  const launchEnvironment = { values: { GROK_CONNECTED_ACCOUNT_MODE: mode, XAI_API_KEY: 'fake-ambient-c' }, unset: [] };
  await sessions.open({ kind: 'create', sessionId: 'fake-create', cwd: '/fake-workspace', launchEnvironment }, context);
  await sessions.open({ kind: 'resume', sessionId: 'fake-resume', cwd: '/fake-workspace',
    providerSessionId: 'fake-native-session', launchEnvironment }, context);
  await runs.open({ kind: 'create', runId: 'fake-run', cwd: '/fake-workspace',
    profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'grok' }, input: { text: 'fake finite request' }, launchEnvironment },
  context as unknown as AgentExecutionRunRuntimeContextV1);
  expect(selected).toEqual(Array.from({ length: 3 }, () => ({
    methodId: mode === 'subscription' ? 'cached_token' : 'xai.api_key', metadata: { headless: true },
  })));
});
