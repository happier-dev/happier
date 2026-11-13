import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { reloadConfiguration } from '@/configuration';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createMutableApiSessionClientFixture, type MutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { createNativeSessionBoundary } from './testkit/nativeSessionContext';

// Source publication is a filesystem boundary; all admission, catalog, bridge,
// retained-launch and native runtime composition below use production owners.
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfiguration();
});

it('retains each hosted Session directory for omitted-cwd Runs and preserves explicit Run directories', async () => {
  const home = mkdtempSync(join(tmpdir(), 'happier-run-cwd-scope-'));
  vi.stubEnv('HAPPIER_HOME_DIR', home);
  reloadConfiguration();
  const native = new Map<string, ReturnType<typeof createNativeSessionBoundary>>();
  const open = (request: AgentSessionOpenRequest) => {
    const boundary = native.get(request.cwd);
    if (!boundary) throw new Error(`Unexpected native working directory: ${request.cwd}`);
    return boundary.open(request);
  };
  const plugin = definePlugin({ id: 'test.execution-cwd', version: '0.0.0', displayName: 'Run cwd fixture',
    entrypoints: { daemon: './daemon.mjs' },
    agents: { agent: { declaration: { title: 'Scope Agent', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: false, workspaceWrites: 'deny' } } },
      factory: () => ({ sessions: { open } }),
      sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 } } } });
  const agent = { pluginId: plugin.manifest.id, localId: 'agent' };
  const agentId = `${agent.pluginId}/${agent.localId}`;
  const managers: ExecutionRunHostBridge[] = [];
  const sessions: MutableApiSessionClientFixture[] = [];
  let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
  try {
    fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
      plugins: [{ manifest: plugin.manifest, files: {
        'agent.mjs': `let boundary; export function configure(value) { boundary = value; }
          export function createRuntime() { return { sessions: { open: request => boundary.open(request) } }; }`,
        'daemon.mjs': `import * as leaf from './agent.mjs';
          export function activate(api) { api.agents.register('agent', leaf.createRuntime, {
            sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 } }); }
          export function configureBoundary(boundary) { leaf.configure(boundary); return { activate }; }`,
      }, instantiateCommittedModule(module) {
        if (typeof module.configureBoundary !== 'function') throw new Error('Missing native boundary');
        const configured: unknown = module.configureBoundary({ open });
        if (!configured || typeof configured !== 'object' || !('activate' in configured)
          || typeof configured.activate !== 'function') throw new Error('Missing fixture activation');
        return configured as PluginDaemonModuleNamespace;
      } }] });
    const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
    const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({ resolveAgentIdentity: () => agent });
    const directories = ['first', 'second'].map(name => join(home, name));
    const explicitDirectory = join(home, 'explicit');
    for (const cwd of [...directories, explicitDirectory]) {
      mkdirSync(cwd);
      native.set(cwd, createNativeSessionBoundary());
    }
    const starts = [...directories.map(cwd => ({ cwd, requestedDirectory: undefined })),
      { cwd: directories[0]!, requestedDirectory: explicitDirectory }];
    await Promise.all(starts.map(({ cwd, requestedDirectory }, index) => runAddedHostedSession({
      environment: { ...process.env }, workingDirectory: cwd, end() {},
    }, async () => {
      const sessionId = `scope-session-${index}`;
      const session = createMutableApiSessionClientFixture({ sessionId });
      sessions.push(session);
      const manager = new ExecutionRunHostBridge({ parentProvider: agentId as never, cwd,
        sendAcp: async () => {}, resolveRunReportPolicy: async () => ({ preset: 'important' }),
        resolveExecutionRunProfileCatalog: async () => ({ engineRegistry, profileCatalog }),
        sessionInteractionHost: { session, machineId: 'scope-machine',
          permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Run cwd fixture]' }) },
      });
      managers.push(manager);
      const started = await manager.start({ sessionId, intent: 'task', ...(requestedDirectory ? { cwd: requestedDirectory } : {}), backendTarget: { kind: 'builtInAgent', agentId },
        modelId: 'scope-model', connectedServices: null, instructions: 'Return the working directory.',
        intentInput: { resultSchema: { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'], additionalProperties: false } },
        permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' });
      const expectedDirectory = requestedDirectory ?? cwd;
      const boundary = native.get(expectedDirectory)!;
      await Promise.race([boundary.waitForInputs(1), manager.waitForTerminal(started.runId)]);
      expect(manager.get(started.runId), JSON.stringify(manager.get(started.runId))).toMatchObject({ status: 'running' });
      boundary.complete(JSON.stringify({ directory: boundary.opens[0]!.cwd }));
      await manager.waitForTerminal(started.runId);
      expect(manager.get(started.runId)).toMatchObject({ status: 'succeeded',
        latestToolResult: { directory: expectedDirectory }, launch: { cwd: expectedDirectory } });
    })));
  } finally {
    await Promise.all(managers.map(manager => manager.dispose()));
    await Promise.all(sessions.map(session => session.close()));
    try { await fixture?.dispose(); }
    finally { rmSync(home, { recursive: true, force: true }); }
  }
});
