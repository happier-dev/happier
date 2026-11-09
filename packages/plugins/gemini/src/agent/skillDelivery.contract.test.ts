import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentLaunchObserver, runAgentSkillDeliveryContract, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { createGeminiAgentRuntime } from './runtime/factory.js';

// Observe actual native-policy reads at the filesystem boundary; shaping and
// refusal production remain real so a second preparation is visible.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const home = mkdtempSync(join(tmpdir(), 'happier-gemini-skill-home-'));
for (const root of ['.gemini/skills', '.agents/skills']) {
  mkdirSync(join(home, root, 'retained-native'), { recursive: true });
  writeFileSync(join(home, root, 'retained-native', 'SKILL.md'), 'Native skill bytes stay unchanged.');
}
afterAll(() => rmSync(home, { recursive: true, force: true }));
const observer = createAgentLaunchObserver({ home });
const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;

function context() {
  const recordLaunch = (prepared: AgentSessionOpenRequest | AgentExecutionRunOpenRequest, options: Parameters<AgentSessionRuntimeContext['protocols']['acp']['open']>[1]) => {
    if (options?.transport.kind !== 'stdio') throw new Error('Gemini requires its actual stdio launch');
    const env: Record<string, string | undefined> = { ...options.transport.env, ...prepared.launchEnvironment?.values };
    const unset = new Set(prepared.launchEnvironment?.unset.map((key) => key.toUpperCase()));
    for (const key of Object.keys(env)) if (unset.has(key.toUpperCase())) delete env[key];
    boundaries.recordLaunch({ argv: options.transport.args ?? [], env });
  };
  // ACP transport and CLI help execution are genuine external boundaries; shaping stays real.
  return {
    signal: new AbortController().signal,
    services: { exec: { run: async () => ({
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdout: new TextEncoder().encode('--acp'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    }) } },
    protocols: { acp: { open: async (prepared: AgentSessionOpenRequest, options: Parameters<AgentSessionRuntimeContext['protocols']['acp']['open']>[1]) => {
      recordLaunch(prepared, options);
      // The ACP port applies no data knob; Gemini's leaf owns its private-home delivery.
      return { skillsDelivered: prepared.skills ? false : undefined,
        send: async () => ({ status: 'admitted' as const }), watch: () => ({ dispose() {} }), dispose: async () => {} };
    }, openExecutionRunV1: async (prepared: AgentExecutionRunOpenRequest, options: Parameters<AgentSessionRuntimeContext['protocols']['acp']['open']>[1]) => {
      recordLaunch(prepared, options);
      return { send: async () => ({ status: 'admitted' as const }), stop: async () => ({ status: 'notRunning' as const }),
        watch: () => ({ dispose() {} }), dispose: async () => {} };
    } } },
  };
}

async function openSession(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
  boundaries.reset();
  return await createGeminiAgentRuntime().sessions.open({ ...request, launchEnvironment: { values: { HOME: home, GEMINI_API_KEY: 'fixture-gemini-api-key' }, unset: [] } },
    context() as unknown as AgentSessionRuntimeContext);
}

async function openRun(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
  boundaries.reset();
  const run = await createGeminiAgentRuntime().sessions.executionRunContextV1!.open({
    kind: 'resume', checkpointId: 'gemini-checkpoint', runId: 'gemini-skill-run', cwd: request.cwd,
    profile: { pluginId: 'happier.agent.gemini', localId: 'gemini' }, skills: request.skills,
    launchEnvironment: { values: { HOME: home, GEMINI_API_KEY: 'fixture-gemini-api-key' }, unset: [] },
  }, { ...context(), scope: { kind: 'execution_run', executionRunId: 'gemini-skill-run' },
    executionRun: { id: 'gemini-skill-run', services: {} } } as unknown as AgentExecutionRunRuntimeContextV1);
  const privateHome = observer.observeLaunch().env.GEMINI_CLI_HOME!;
  return { ...run, async dispose() {
    await run.dispose();
    expect(existsSync(privateHome)).toBe(false);
  } } as unknown as AgentSessionRuntime;
}

const agent = PLUGIN_MANIFEST.contributes.agents.find((candidate) => candidate.id === 'gemini');
if (!agent) throw new Error('Gemini Agent contribution is missing');
it('declares the probed private-home delivery and native disable overlay', () => {
  expect(agent.capabilities.skills).toEqual({ delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'unsupported',
    nativeRoots: { user: [['.gemini', 'skills'], ['.agents', 'skills']], project: [['.gemini', 'skills'], ['.agents', 'skills']] } });
});
runAgentSkillDeliveryContract({ agent, openSession, observeLaunch: observer.observeLaunch, variants: [
  { id: 'create', open: openSession, expect: 'delivers' },
  { id: 'resume', open: (request) => openSession({ ...request, kind: 'resume', providerSessionId: 'gemini-checkpoint' }), expect: 'delivers' },
  { id: 'detached Run', open: openRun, expect: 'delivers' },
] });

it('refuses unavailable skills while retaining Session startup and native skills', async () => {
  const session = await openSession({ kind: 'create', cwd: home, sessionId: 'unavailable-skill',
    skills: { pluginRoot: join(home, 'missing'), skillsRoot: join(home, 'missing', 'skills'),
      items: [{ name: 'missing', skillId: 'fixture:missing', digest: 'sha256:missing', directory: join(home, 'missing', 'skills', 'missing') }], nativeDisables: [] },
  });
  const launch = observer.observeLaunch();
  const privateHome = launch.env.GEMINI_CLI_HOME!;
  try {
    expect(session.skillsDelivered).toBe(false);
    for (const root of ['.gemini/skills', '.agents/skills']) {
      expect(readFileSync(join(privateHome, root, 'retained-native', 'SKILL.md'), 'utf8')).toBe('Native skill bytes stay unchanged.');
    }
    expect(launch.filesWritten).toEqual([]);
  } finally {
    await session.dispose();
  }
  expect(existsSync(privateHome)).toBe(false);
});

it.each(['session', 'run'] as const)('preserves a nonretryable native policy refusal without optional-skills fallback (%s)', async surface => {
  const systemPath = join(home, `refused-${surface}.json`);
  writeFileSync(systemPath, JSON.stringify({ security: { auth: { enforcedType: 'oauth-personal' } } }));
  const request: AgentSessionOpenRequest = {
    kind: 'create', sessionId: `refused-${surface}`, cwd: home,
    providerBinding: { connectionId: 'pc_fixture', model: { id: 'custom', name: 'Custom' },
      upstream: { protocol: 'gemini', normalizedUrl: 'https://provider.example.test', credential: 'apiKey' },
      materialization: { v: 1, kind: 'spawnEnv' } },
    launchEnvironment: { values: { HOME: home, GEMINI_API_KEY: 'fixture-gemini-api-key',
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemPath, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, 'absent-defaults.json') }, unset: [] },
    skills: { pluginRoot: home, skillsRoot: join(home, 'missing'),
      items: [{ name: 'missing', skillId: 'fixture:missing', digest: 'sha256:missing', directory: join(home, 'missing') }], nativeDisables: [] },
  };
  boundaries.reset();
  vi.mocked(readFileSync).mockClear();
  const runtime = createGeminiAgentRuntime();
  const pending = surface === 'session'
    ? runtime.sessions.open(request, context() as unknown as AgentSessionRuntimeContext)
    : runtime.sessions.executionRunContextV1!.open({
      ...request, kind: 'create', runId: `refused-${surface}`,
      profile: { pluginId: 'happier.agent.gemini', localId: 'gemini' }, input: { text: 'Review.' },
    }, context() as unknown as AgentExecutionRunRuntimeContextV1);
  await expect(pending).rejects.toMatchObject({ name: 'PluginError', code: 'gemini_provider_auth_policy_conflict', retryable: false });
  expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === systemPath)).toHaveLength(1);
  expect(observer.observeLaunch().argv).toEqual([]);
});
