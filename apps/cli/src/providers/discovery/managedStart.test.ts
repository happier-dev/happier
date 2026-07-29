import { describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import { PluginLocalServicesBridgeControlRequestV1Schema } from '@/daemon/local/services/pluginBridgeProtocol';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { createPluginExecService } from '@/plugins/runtime/exec/hostService';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

import {
  buildManagedProviderStartRequest,
  createManagedProviderStart,
  createProviderManagedLocalServicesExec,
  createProviderManagedLocalServicesDispatch,
  selectProviderManagedLocalServicesEnvironment,
} from './managedStart';
import { projectProviderDiscoveryCandidates } from './project';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function createOllamaContribution(): ResolvedProviderContribution {
  return {
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: 'happier.provider.ollama',
    identity: { pluginId: 'happier.provider.ollama', localId: 'ollama' },
    definition: ProviderContributionV1Schema.parse({
      v: 1,
      id: 'ollama',
      name: 'Ollama',
      kind: 'local',
      endpointTemplates: [{
        id: 'native',
        protocol: 'ollama-native',
        localUrlCandidates: ['http://127.0.0.1:11434'],
        capabilities: {
          streaming: 'supported',
          toolRoundTrips: 'supported',
          statefulResponses: 'unsupported',
          reasoningControls: 'supported',
        },
      }],
      catalog: {
        source: 'probe',
        manualModelPolicy: 'allowed',
        probes: [{ endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' }],
      },
      discovery: {
        v: 1,
        listener: {
          executableBasenames: ['ollama'],
          argvMatch: { mode: 'containsAll', tokens: ['serve'] },
          defaultPorts: [11434],
        },
        availabilityProbe: {
          endpointTemplateId: 'native',
          path: '/api/tags',
          parser: 'ollama-tags',
        },
        managedStart: { lookupNames: ['ollama'], fixedArgs: ['serve'] },
      },
    }),
  };
}

describe('buildManagedProviderStartRequest', () => {
  it('derives the bridge contribution id from the canonical Provider identity', () => {
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a',
      pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama',
      providerName: 'Ollama',
      executablePath: '/usr/local/bin/ollama',
      executableArgs: [],
      fixedArgs: ['serve'],
    });
    expect(request.context.contributionId).toBe('ollama');
  });

  it('builds a bounded direct-binary detect-after-launch declaration with no shell', () => {
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a',
      pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama',
      providerName: 'Ollama',
      executablePath: '/usr/local/bin/ollama',
      executableArgs: [],
      fixedArgs: ['serve'],
    });
    expect(PluginLocalServicesBridgeControlRequestV1Schema.parse(request)).toEqual(request);
    expect(request.operation).toMatchObject({
      kind: 'start',
      declaration: {
        launch: { kind: 'binary', executablePath: '/usr/local/bin/ollama', args: ['serve'] },
        launchMode: { kind: 'detectAfterLaunch', minimumConfidence: 'medium' },
        restart: { kind: 'never' },
      },
    });
  });

  it('carries the daemon-resolved executable authority into the real managed-service spawn', async () => {
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'machine-a',
      inventoryEnabled: () => true,
      startLoop: false,
      scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
      managedLocalServices: {
        exec: createPluginExecService(),
        detectAfterLaunchReadinessTimeoutMs: 1,
      },
    });
    const dispatch = createProviderManagedLocalServicesDispatch({
      startTrusted: runtime.trustedManagedLocalServices.start,
      processEnv: process.env,
      allowPathRuntimeNames: [basename(process.execPath)],
    });
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a',
      pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama',
      providerName: 'Ollama',
      executablePath: process.execPath,
      executableArgs: ['-e'],
      fixedArgs: ['setInterval(() => {}, 1_000)'],
    });

    try {
      await expect(dispatch({
        request,
        resolvedTool: { ok: true, command: process.execPath, args: ['-e'], source: 'system' },
        expected: {
          machineId: 'machine-a', pluginId: 'happier.provider.ollama',
          contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
          fixedArgs: ['setInterval(() => {}, 1_000)'],
        },
      })).resolves.toMatchObject({ ok: true, snapshot: { phase: 'detecting' } });

      if (request.operation.kind !== 'start' || request.operation.declaration.launch.kind !== 'binary') {
        throw new Error('Expected a direct binary managed Provider launch');
      }
      const declaration = request.operation.declaration;
      const alteredDeclaration = {
        ...declaration,
        launch: {
          ...declaration.launch,
          args: ['-e', 'process.exit(0)', '--attacker-arg'],
          env: { ANTHROPIC_API_KEY: 'attacker-secret' },
          cwd: '/tmp/attacker-cwd',
        },
      };
      await expect(runtime.pluginBridgeRoutes.dispatch({
        ...request,
        context: { ...request.context, sessionId: 'attacker-session' },
        operation: {
          kind: 'start',
          declaration: alteredDeclaration,
        },
      })).resolves.toMatchObject({ ok: true, snapshot: { phase: 'failed' } });
      // Direct unit invocation intentionally bypasses HTTP auth to prove that even an
      // authenticated generic bridge call cannot replay the trusted start authority.
      await expect(runtime.pluginBridgeRoutes.dispatch(request))
        .resolves.toMatchObject({ ok: true, snapshot: { phase: 'failed' } });
    } finally {
      await runtime.pluginBridgeRoutes.dispatch({
        ...request,
        operation: { kind: 'stop', serviceId: 'provider-managed' },
      });
      runtime.stop();
    }
  });

  it('waits for the inventory loop to publish PID-correlated readiness before returning running', async () => {
    let listenerReady = false;
    const scan = vi.fn(async () => listenerReady
      ? {
          listeners: [{ address: '127.0.0.1', port: 11434, protocol: 'tcp' as const, pid: 300 }],
          processes: new Map([[300, { pid: 300, ppid: 1, command: '/usr/local/bin/ollama serve' }]]),
          workspaces: [],
          diagnostics: [],
        }
      : { listeners: [], processes: new Map(), workspaces: [], diagnostics: [] });
    const dispose = vi.fn(async () => undefined);
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'machine-a',
      inventoryEnabled: () => true,
      startLoop: false,
      scan,
      managedLocalServices: {
        exec: createPluginExecService(),
        detectAfterLaunchReadinessTimeoutMs: 1_000,
      },
    });
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a',
      pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama',
      providerName: 'Ollama',
      executablePath: process.execPath,
      executableArgs: ['-e'],
      fixedArgs: ['setInterval(() => {}, 1_000)'],
    });
    if (request.operation.kind !== 'start') throw new Error('Expected managed Start declaration');

    try {
      let settled = false;
      const started = runtime.trustedManagedLocalServices.start({
        context: request.context,
        declaration: request.operation.declaration,
        exec: {
          spawn: vi.fn(async () => ({
            pid: 300,
            exit: new Promise<never>(() => undefined),
            writeStdin: vi.fn(async () => undefined),
            kill: vi.fn(),
            dispose,
          })),
        },
      }).then((snapshot) => {
        settled = true;
        return snapshot;
      });

      await vi.waitFor(() => expect(scan).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      listenerReady = true;
      await runtime.refreshInventoryNow();
      await expect(started).resolves.toMatchObject({
        phase: 'running',
        inventoryId: expect.any(String),
        port: 11434,
      });
      const managed = await runtime.managedRoutes.getSnapshot();
      const candidates = projectProviderDiscoveryCandidates({
        snapshot: runtime.inventoryRegistry.getSnapshot(),
        registry: {
          providersByContributionKey: new Map([[
            'happier.provider.ollama/ollama',
            createOllamaContribution(),
          ]]),
        },
        managedServices: managed.rows,
      });
      expect(candidates).toMatchObject([{
        evidence: { kind: 'attributed_listener' },
        ownership: 'owned',
      }]);
    } finally {
      await runtime.pluginBridgeRoutes.dispatch({
        ...request,
        operation: { kind: 'stop', serviceId: 'provider-managed' },
      });
      runtime.stop();
    }
  });

  it('returns the terminal managed state when the child exits during readiness wait', async () => {
    const exit = createDeferred<Readonly<{
      exitCode: number | null; signal: string | null; stdout: string; stderr: string;
    }>>();
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'machine-a', inventoryEnabled: () => true, startLoop: false,
      scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
      managedLocalServices: {
        exec: createPluginExecService(),
        detectAfterLaunchReadinessTimeoutMs: 1_000,
      },
    });
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a', pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
      executablePath: '/usr/local/bin/ollama', executableArgs: [], fixedArgs: ['serve'],
    });
    if (request.operation.kind !== 'start') throw new Error('Expected managed Start declaration');
    const started = runtime.trustedManagedLocalServices.start({
      context: request.context,
      declaration: request.operation.declaration,
      exec: {
        spawn: vi.fn(async () => ({
          pid: 300, exit: exit.promise,
          writeStdin: vi.fn(async () => undefined), kill: vi.fn(), dispose: vi.fn(async () => undefined),
        })),
      },
    });

    await vi.waitFor(() => expect(runtime.managedRegistry.listServices()).toHaveLength(1));
    exit.resolve({ exitCode: 1, signal: null, stdout: '', stderr: '' });
    await expect(started).resolves.toMatchObject({ phase: 'failed' });
    runtime.stop();
  });

  it('returns truthful detecting and releases the readiness wait when the runtime shuts down', async () => {
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'machine-a', inventoryEnabled: () => true, startLoop: false,
      scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
      managedLocalServices: {
        exec: createPluginExecService(),
        detectAfterLaunchReadinessTimeoutMs: 1_000,
      },
    });
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a', pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
      executablePath: '/usr/local/bin/ollama', executableArgs: [], fixedArgs: ['serve'],
    });
    if (request.operation.kind !== 'start') throw new Error('Expected managed Start declaration');
    const started = runtime.trustedManagedLocalServices.start({
      context: request.context,
      declaration: request.operation.declaration,
      exec: {
        spawn: vi.fn(async () => ({
          pid: 300, exit: new Promise<never>(() => undefined),
          writeStdin: vi.fn(async () => undefined), kill: vi.fn(), dispose: vi.fn(async () => undefined),
        })),
      },
    });

    await vi.waitFor(() => expect(runtime.managedRegistry.listServices()).toHaveLength(1));
    runtime.stop();
    await expect(started).resolves.toMatchObject({ phase: 'detecting' });
  });

  it('keeps a same-key successor behind the readiness transaction of the exact active run', async () => {
    let listenerPid: number | null = null;
    const scan = vi.fn(async () => listenerPid === null
      ? { listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }
      : {
          listeners: [{
            address: '127.0.0.1',
            port: listenerPid === 300 ? 11434 : 11435,
            protocol: 'tcp' as const,
            pid: listenerPid,
          }],
          processes: new Map([[
            listenerPid,
            { pid: listenerPid, ppid: 1, command: '/usr/local/bin/ollama serve' },
          ]]),
          workspaces: [], diagnostics: [],
        });
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'machine-a', inventoryEnabled: () => true, startLoop: false, scan,
      managedLocalServices: {
        exec: createPluginExecService(),
        detectAfterLaunchReadinessTimeoutMs: 1_000,
      },
    });
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a', pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
      executablePath: '/usr/local/bin/ollama', executableArgs: [], fixedArgs: ['serve'],
    });
    if (request.operation.kind !== 'start') throw new Error('Expected managed Start declaration');
    const firstSpawn = vi.fn(async () => ({
      pid: 300, exit: new Promise<never>(() => undefined),
      writeStdin: vi.fn(async () => undefined), kill: vi.fn(), dispose: vi.fn(async () => undefined),
    }));
    const secondSpawn = vi.fn(async () => ({
      pid: 301, exit: new Promise<never>(() => undefined),
      writeStdin: vi.fn(async () => undefined), kill: vi.fn(), dispose: vi.fn(async () => undefined),
    }));
    const first = runtime.trustedManagedLocalServices.start({
      context: request.context, declaration: request.operation.declaration, exec: { spawn: firstSpawn },
    });
    await vi.waitFor(() => expect(runtime.managedRegistry.getService(JSON.stringify([
      request.context.pluginId, request.context.contributionId, request.context.sessionId, 'provider-managed',
    ]))?.process.pid).toBe(300));

    const second = runtime.trustedManagedLocalServices.start({
      context: request.context, declaration: request.operation.declaration, exec: { spawn: secondSpawn },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondSpawn).not.toHaveBeenCalled();

    listenerPid = 300;
    await runtime.refreshInventoryNow();
    await expect(first).resolves.toMatchObject({ phase: 'running', port: 11434 });
    await vi.waitFor(() => expect(secondSpawn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(runtime.managedRegistry.getService(JSON.stringify([
      request.context.pluginId, request.context.contributionId, request.context.sessionId, 'provider-managed',
    ]))?.process.pid).toBe(301));
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    listenerPid = 301;
    await runtime.refreshInventoryNow();
    await expect(second).resolves.toMatchObject({ phase: 'running', port: 11435 });
    runtime.stop();
  });

  it('preserves required platform variables without exposing ambient credentials to the managed Provider process', async () => {
    const exec = createProviderManagedLocalServicesExec({
      processEnv: {
        HOME: '/home/provider-managed-test',
        PATH: '/bin:/usr/bin',
        TMPDIR: '/tmp/provider-managed-test',
        ANTHROPIC_API_KEY: 'ambient-secret-must-not-leak',
        HAPPIER_ACCESS_TOKEN: 'access-token-must-not-leak',
        HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN: 'bridge-token-must-not-leak',
        HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE: '/tmp/bridge-token-file-must-not-leak',
      },
      executablePath: process.execPath,
      allowPathRuntimeNames: [basename(process.execPath)],
    });

    const result = await exec.run({
      kind: 'binary',
      executablePath: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ home: process.env.HOME ?? null, path: process.env.PATH ?? null, tmpdir: process.env.TMPDIR ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null, accessToken: process.env.HAPPIER_ACCESS_TOKEN ?? null, bridgeToken: process.env.HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN ?? null, bridgeTokenFile: process.env.HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE ?? null }))'],
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      home: '/home/provider-managed-test',
      path: '/bin:/usr/bin',
      tmpdir: '/tmp/provider-managed-test',
      anthropic: null,
      accessToken: null,
      bridgeToken: null,
      bridgeTokenFile: null,
    });
  });

  it('selects required Windows process variables case-insensitively without ambient credentials', () => {
    expect(selectProviderManagedLocalServicesEnvironment({
      Path: 'C:\\Windows\\System32',
      UserProfile: 'C:\\Users\\provider',
      LocalAppData: 'C:\\Users\\provider\\AppData\\Local',
      TEMP: 'C:\\Temp',
      ANTHROPIC_API_KEY: 'ambient-secret-must-not-leak',
    }, 'win32')).toEqual({
      Path: 'C:\\Windows\\System32',
      UserProfile: 'C:\\Users\\provider',
      LocalAppData: 'C:\\Users\\provider\\AppData\\Local',
      TEMP: 'C:\\Temp',
    });
  });

  it('does not authorize or dispatch a launch that differs from the resolved executable', async () => {
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'machine-a', inventoryEnabled: () => true, startLoop: false,
      scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
      managedLocalServices: { exec: createPluginExecService() },
    });
    const dispatch = createProviderManagedLocalServicesDispatch({
      startTrusted: runtime.trustedManagedLocalServices.start,
      processEnv: process.env,
    });
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a',
      pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama',
      providerName: 'Ollama',
      executablePath: '/usr/local/bin/ollama',
      executableArgs: [],
      fixedArgs: ['serve'],
    });

    await expect(dispatch({
      request,
      resolvedTool: { ok: true, command: '/tmp/replaced-ollama', args: [], source: 'system' },
      expected: {
        machineId: 'machine-a', pluginId: 'happier.provider.ollama',
        contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama', fixedArgs: ['serve'],
      },
    })).resolves.toEqual({ ok: false, errorCode: 'managed_service_executable_authorization_invalid' });
    expect((await runtime.managedRoutes.getSnapshot()).rows).toEqual([]);
    runtime.stop();
  });

  it('refuses altered arguments, environment, and cwd before the managed runtime sees them', async () => {
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'machine-a', inventoryEnabled: () => true, startLoop: false,
      scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
      managedLocalServices: { exec: createPluginExecService() },
    });
    const dispatch = createProviderManagedLocalServicesDispatch({
      startTrusted: runtime.trustedManagedLocalServices.start,
      processEnv: process.env,
    });
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a', pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
      executablePath: '/usr/local/bin/ollama', executableArgs: [], fixedArgs: ['serve'],
    });
    const expected = {
      machineId: 'machine-a', pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
      fixedArgs: ['serve'],
    } as const;
    const declaration = request.operation.kind === 'start' ? request.operation.declaration : null;
    expect(declaration).not.toBeNull();

    for (const launch of [
      { ...declaration!.launch, args: ['serve', '--attacker-arg'] },
      { ...declaration!.launch, env: { ANTHROPIC_API_KEY: 'ambient-secret' } },
      { ...declaration!.launch, cwd: '/tmp/attacker-cwd' },
    ]) {
      await expect(dispatch({
        request: { ...request, operation: { kind: 'start', declaration: { ...declaration!, launch } } },
        resolvedTool: { ok: true, command: '/usr/local/bin/ollama', args: [], source: 'system' },
        expected,
      })).resolves.toEqual({ ok: false, errorCode: 'managed_service_executable_authorization_invalid' });
    }
    expect((await runtime.managedRoutes.getSnapshot()).rows).toEqual([]);
    runtime.stop();
  });

  it('does not leave executable authority behind when the trusted start fails', async () => {
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'machine-a', inventoryEnabled: () => true, startLoop: false,
      scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
      managedLocalServices: { exec: createPluginExecService() },
    });
    const dispatch = createProviderManagedLocalServicesDispatch({
      startTrusted: runtime.trustedManagedLocalServices.start,
      processEnv: process.env,
      signal: AbortSignal.abort(),
    });
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a', pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
      executablePath: '/usr/local/bin/ollama', executableArgs: [], fixedArgs: ['serve'],
    });

    await expect(dispatch({
      request,
      resolvedTool: { ok: true, command: '/usr/local/bin/ollama', args: [], source: 'system' },
      expected: {
        machineId: 'machine-a', pluginId: 'happier.provider.ollama',
        contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
        fixedArgs: ['serve'],
      },
    })).resolves.toMatchObject({ ok: true, snapshot: { phase: 'failed' } });
    await expect(runtime.pluginBridgeRoutes.dispatch({
      ...request,
      context: { ...request.context, sessionId: 'attacker-session' },
    })).resolves.toMatchObject({ ok: true, snapshot: { phase: 'failed' } });
    runtime.stop();
  });

  it('maps a managed-service launch rejection to retryable endpoint recovery', async () => {
    const start = createManagedProviderStart({
      resolveSystemTool: vi.fn(async () => ({
        ok: true as const,
        command: '/usr/local/bin/ollama',
        args: [],
        source: 'system' as const,
      })),
      dispatch: vi.fn(async () => {
        throw new Error('PLUGIN_EXEC_PERMISSION_DENIED');
      }),
    });

    await expect(start({
      machineId: 'machine-a',
      contributionKey: 'happier.provider.ollama/ollama',
      pluginId: 'happier.provider.ollama',
      providerName: 'Ollama',
      lookupNames: ['ollama'],
      fixedArgs: ['serve'],
    })).rejects.toMatchObject({
      code: 'provider_endpoint_unavailable',
      retryable: true,
      action: 'retry',
      machineId: 'machine-a',
    });
  });

  it('uses the real managed registry handle as the only owned-authority source', async () => {
    const dispose = vi.fn(async () => undefined);
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'machine-a',
      inventoryEnabled: () => true,
      startLoop: false,
      scan: async () => ({
        listeners: [{ address: '127.0.0.1', port: 11434, protocol: 'tcp', pid: 300 }],
        processes: new Map([[300, { pid: 300, ppid: 1, command: '/usr/local/bin/ollama serve' }]]),
        workspaces: [],
        diagnostics: [],
      }),
      managedLocalServices: {
        exec: {
          spawn: vi.fn(async () => ({
            pid: 300,
            exit: new Promise<never>(() => undefined),
            writeStdin: vi.fn(async () => undefined),
            kill: vi.fn(),
            dispose,
          })),
        },
      },
    });
    const request = buildManagedProviderStartRequest({
      machineId: 'machine-a', pluginId: 'happier.provider.ollama',
      contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
      executablePath: '/usr/local/bin/ollama', executableArgs: [], fixedArgs: ['serve'],
    });
    const started = await runtime.pluginBridgeRoutes.dispatch(request);
    expect(started).toMatchObject({ ok: true, snapshot: { phase: 'running' } });
    const managed = await runtime.managedRoutes.getSnapshot();
    expect(managed.rows[0]).toMatchObject({
      phase: 'running', supportedActions: expect.arrayContaining(['stop_managed']),
    });

    const definition = ProviderContributionV1Schema.parse({
      v: 1, id: 'ollama', name: 'Ollama', kind: 'local',
      endpointTemplates: [{
        id: 'native', protocol: 'ollama-native', localUrlCandidates: ['http://127.0.0.1:11434'],
        capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'supported' },
      }],
      catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' }] },
      discovery: {
        v: 1, listener: { executableBasenames: ['ollama'], argvMatch: { mode: 'containsAll', tokens: ['serve'] }, defaultPorts: [11434] },
        availabilityProbe: { endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' },
        managedStart: { lookupNames: ['ollama'], fixedArgs: ['serve'] },
      },
    });
    const contribution: ResolvedProviderContribution = {
      provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'happier.provider.ollama',
      identity: { pluginId: 'happier.provider.ollama', localId: 'ollama' },
      definition,
    };
    const candidates = projectProviderDiscoveryCandidates({
      snapshot: runtime.inventoryRegistry.getSnapshot(),
      registry: { providersByContributionKey: new Map([['happier.provider.ollama/ollama', contribution]]) },
      managedServices: managed.rows,
    });
    expect(candidates[0]?.ownership).toBe('owned');
    await runtime.stop();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
