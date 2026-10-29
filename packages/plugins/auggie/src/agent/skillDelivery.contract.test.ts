import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentAcpRuntimeOptions, AgentExecutionRunOpenRequest, AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeContextV1, AgentRuntime, AgentSessionOpenRequest,
  AgentSessionRuntime, AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  createAgentLaunchObserver, createPluginTestkit, runAgentSkillDeliveryContract,
  type AgentLaunchObserverBoundaries, type PluginTestkit,
} from '@happier-dev/plugin-sdk/testing';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { activate } from '../activate.js';

let home: string;
let observer: ReturnType<typeof createAgentLaunchObserver>;
let host: PluginTestkit;
let agentRuntime: AgentRuntime;
let observedRequest: AgentSessionOpenRequest | AgentExecutionRunOpenRequest;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'happier-auggie-skill-home-'));
  for (const root of ['.augment', '.agents', '.claude']) {
    await mkdir(join(home, root, 'skills'), { recursive: true });
    await writeFile(join(home, root, 'skills', 'retained-native-file'), root);
  }
  observer = createAgentLaunchObserver({ home });
  host = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const factory = host.registration('agents', 'auggie')?.factory;
  if (!factory) throw new Error('Auggie Agent factory is missing.');
  agentRuntime = await factory({
    plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
    agent: { id: 'auggie' }, signal: new AbortController().signal,
  });
});
afterAll(async () => {
  try { await host?.dispose(); }
  finally { if (home) await rm(home, { recursive: true, force: true }); }
});

function recordOpen(request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest, options: AgentAcpRuntimeOptions) {
  observedRequest = request;
  if (options.transport.kind !== 'stdio') throw new Error('Expected Auggie stdio transport.');
  const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
  const env: Record<string, string | undefined> = { HOME: home, ...request.launchEnvironment?.values };
  for (const key of request.launchEnvironment?.unset ?? []) delete env[key];
  boundaries.recordLaunch({ argv: options.transport.args ?? [], env: { ...env, ...options.transport.env } });
}

// The ACP host service is outside the plugin leaf. No plugin logic is replaced.
const configuration = { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
  permissionIntent: { value: 'default' as const, updatedAtMs: 0 }, options: {} };
const sessionBoundary: AgentSessionRuntime = {
  skillsDelivered: false,
  async send() { return { status: 'admitted' }; },
  watch() { return { dispose() {} }; },
  async dispose() {},
};
const runBoundary: AgentExecutionRunRuntime = {
  async send() { return { status: 'admitted' }; },
  async stop() { return { status: 'notRunning' }; },
  watch() { return { dispose() {} }; },
  async dispose() {},
};
// This boundary fixture supplies only the host services used while opening the leaf.
const context = {
  protocols: { acp: {
    async open(request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) {
      recordOpen(request, options);
      return sessionBoundary;
    },
    async openExecutionRunV1(request: AgentExecutionRunOpenRequest, options: AgentAcpRuntimeOptions) {
      recordOpen(request, options);
      return runBoundary;
    },
  } },
  services: { sessions: { current: null } },
  workState: { publisher: () => ({ publish: async () => ({ status: 'applied' }) }) },
} as unknown as AgentSessionRuntimeContext;

async function openSession(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
  if (!agentRuntime.sessions) throw new Error('Expected Auggie Session runtime.');
  (observer.boundaries as AgentLaunchObserverBoundaries).reset();
  return await agentRuntime.sessions.open({ ...request, configuration: request.configuration ?? configuration }, context);
}
const agent = PLUGIN_MANIFEST.contributes.agents.find((candidate) => candidate.id === 'auggie');
if (!agent) throw new Error('Auggie Agent contribution is missing.');
runAgentSkillDeliveryContract({
  agent, openSession, observeLaunch: () => observer.observeLaunch(),
  variants: [
    { id: 'resume', open: request => openSession({ ...request, kind: 'resume', providerSessionId: 'auggie-checkpoint' }), expect: 'delivers' },
  ],
});

describe('Auggie detached Run skills declaration', () => {
  it('K10 delivers skills through the actual registered Run leaf', async () => {
    const openRun = agentRuntime.sessions?.executionRunContextV1?.open;
    if (!openRun) throw new Error('Auggie detached Run facet is missing.');
    const request: AgentExecutionRunOpenRequest = {
      kind: 'create', runId: 'auggie-run', cwd: home,
      profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'auggie' },
      input: { text: 'A contract request.' }, configuration,
      skills: { pluginRoot: join(home, 'session'), skillsRoot: join(home, 'session', 'skills'), items: [], nativeDisables: [] },
    };
    (observer.boundaries as AgentLaunchObserverBoundaries).reset();
    const runtime = await openRun(request, context as unknown as AgentExecutionRunRuntimeContextV1);
    try {
      expect(observedRequest).toBe(request);
      const argv = observer.observeLaunch().argv;
      expect(argv.slice(argv.indexOf('--plugin-dir'), argv.indexOf('--plugin-dir') + 2)).toEqual(['--plugin-dir', request.skills!.pluginRoot]);
      expect(observer.observeLaunch().filesWritten).toEqual([]);
    } finally { await runtime.dispose(); }
  });
});
