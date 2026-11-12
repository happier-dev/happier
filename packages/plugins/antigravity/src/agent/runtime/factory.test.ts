import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  AgentAcpRuntimeOptions, AgentExecutionRunRuntime, AgentExecutionRunRuntimeContextV1,
  AgentRuntime, AgentSessionRuntime, AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

let host: PluginTestkit;
let runtime: AgentRuntime;
beforeAll(async () => {
  host = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const factory = host.registration('agents', 'antigravity')?.factory;
  if (!factory) throw new Error('Antigravity Agent factory unavailable');
  runtime = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
    agent: { id: 'antigravity' }, signal: new AbortController().signal });
});
afterAll(async () => { await host?.dispose(); });

it.each([
  [{}, 'oauth-personal'],
  [{ GEMINI_API_KEY: 'fake-selected-key' }, 'gemini-api-key'],
] as const)('selects launch credentials on registered create, resume and finite Run (%j)', async (values, methodId) => {
  const selected: unknown[] = [];
  const observe = (options: AgentAcpRuntimeOptions) => {
    const auth = options.definition?.auth;
    if (!auth || !('selectMethod' in auth)) throw new Error('Missing launch selector');
    selected.push(auth.selectMethod({ advertisedMethodIds: ['oauth-personal', 'gemini-api-key'], initializeMetadata: null }));
  };
  const sessionBoundary: AgentSessionRuntime = {
    async send() { return { status: 'admitted' }; }, watch() { return { dispose() {} }; }, async dispose() {},
  };
  const runBoundary: AgentExecutionRunRuntime = {
    async send() { return { status: 'admitted' }; }, async stop() { return { status: 'notRunning' }; },
    watch() { return { dispose() {} }; }, async dispose() {},
  };
  // Host ACP transport is the boundary; plugin activation and per-launch selection stay real.
  const context = { protocols: { acp: {
    async open(_request: unknown, options: AgentAcpRuntimeOptions) { observe(options); return sessionBoundary; },
    async openExecutionRunV1(_request: unknown, options: AgentAcpRuntimeOptions) { observe(options); return runBoundary; },
  } } } as unknown as AgentSessionRuntimeContext;
  const sessions = runtime.sessions;
  const runs = sessions?.executionRunContextV1;
  if (!sessions || !runs) throw new Error('Registered runtimes unavailable');
  const launchEnvironment = { values, unset: [] };
  await sessions.open({ kind: 'create', sessionId: 'fake-create', cwd: '/fake-workspace', launchEnvironment }, context);
  await sessions.open({ kind: 'resume', sessionId: 'fake-resume', cwd: '/fake-workspace',
    providerSessionId: 'fake-native-session', launchEnvironment }, context);
  await runs.open({ kind: 'create', runId: 'fake-run', cwd: '/fake-workspace',
    profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'antigravity' }, input: { text: 'fake request' }, launchEnvironment },
  context as unknown as AgentExecutionRunRuntimeContextV1);
  expect(selected).toEqual(Array.from({ length: 3 }, () => ({ methodId })));
});
