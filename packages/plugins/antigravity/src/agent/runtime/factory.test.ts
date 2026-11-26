import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  AgentAcpRuntimeOptions, AgentExecutionRunRuntime, AgentExecutionRunRuntimeContextV1, AgentLaunchEnvironment,
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

type Opened = Readonly<{ launchEnvironment: AgentLaunchEnvironment | undefined; options: AgentAcpRuntimeOptions }>;

/** Host ACP transport and inherited environment are the boundaries; plugin launch decisions stay real. */
async function openAll(values: Record<string, string>, inherited: Record<string, string> = {}): Promise<readonly Opened[]> {
  const opened: Opened[] = [];
  const sessionBoundary: AgentSessionRuntime = {
    async send() { return { status: 'admitted' }; }, watch() { return { dispose() {} }; }, async dispose() {},
  };
  const runBoundary: AgentExecutionRunRuntime = {
    async send() { return { status: 'admitted' }; }, async stop() { return { status: 'notRunning' }; },
    watch() { return { dispose() {} }; }, async dispose() {},
  };
  const record = (request: { launchEnvironment?: AgentLaunchEnvironment }, options: AgentAcpRuntimeOptions) => {
    opened.push({ launchEnvironment: request.launchEnvironment, options });
  };
  const context = {
    services: { exec: { readEnvironment: (keys: readonly string[]) =>
      Object.fromEntries(keys.flatMap(key => inherited[key] === undefined ? [] : [[key, inherited[key]]])) } },
    protocols: { acp: {
      async open(request: { launchEnvironment?: AgentLaunchEnvironment }, options: AgentAcpRuntimeOptions) { record(request, options); return sessionBoundary; },
      async openExecutionRunV1(request: { launchEnvironment?: AgentLaunchEnvironment }, options: AgentAcpRuntimeOptions) { record(request, options); return runBoundary; },
    } },
  } as unknown as AgentSessionRuntimeContext;
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
  return opened;
}

function selectMethod(options: AgentAcpRuntimeOptions, agentVersion: string | null) {
  const auth = options.definition?.auth;
  if (!auth || !('selectMethod' in auth)) throw new Error('Missing launch selector');
  return auth.selectMethod({ advertisedMethodIds: ['oauth-personal', 'gemini-api-key'], initializeMetadata: null, agentVersion });
}

it('runs machine sign-in on native agy with the keyring selection intact for create, resume and Runs', async () => {
  // The inherited flag (e.g. from the user's shell) is stripped through the launch unset list.
  const opened = await openAll({ OTHER: 'kept' }, { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1' });
  expect(opened).toHaveLength(3);
  for (const { launchEnvironment, options } of opened) {
    expect(options.transport).toEqual({ kind: 'stdio', executable: { kind: 'systemTool', id: 'antigravity-cli' }, args: ['acp'] });
    expect(launchEnvironment).toEqual({ values: { OTHER: 'kept' }, unset: ['AGY_CLI_FORCE_FILE_TOKEN_STORAGE'] });
    // Machine sign-in never authenticates explicitly and has no version floor.
    expect(selectMethod(options, '1.5.15')).toBeNull();
  }
  expect(opened[0]!.options.providerTurnSource).toEqual(expect.any(Function));
  expect(JSON.stringify(opened.map(entry => entry.options))).not.toMatch(/managedDependency|agy-acp-server|oauth-personal/u);
});

it('passes a user GEMINI_HOME to native agy as its profile directory', async () => {
  const [machine] = await openAll({}, { GEMINI_HOME: '/user/custom-gemini' });
  expect(machine!.options.transport).toMatchObject({
    args: ['acp', '--gemini-dir', '/user/custom-gemini', '--app-data-dir', 'antigravity-cli'],
  });
});

it('isolates a connected Google account in its materialized profile and requires agy 1.5.18 before any Session', async () => {
  const opened = await openAll({ AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1', GEMINI_HOME: '/accounts/a/gemini-home' },
    { GEMINI_HOME: '/user/custom-gemini' });
  for (const { launchEnvironment, options } of opened) {
    expect(options.transport).toMatchObject({
      args: ['acp', '--gemini-dir', '/accounts/a/gemini-home', '--app-data-dir', 'antigravity-cli'],
    });
    expect(launchEnvironment?.values.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1');
    expect(launchEnvironment?.unset).not.toContain('AGY_CLI_FORCE_FILE_TOKEN_STORAGE');
    expect(selectMethod(options, '1.5.18')).toBeNull();
    expect(selectMethod(options, '1.6.0-beta.1')).toBeNull();
    for (const version of ['1.5.15', null]) {
      expect(() => selectMethod(options, version)).toThrow(expect.objectContaining({ code: 'antigravity_cli_update_required' }));
    }
  }
});

it('authenticates Gemini API-key accounts explicitly inside a private profile and fails closed without one', async () => {
  const opened = await openAll({ GEMINI_API_KEY: 'fake-selected-key', GEMINI_HOME: '/accounts/key/gemini-home' });
  for (const { launchEnvironment, options } of opened) {
    expect(selectMethod(options, '1.5.18')).toEqual({ methodId: 'gemini-api-key' });
    expect(() => selectMethod(options, '1.5.15')).toThrow(expect.objectContaining({ code: 'antigravity_cli_update_required' }));
    expect(launchEnvironment?.values).toMatchObject({ GEMINI_API_KEY: 'fake-selected-key', AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1' });
    expect(options.transport).toMatchObject({ args: ['acp', '--gemini-dir', '/accounts/key/gemini-home', '--app-data-dir', 'antigravity-cli'] });
  }
  await expect(openAll({ GEMINI_API_KEY: 'fake-selected-key' }, { GEMINI_HOME: '/user/custom-gemini' }))
    .rejects.toMatchObject({ code: 'antigravity_connected_home_unavailable' });
});

it('classifies the native invalid API-key refusal and selects models from the native model option', async () => {
  const [{ options }] = await openAll({}) as [Opened];
  expect(options.definition?.modelConfigOptionId).toBe('model');
  const project = options.definition?.sessionUpdates?.projectOutputDiagnostic;
  // Captured from agy 1.5.18 with an invalid Gemini API key (stopReason end_turn).
  const sample = '\n⚠ agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[service:generativelanguage.googleapis.com] reason:API_KEY_INVALID] map[@type:type.googleapis.com/google.rpc.LocalizedMessage locale:en-US message:API key not valid. Please pass a valid API key.]]\n';
  expect(project?.(sample)).toMatchObject({
    code: 'acp_turn_failed',
    message: 'API key not valid. Please pass a valid API key.',
    details: { failureCause: { failureReason: 'authentication_required' } },
  });
  expect(project?.('API key not valid. Please pass a valid API key.')).toBeNull();
  expect(options.definition).not.toHaveProperty('usageLimitDiagnostic');
  expect(options.definition?.auth).not.toHaveProperty('setupFailure');
});
