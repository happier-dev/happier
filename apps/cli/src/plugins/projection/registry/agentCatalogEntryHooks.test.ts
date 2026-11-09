import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { getHappierTempRoot } from '@happier-dev/cli-common/tempDirs';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentCliSessionCommandDeclarationV1,
  AgentCliSessionCommandBuildInputV1,
  AgentConnectedAccountRuntimeAuthAdapterV1,
  AgentPreflightSessionControlsContributionV1,
  AgentPreflightSessionControlsProbeContextV1,
  AgentSessionRuntimeAuthApplyResult,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { COPILOT_PREFLIGHT_SESSION_CONTROLS } from '../../../../../../packages/plugins/copilot/src/agent/acp/preflight';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createConnectedServiceRuntimeAuthNativeHome } from '@/daemon/connectedServices/runtimeAuth/createRuntimeAuthNativeHome';
import { createPreflightCatalogCleanupScope } from '@/capabilities/probes/preflightCatalogCleanupScope';
import { runPreflightSessionControlsProbe } from '@/capabilities/probes/runPreflightSessionControlsProbe';
import { CODEX_PREFLIGHT_SESSION_CONTROLS } from '../../../../../../packages/plugins/codex/src/agent/lifecycle/preflight/sessionControls';
import { readAgentRuntimeMaxInputUnicodeCharacters } from '@/capabilities/probes/agentRuntimeInputCapacity';

import {
  createCliSessionCommandHandler,
  projectAgentCliSessionCommandCatalogEntry,
  projectAgentConnectedAccountLaunchCatalogEntry,
  projectAgentDaemonSpawnHooksCatalogEntry,
  projectAgentExperimentalVendorResumeSupportCatalogEntry,
  projectAgentPreflightSessionControlsCatalogEntry,
  projectAgentSessionStartupCatalogEntry,
} from './agentCatalogEntryHooks';

const runBackendSessionCliCommandMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);
vi.mock('@/cli/runBackendSessionCliCommand', () => ({
  runBackendSessionCliCommand: runBackendSessionCliCommandMock,
}));

function writePreflightFixtureExecutable(dir: string): string {
  const quotedRuntime = `'${process.execPath.replace(/'/g, `'\\''`)}'`;
  return writeExecutableShimSync({
    dir, fileName: process.platform === 'win32' ? 'external-agent.cmd' : 'external-agent',
    contents: process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" %*\r\n`
      : `#!/bin/sh\nexec ${quotedRuntime} "$@"\n`,
  });
}

describe('Agent registration catalog projections', () => {
  it('refuses an unqualified workspace catalog command when held isolation becomes unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-catalog-isolation-'));
    const marker = join(root, 'executions');
    const command = { toolId: 'native-cli', args: ['-e',
      `require('node:fs').appendFileSync(${JSON.stringify(marker)},'spawned\\n')`] };
    let enabled = false;
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'fixture.native',
      systemTools: [{ id: 'native-cli', title: 'Native fixture', executableNames: [writePreflightFixtureExecutable(root)] }],
      agentIsolation: { read: () => ({ enabled, workspaceRoots: [root],
        status: { kind: 'unavailable' as const, code: 'launch_probe_failed' as const } }) },
      preflightSessionControls: { jsonRpcCommands: [command], probeCatalogs: async context => {
        const result = await context.runDeclaredSystemToolCommand(command);
        return result.ok ? { commands: [{ name: 'catalog-ready' }], skills: [] } : null;
      } },
      retirementSignal: new AbortController().signal, isCurrent: () => true,
    });
    try {
      const adapter = (await projected.getPreflightSessionControlsProbeAdapter!())!;
      await expect(adapter.probeCatalogsRaw!({ cwd: root, timeoutMs: 10_000 })).resolves.toMatchObject({
        commands: [{ name: 'catalog-ready' }],
      });
      enabled = true;
      await expect(adapter.probeCatalogsRaw!({ cwd: root, timeoutMs: 10_000 })).resolves.toBeNull();
      expect(await readFile(marker, 'utf8')).toBe('spawned\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects runtime capacity independently of native offered-model discovery', async () => {
    let current = true;
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'codex', systemTools: [], retirementSignal: new AbortController().signal,
      isCurrent: () => current, preflightSessionControls: CODEX_PREFLIGHT_SESSION_CONTROLS,
    });
    expect(projected.resolveRuntimeMaxInputUnicodeCharacters?.({ accountSettings: null })).toBe(1 << 20);
    const catalogEntry = { ...projected, id: 'codex', cliSubcommand: 'codex', vendorResumeSupport: 'unsupported' } satisfies
      NonNullable<Parameters<typeof readAgentRuntimeMaxInputUnicodeCharacters>[0]['catalogEntry']>;
    await expect(readAgentRuntimeMaxInputUnicodeCharacters({ agentId: 'codex', catalogEntry })).resolves.toBe(1 << 20);
    await expect(readAgentRuntimeMaxInputUnicodeCharacters({ agentId: 'codex', catalogEntry: null })).resolves.toBeNull();
    expect(projected.resolveRuntimeMaxInputUnicodeCharacters?.({
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } },
    })).toBeNull();
    current = false;
    expect(projected.resolveRuntimeMaxInputUnicodeCharacters?.({ accountSettings: null })).toBeNull();
  });
  it('keeps the containing cleanup scope open across the existing native probe retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-preflight-retry-'));
    const script = join(root, 'inventory.cjs');
    await writeFile(script, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if('id' in request)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:[]})+'\\n');});`);
    const command = { toolId: 'native-cli', args: [script] };
    let attempt = 0;
    const models = [{ id: 'native-model', name: 'Native model' }];
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'fixture.native',
      systemTools: [{ id: 'native-cli', title: 'Native fixture', executableNames: [writePreflightFixtureExecutable(root)] }],
      preflightSessionControls: { jsonRpcCommands: [command], probeModels: context => (
        context.withDeclaredJsonRpcClient(command, async client => {
          await client.request('inventory');
          return ++attempt === 1 ? null : models;
        })
      ) },
      retirementSignal: new AbortController().signal, isCurrent: () => true,
    });
    const cleanupScope = createPreflightCatalogCleanupScope();
    try {
      const adapter = (await projected.getPreflightSessionControlsProbeAdapter!())!;
      await expect(runPreflightSessionControlsProbe({ adapter,
        probeOnce: async () => await adapter.probeModelsRaw!({ cwd: root, timeoutMs: 10_000, cleanupScope }),
      })).resolves.toEqual({ kind: 'success', value: models });
    } finally {
      await cleanupScope.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['probeCatalogsRaw', 'probeModesRaw'] as const)('closes the native JSON-RPC process and prepared artifact when the %s inspector ignores cancellation', async (method) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-catalog-native-cleanup-'));
    const capture = join(root, 'pid.json');
    const controller = new AbortController();
    let releaseInspect!: () => void;
    const inspected = new Promise<void>((resolve) => { releaseInspect = resolve; });
    const executable = writePreflightFixtureExecutable(root);
    const command = { toolId: 'native-cli', args: [], prepareCommand: () => ({ args: [{
      kind: 'temporaryTextFile' as const, suffix: '.cjs',
      contents: `require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({pid:process.pid,path:__filename}));setInterval(()=>{},1000);`,
    }] }) };
    const inspect = async (context: AgentPreflightSessionControlsProbeContextV1) => (
      context.withDeclaredJsonRpcClient(command, async () => { await inspected; return { commands: [], skills: null }; })
    );
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'fixture.native',
      systemTools: [{ id: 'native-cli', title: 'Native fixture', executableNames: [executable] }],
      preflightSessionControls: { jsonRpcCommands: [command], probeCatalogs: inspect, probeModes: inspect },
      retirementSignal: new AbortController().signal, isCurrent: () => true,
    });
    const adapter = (await projected.getPreflightSessionControlsProbeAdapter!())!;
    const discovery = adapter[method]!({ cwd: root, timeoutMs: 10_000, signal: controller.signal });
    void discovery.catch(() => undefined);
    let observation: {pid:number;path:string} | undefined;
    try {
      await vi.waitFor(async () => { observation = JSON.parse(await readFile(capture, 'utf8')); });
      controller.abort(new Error('Caller cancelled the catalog'));
      if (method === 'probeCatalogsRaw') await expect(discovery).rejects.toThrow();
      else await expect(discovery).resolves.toBeNull();
      expect(() => process.kill(observation!.pid, 0)).toThrow();
      await expect(access(observation!.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      releaseInspect();
      if (observation) await vi.waitFor(() => expect(() => process.kill(observation!.pid, 0)).toThrow());
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['callback', 'settings', 'parser'] as const)('settles a hung catalog %s at the caller deadline and accepts a later probe', async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-catalog-deadline-'));
    const script = join(root, 'catalog.cjs');
    await writeFile(script, 'process.stdout.write("[]");');
    const executable = writePreflightFixtureExecutable(root);
    let blocked = true;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<never>(() => {});
    const result = { commands: [], skills: null };
    const discover = () => {
      entered();
      return blocked ? pending : result;
    };
    if (stage !== 'parser') vi.useFakeTimers();
    try {
      const projected = projectAgentPreflightSessionControlsCatalogEntry({
        agentId: 'fixture.native',
        systemTools: [{ id: 'native-cli', title: 'Native fixture', executableNames: [executable] }],
        preflightSessionControls: stage === 'parser'
          ? { catalogs: { command: { toolId: 'native-cli', args: [script] }, parseOutput: discover } }
          : { probeCatalogs: stage === 'callback' ? discover : () => result },
        ...(stage === 'settings' ? { resolvePluginSettings: async () => {
          entered();
          return blocked ? await pending : null;
        } } : {}),
        retirementSignal: new AbortController().signal, isCurrent: () => true,
      });
      const adapter = (await projected.getPreflightSessionControlsProbeAdapter!())!;
      let outcome: 'resolved' | 'rejected' | undefined;
      const discovery = adapter.probeCatalogsRaw!({ cwd: root, timeoutMs: 10_000 });
      void discovery.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
      await started;
      if (stage === 'parser') await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      else await vi.advanceTimersByTimeAsync(10_000);
      expect(outcome).toBe('rejected');
      blocked = false;
      await expect(adapter.probeCatalogsRaw!({ cwd: root, timeoutMs: 10_000 })).resolves.toEqual(result);
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['probeModelsRaw', 'probeModesRaw', 'probeConfigOptionsRaw', 'probePassiveRealtimeSetupRaw'] as const)(
    'uses the containing deadline for %s even when its external callback ignores cancellation', async (method) => {
      vi.useFakeTimers();
      const deadline = new AbortController();
      let blocked = true;
      const result: unknown[] = [];
      const callback = () => blocked ? new Promise<never>(() => {}) : result;
      const projected = projectAgentPreflightSessionControlsCatalogEntry({
        agentId: 'fixture.native', systemTools: [],
        preflightSessionControls: {
          probeModels: callback, probeModes: callback, probeConfigOptions: callback, probePassiveRealtimeSetup: callback,
        },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
      });
      const adapter = (await projected.getPreflightSessionControlsProbeAdapter!())!;
      try {
        let settled = false;
        const discovery = adapter[method]!({ cwd: process.cwd(), timeoutMs: 100, deadlineSignal: deadline.signal });
        void discovery.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBe(false);
        deadline.abort(new Error('Containing operation ended'));
        await expect(discovery).resolves.toBeNull();
        const caller = new AbortController();
        const cancelled = adapter[method]!({ cwd: process.cwd(), timeoutMs: 100,
          signal: caller.signal, deadlineSignal: new AbortController().signal });
        caller.abort(new Error('Caller left before the containing deadline'));
        await expect(cancelled).resolves.toBeNull();
        blocked = false;
        await expect(adapter[method]!({ cwd: process.cwd(), timeoutMs: 100 })).resolves.toEqual(result);
      } finally { vi.useRealTimers(); }
    },
  );

  it.each(['callback', 'settings'] as const)('rejects native catalog completion after its plugin generation retires during %s', async (stage) => {
    const retirement = new AbortController();
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let invoked = false;
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'fixture.native', systemTools: [],
      preflightSessionControls: { probeCatalogs: async () => {
        invoked = true;
        if (stage === 'callback') { started(); await completed; }
        return { commands: [{ name: 'retired-command' }], skills: null };
      } },
      ...(stage === 'settings' ? { resolvePluginSettings: async () => {
        started();
        await completed;
        return null;
      } } : {}),
      retirementSignal: retirement.signal, isCurrent: () => !retirement.signal.aborted,
    });
    const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
    const discovery = adapter!.probeCatalogsRaw!({ cwd: tmpdir(), timeoutMs: 60_000 });
    await entered;
    retirement.abort();
    complete();
    await expect(discovery).rejects.toThrow();
    if (stage === 'settings') {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(invoked).toBe(false);
    }
  });

  it('runs one-shot native initialization input through the scoped catalog process', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-native-catalog-input-')));
    const script = join(root, 'native.cjs');
    await writeFile(script, `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({commands:[{name:JSON.parse(input).request.subtype}],skills:null,cwd:process.cwd()})));`);
    const executable = writePreflightFixtureExecutable(root);
    try {
      const projected = projectAgentPreflightSessionControlsCatalogEntry({
        agentId: 'fixture.native', systemTools: [{ id: 'native-cli', title: 'Native fixture', executableNames: [executable] }],
        preflightSessionControls: { catalogs: { command: { toolId: 'native-cli', args: [script], stdin: JSON.stringify({ request: { subtype: 'initialize' } }) + '\n' }, parseOutput: ({ stdout }) => JSON.parse(stdout) } },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
      });
      const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
      await expect(adapter?.probeCatalogsRaw?.({ cwd: root, timeoutMs: 60_000 })).resolves.toEqual({ commands: [{ name: 'initialize' }], skills: null, cwd: root });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 90_000);

  it('runs the Copilot preflight with the host working directory and observed effort controls', async () => {
    const toolRoot = await realpath(await mkdtemp(join(tmpdir(), 'happier-copilot-preflight-')));
    const script = writeAcpTestAgentScript({ dir: toolRoot, fileName: 'copilot-fixture.mjs', source: `
      let buffer = '';
      process.stdin.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          if (!('id' in request)) continue;
          const result = request.method === 'initialize' ? { protocolVersion: 1 } :
            request.params.cwd === process.cwd() && request.params.mcpServers.length === 0 ? {
              sessionId: 'probe', models: { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'A' }, { modelId: 'model-b', name: 'B' }] },
              configOptions: [{ id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] }],
            } : null;
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        }
      });
    ` });
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const executable = writeExecutableShimSync({ dir: toolRoot, fileName: process.platform === 'win32' ? 'copilot.cmd' : 'copilot',
      contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    });
    try {
      const projected = projectAgentPreflightSessionControlsCatalogEntry({
        agentId: 'copilot', preflightSessionControls: COPILOT_PREFLIGHT_SESSION_CONTROLS,
        systemTools: [{ id: 'copilot-cli', title: 'Copilot', executableNames: [executable] }],
        retirementSignal: new AbortController().signal, isCurrent: () => true,
      });
      const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
      await expect(adapter?.probeModelsRaw?.({ cwd: toolRoot, timeoutMs: 10_000, accountSettings: null })).resolves.toEqual([
        { modelId: 'model-a', name: 'A', modelOptions: [{ id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] }] },
        { modelId: 'model-b', name: 'B' },
      ]);
    } finally { await rm(toolRoot, { recursive: true, force: true }); }
  });

  beforeEach(() => {
    runBackendSessionCliCommandMock.mockClear();
  });

  it('projects the exact registered daemon-spawn hook', async () => {
    const hooks = Object.freeze({ augmentEnv: () => ({ ACME: '1' }) });
    await expect(
      projectAgentDaemonSpawnHooksCatalogEntry(hooks).getDaemonSpawnHooks?.(),
    ).resolves.toBe(hooks);
  });

  it('fences deferred-startup and experimental resume callbacks to their generation', async () => {
    const shouldUseDeferredBootstrap = vi.fn(() => true);
    const supportsVendorResume = vi.fn(() => true);
    let current = true;
    const startup = projectAgentSessionStartupCatalogEntry({
      sessionStartup: { shouldUseDeferredBootstrap },
      isCurrent: () => current,
    });
    const resume = projectAgentExperimentalVendorResumeSupportCatalogEntry({
      vendorResumeSupport: { supportsVendorResume },
      isCurrent: () => current,
    });
    const input = {
      startedBy: 'terminal' as const,
      startingMode: 'terminal' as const,
      hasExistingSession: false,
      hasSessionAttachFile: false,
      hasProviderResumeId: false,
      hasExplicitPermissionMode: false,
      hasPersistedPermissionModeSeed: false,
      hasTerminalTty: true,
    };
    const supportsResume = await resume.getVendorResumeSupport?.();

    expect(startup.shouldUseDeferredSessionStartup?.(input)).toBe(true);
    expect(supportsResume?.({ agentRuntimeSelection: { mode: 'acp' } })).toBe(true);
    current = false;
    expect(startup.shouldUseDeferredSessionStartup?.(input)).toBe(false);
    expect(supportsResume?.({ agentRuntimeSelection: { mode: 'acp' } })).toBe(false);
    expect(shouldUseDeferredBootstrap).toHaveBeenCalledTimes(1);
    expect(supportsVendorResume).toHaveBeenCalledTimes(1);
  });

  it('projects Connected Account launch facts and fences continuity callbacks to their generation', async () => {
    let current = true;
    let settleReachability!: (value: Readonly<{ ok: true }>) => void;
    const verifyResumeReachable = vi.fn(() => new Promise<Readonly<{ ok: true }>>((resolve) => {
      settleReachability = resolve;
    }));
    const projected = projectAgentConnectedAccountLaunchCatalogEntry({
      pluginId: 'acme.plugin',
      agentId: 'acme.external' as never,
      isCurrent: () => current,
      hostAccess: {
        required: [{
          id: 'external-agent-process',
          capability: 'process',
          reason: 'Launch the external Agent with its selected account environment.',
          scope: {
            executables: [{ kind: 'systemTool', id: 'external-agent-cli' }],
            envKeys: ['ACME_CONFIG_DIR'],
          },
        }],
        optional: [],
      },
      connectedAccountLaunch: {
        switchContinuity: {
          continuityMode: 'restart_same_home',
          supportedTransitions: ['native_to_connected'],
          providerStateSharingRequired: {
            serviceIds: ['acme-account'],
            supportedTransitions: ['connected_to_native'],
          },
        },
        requestAuthUses: [{
          purpose: 'model_upstream',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
          },
        }],
        stateSharingDescriptor: {
          providerSupportStatus: 'supported',
          config: { supported: true, modes: ['linked'], entries: [] },
          state: {
            supported: true,
            modes: ['isolated'],
            entries: [],
            symlinkUnavailableDegradePolicy: 'block_continuity',
          },
          authIsolation: { mode: 'materialized_home', secretEntries: [] },
          nativeHome: {
            environmentKey: 'ACME_CONFIG_DIR',
            defaultRelativePath: '.acme',
          },
        },
        continuity: {
          verifyResumeReachable,
        },
      },
    });

    expect(projected.connectedAccountRequestAuthUses).toHaveLength(1);
    expect(projected.connectedAccountSwitchContinuity).toEqual({
      continuityMode: 'restart_same_home',
      supportedTransitions: ['native_to_connected'],
      providerStateSharingRequired: {
        serviceIds: ['acme.plugin/acme-account'],
        supportedTransitions: ['connected_to_native'],
      },
    });
    await expect(projected.getConnectedServiceStateSharingDescriptor?.()).resolves.toMatchObject({
      providerId: 'acme.external',
      providerSupportStatus: 'supported',
    });
    expect(projected).not.toHaveProperty('getConnectedServicesMaterializer');
    expect(projected).not.toHaveProperty('resolveConnectedServiceMaterializedHomeRoot');
    expect(projected.connectedAccountNativeHome).toEqual({
      environmentKey: 'ACME_CONFIG_DIR', defaultRelativePath: '.acme',
    });

    const late = projected.verifyResumeReachable?.({
      vendorResumeId: 'vendor-1',
      sessionFiles: {
        verifyDeclaredPaths: async () => ({ found: false }),
    findDeclaredCandidate: async () => ({ found: true }),
      },
    });
    current = false;
    settleReachability({ ok: true });
    expect(projected.connectedAccountNativeHome).toBeUndefined();
    await expect(late).resolves.toEqual({
      ok: false,
      reason: 'plugin_generation_retired',
    });
    expect(verifyResumeReachable).toHaveBeenCalledTimes(1);
  });

  describe('prepared group credentials', () => {
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
    beforeAll(async () => {
      runtime = await createAdmittedPluginRuntimeFixture({
        controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.agent.codex'] },
      });
    });
    afterAll(async () => await runtime?.dispose());
    it.each(['group_current', 'group_superseded', 'group_same_account_superseded', 'group_malformed', 'profile'] as const)('proves prepared group credentials without a late write for %s', async scenario => {
      const root = await mkdtemp(join(tmpdir(), 'happier-codex-runtime-persistence-'));
      try {
        const authPath = join(root, 'auth.json');
        const preparedAuth = JSON.stringify({ auth_mode: 'chatgptAuthTokens', tokens: {
          access_token: 'candidate-b-access', refresh_token: '', id_token: 'candidate-b-id', account_id: 'provider-b',
        }, last_refresh: '2026-06-06T13:15:00.000Z' });
        await writeFile(authPath, preparedAuth);
        const candidate = buildConnectedServiceCredentialRecord({
          now: 1_000, serviceId: 'openai-codex', profileId: 'account-b', kind: 'oauth',
          oauth: { accessToken: 'candidate-b-access', refreshToken: 'candidate-b-refresh', idToken: 'candidate-b-id',
            providerAccountId: 'provider-b', providerEmail: null, scope: null, tokenType: null },
        });
        const entry = await runtime.registry.acquireAgentCatalogEntry!('codex');
        const adapter = await entry!.getConnectedServiceRuntimeAuthAdapter!();
        const nativeHome = await createConnectedServiceRuntimeAuthNativeHome({ agentId: 'codex', root });
        expect(nativeHome).not.toBeNull();
        let finishNativeApply!: (value: AgentSessionRuntimeAuthApplyResult) => void;
        let enteredNativeApply!: () => void;
        const nativeApplyEntered = new Promise<void>(resolve => { enteredNativeApply = resolve; });
        const nativeApply = new Promise<AgentSessionRuntimeAuthApplyResult>(resolve => { finishNativeApply = resolve; });
        // The process RPC is the only substituted boundary; codec, host adapter and native files are real.
        const pending = adapter!.hotApply({
          target: { agentId: 'codex' }, credential: candidate, nativeHome: nativeHome!,
          selection: scenario === 'profile'
            ? { kind: 'profile', serviceId: 'happier.agent.codex/openai-codex', profileId: 'account-b' }
            : { kind: 'group', serviceId: 'happier.agent.codex/openai-codex', activeProfileId: 'account-b', groupId: 'pool', generation: 7 },
          applySelectedAuthGeneration: async () => { enteredNativeApply(); return await nativeApply; },
        });
        await nativeApplyEntered;
        const supersedingAuth = scenario === 'group_malformed'
          ? JSON.stringify({ tokens: { account_id: 'provider-b' } })
          : JSON.stringify({ auth_mode: 'chatgptAuthTokens', tokens: {
          access_token: 'prepared-c-access', refresh_token: '', id_token: 'prepared-c-id', account_id: 'provider-c',
        }, last_refresh: '2026-06-06T13:15:00.000Z' });
        const replacementAuth = scenario === 'group_same_account_superseded'
          ? supersedingAuth.replace('provider-c', 'provider-b')
          : supersedingAuth;
        const superseded = scenario !== 'group_current' && scenario !== 'profile';
        if (superseded) await writeFile(authPath, replacementAuth);
        finishNativeApply({ ok: true, appliedVia: 'native_rpc' });
        const result = await pending;
        if (superseded) {
          expect(result).toMatchObject({ applied: false, reason: 'provider_account_auth_store_mismatch' });
          expect(await readFile(authPath, 'utf8')).toBe(replacementAuth);
        } else {
          expect(result).toEqual(expect.objectContaining({ applied: true }));
          if (scenario === 'group_current') expect(await readFile(authPath, 'utf8')).toBe(preparedAuth);
          else expect(JSON.parse(await readFile(authPath, 'utf8'))).toMatchObject({ tokens: { access_token: 'candidate-b-access' } });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it('keeps credential, declared-file, and currentness custody behind typed native-auth operations', async () => {
    const materialize = vi.fn(({ credential, selection }) => ({
      files: {
        'auth.json': new TextEncoder().encode(JSON.stringify({
          profileId: credential.profileId,
          generation: selection.generation,
        })),
      },
    }));
    const inspect = vi.fn(({ credential, files }) => ({
      status: 'verified' as const,
      providerAccountId: credential.kind === 'oauth'
        ? credential.oauth.providerAccountId
        : null,
      source: new TextDecoder().decode(files['auth.json']),
    }));
    const hotApply = vi.fn<AgentConnectedAccountRuntimeAuthAdapterV1['hotApply']>(async (input) => {
      expect(input).not.toHaveProperty('credential');
      expect(input).not.toHaveProperty('nativeHome');
      expect(input).not.toHaveProperty('runtimeControl');
      expect(input).not.toHaveProperty('validateCurrentBeforeMutation');
      const verification = await input.materializeNativeAuth?.();
      return {
        applied: verification?.status === 'verified',
        verification,
      };
    });
    const runtimeAuthAdapter: AgentConnectedAccountRuntimeAuthAdapterV1 = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({ supported: true }),
      canHotApply: () => ({ supported: true }),
      hotApply,
      probeQuota: async () => ({ status: 'unsupported' }),
      refreshActiveProfile: async () => ({ status: 'unsupported' }),
    };
    const readFiles = vi.fn(async () => ({
      'auth.json': new TextEncoder().encode('{"old":true}'),
    }));
    const replaceFiles = vi.fn(async () => undefined);
    const validateCurrentBeforeMutation = vi.fn(async () => ({ current: true as const }));
    const projected = projectAgentConnectedAccountLaunchCatalogEntry({
      pluginId: 'acme.plugin',
      agentId: 'acme.external' as never,
      isCurrent: () => true,
      connectedAccountLaunch: {
        stateSharingDescriptor: {
          providerSupportStatus: 'supported',
          config: { supported: false, modes: [], entries: [] },
          state: {
            supported: false,
            modes: [],
            entries: [],
            symlinkUnavailableDegradePolicy: 'block_continuity',
          },
          authIsolation: { mode: 'materialized_home', secretEntries: ['auth.json'] },
        },
        continuity: {
          nativeAuthCodec: { materialize, inspect },
          runtimeAuthAdapter,
        },
      },
    });
    const adapter = await projected.getConnectedServiceRuntimeAuthAdapter?.();
    const result = await adapter?.hotApply({
      target: { agentId: 'acme.external' },
      selection: {
        kind: 'profile',
        serviceId: 'acme.plugin/acme-service',
        profileId: 'profile-1',
        credentialRevision: 'revision-1',
      },
      credential: {
        v: 1,
        kind: 'oauth',
        serviceId: 'openai-codex',
        profileId: 'profile-1',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: null,
        oauth: {
          accessToken: 'secret-token',
          refreshToken: 'secret-refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'account-1',
          providerEmail: null,
          raw: null,
        },
        token: null,
      },
      nativeHome: { readFiles, replaceFiles },
      validateCurrentBeforeMutation,
    });

    expect(result).toMatchObject({ applied: true });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(validateCurrentBeforeMutation).toHaveBeenCalledTimes(1);
    expect(validateCurrentBeforeMutation.mock.invocationCallOrder[0])
      .toBeLessThan(replaceFiles.mock.invocationCallOrder[0]!);
    expect(replaceFiles).toHaveBeenCalledWith({
      'auth.json': expect.any(Uint8Array),
    });
    expect(hotApply).toHaveBeenCalledTimes(1);
  });

  it('rejects Connected Account launch environment outside registration-owned host access', () => {
    expect(() => projectAgentConnectedAccountLaunchCatalogEntry({
      pluginId: 'acme.plugin',
      agentId: 'acme.external' as never,
      isCurrent: () => true,
      hostAccess: { required: [], optional: [] },
      connectedAccountLaunch: {
        environmentUses: [{
          purpose: 'model_upstream_api_key',
          environmentKey: 'ACME_API_KEY',
        }],
      },
    })).toThrow("Agent 'acme.external' connected-account launch environment 'ACME_API_KEY' is not declared");
  });

  it('uses the same session runtime descriptor for plugin variant and discovery', async () => {
    const runtimeDescriptorV1 = { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } };
    const resolveMode = (input: Parameters<NonNullable<AgentPreflightSessionControlsContributionV1['resolveProbeVariant']>>[0]) =>
      String(input.runtimeDescriptorV1?.agent.backendMode ?? input.accountSettings?.mode);
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'codex', systemTools: [], retirementSignal: new AbortController().signal, isCurrent: () => true,
      preflightSessionControls: { resolveProbeVariant: resolveMode,
        probeModels: context => [{ id: resolveMode(context), name: resolveMode(context) }] },
    });
    const input = { runtimeDescriptorV1, accountSettings: { mode: 'acp' } };
    expect(projected.resolveModelsProbeVariant?.(input)).toBe('appServer');
    const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
    await expect(adapter?.probeModelsRaw?.({ ...input, cwd: process.cwd(), timeoutMs: 1_000 }))
      .resolves.toEqual([{ id: 'appServer', name: 'appServer' }]);
  });

  it('materializes prepared command arguments with host environment custody and cleans their files', async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), 'happier-prepared-preflight-'));
    await mkdir(join(toolRoot, 'extensions'));
    await writeFile(join(toolRoot, 'extensions/auth.js'), 'auth fixture');
    const script = `const fs = require('node:fs'); const path = process.argv[1];
      process.stdout.write(JSON.stringify({ path, contents: fs.readFileSync(path, 'utf8'), selectedPath: process.argv[2] }));`;
    const command = {
      toolId: 'external-agent-cli', args: ['-e', script], environmentKeys: ['AGENT_HOME'],
      prepareCommand: ({ environment, bypassCache }: { environment: Readonly<Record<string, boolean>>; bypassCache?: boolean }) => ({
        args: ['-e', script,
          { kind: 'temporaryTextFile' as const, suffix: '.mjs', contents: JSON.stringify({ force: bypassCache === true, homePresent: environment.AGENT_HOME }) },
          { kind: 'environmentPath' as const, key: 'AGENT_HOME', relativePath: 'extensions/auth.js' },
        ],
      }),
    };
    const project = (includePreparation: boolean) => projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'acme.external-agent' as never,
      preflightSessionControls: { models: { command: includePreparation ? command : { ...command, prepareCommand: undefined }, parseOutput: ({ stdout }) => JSON.parse(stdout) } },
      systemTools: [{ id: 'external-agent-cli', title: 'External Agent CLI', executableNames: [writePreflightFixtureExecutable(toolRoot)] }],
      retirementSignal: new AbortController().signal, isCurrent: () => true,
    });
    try {
      // The same real executable without preparation cannot discover an artifact.
      // This is the old static-command path, not a mock of the preparation owner.
      const staticAdapter = await project(false).getPreflightSessionControlsProbeAdapter?.();
      await expect(staticAdapter?.probeModelsRaw?.({ cwd: toolRoot, timeoutMs: 5_000, env: { AGENT_HOME: toolRoot } })).resolves.toBeNull();
      const adapter = await project(true).getPreflightSessionControlsProbeAdapter?.();
      const result = await adapter?.probeModelsRaw?.({ cwd: toolRoot, timeoutMs: 5_000, bypassCache: true, env: { AGENT_HOME: toolRoot } });
      expect(result).toMatchObject({ contents: '{"force":true,"homePresent":true}', selectedPath: join(await realpath(toolRoot), 'extensions/auth.js') });
      const path = (result as { path: string }).path;
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(toolRoot, { recursive: true, force: true }); }
  });

  it.each(['../outside.js', '..\\outside.js', '/outside.js', 'C:\\outside.js'])(
    'rejects escaping prepared paths and cleans files created before rejection: %s', async (relativePath) => {
      const toolRoot = await mkdtemp(join(tmpdir(), 'happier-prepared-reject-'));
      const artifactsRoot = join(toolRoot, 'artifacts');
      await mkdir(artifactsRoot);
      for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, artifactsRoot);
      try {
        const projected = projectAgentPreflightSessionControlsCatalogEntry({
          agentId: 'acme.external-agent' as never,
          preflightSessionControls: { models: { command: {
            toolId: 'external-agent-cli', args: ['-e', "throw Error('must not execute')"], environmentKeys: ['AGENT_HOME'],
            prepareCommand: () => ({ args: [
              { kind: 'temporaryTextFile', suffix: '.mjs', contents: 'ephemeral' },
              { kind: 'environmentPath', key: 'AGENT_HOME', relativePath },
            ] }),
          } } },
          systemTools: [{ id: 'external-agent-cli', title: 'External Agent CLI', executableNames: [writePreflightFixtureExecutable(toolRoot)] }],
          retirementSignal: new AbortController().signal, isCurrent: () => true,
        });
        const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
        await expect(adapter?.probeModelsRaw?.({ cwd: toolRoot, timeoutMs: 5_000, env: { AGENT_HOME: toolRoot } })).resolves.toBeNull();
        const protectedArtifactsRoot = getHappierTempRoot(artifactsRoot);
        expect(await readdir(protectedArtifactsRoot)).toEqual([]);
        expect(await readdir(artifactsRoot)).toEqual([basename(protectedArtifactsRoot)]);
      } finally { vi.unstubAllEnvs(); await rm(toolRoot, { recursive: true, force: true }); }
    },
  );

  it('retains a prepared file during execution and removes it after cancellation', async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), 'happier-prepared-cancel-'));
    const witness = join(toolRoot, 'started.json');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(witness)}, JSON.stringify(process.argv[1])); setInterval(() => {}, 1000);`;
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'acme.external-agent' as never,
      preflightSessionControls: { models: { command: {
        toolId: 'external-agent-cli', args: ['-e', script],
        prepareCommand: () => ({ args: ['-e', script, { kind: 'temporaryTextFile', suffix: '.mjs', contents: 'ephemeral' }] }),
      } } },
      systemTools: [{ id: 'external-agent-cli', title: 'External Agent CLI', executableNames: [writePreflightFixtureExecutable(toolRoot)] }],
      retirementSignal: new AbortController().signal, isCurrent: () => true,
    });
    const controller = new AbortController();
    try {
      const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
      const pending = adapter?.probeModelsRaw?.({ cwd: toolRoot, timeoutMs: 10_000, signal: controller.signal });
      await vi.waitFor(async () => { await access(witness); }, { timeout: 5_000 });
      const path = JSON.parse(await readFile(witness, 'utf8')) as string;
      await access(path);
      controller.abort();
      await expect(pending).resolves.toBeNull();
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { controller.abort(); await rm(toolRoot, { recursive: true, force: true }); }
  }, 15_000);

  it('runs a declared preflight command through host environment policy', async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), 'happier-agent-preflight-'));
    const executable = writeExecutableShimSync({
      dir: toolRoot,
      fileName: process.platform === 'win32' ? 'external-agent.cmd' : 'external-agent',
      contents: process.platform === 'win32'
        ? ['@echo off', 'set ci=0', 'if defined CI set ci=1', 'set keep=0', 'if defined KEEP set keep=1', 'set drop=0', 'if defined DROP set drop=1', 'echo %ci%|%keep%|%drop%'].join('\r\n')
        : ['#!/bin/sh', 'ci=0; [ -n "${CI+x}" ] && ci=1', 'keep=0; [ -n "${KEEP+x}" ] && keep=1', 'drop=0; [ -n "${DROP+x}" ] && drop=1', 'printf "%s|%s|%s\\n" "$ci" "$keep" "$drop"'].join('\n'),
    });
    const preflightSessionControls = {
      models: {
        command: {
          toolId: 'external-agent-cli',
          args: ['models'],
          environmentExcludeKeys: ['DROP'],
          ci: 'omit',
        },
        parseOutput: ({ stdout }) => stdout.trim(),
      },
    } satisfies AgentPreflightSessionControlsContributionV1;
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'acme.external-agent' as never,
      preflightSessionControls,
      systemTools: [{
        id: 'external-agent-cli',
        title: 'External Agent CLI',
        executableNames: [executable],
      }],
      retirementSignal: new AbortController().signal,
      isCurrent: () => true,
    });

    try {
      const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
      await expect(adapter?.probeModelsRaw?.({
        cwd: toolRoot,
        timeoutMs: 1_500,
        backendTarget: undefined,
        accountSettings: null,
        env: { CI: 'ambient', KEEP: 'kept', DROP: 'dropped' },
      })).resolves.toBe('0|1|0');
    } finally {
      await rm(toolRoot, { recursive: true, force: true });
    }
  });

  it('selects a declared preflight command tool from account settings and partitions its cache variant', async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), 'happier-agent-preflight-tool-selection-'));
    const autoExecutable = writeExecutableShimSync({
      dir: toolRoot,
      fileName: process.platform === 'win32' ? 'external-auto.cmd' : 'external-auto',
      contents: process.platform === 'win32' ? '@echo off\necho auto' : '#!/bin/sh\nprintf auto',
    });
    const v2Executable = writeExecutableShimSync({
      dir: toolRoot,
      fileName: process.platform === 'win32' ? 'external-v2.cmd' : 'external-v2',
      contents: process.platform === 'win32' ? '@echo off\necho v2' : '#!/bin/sh\nprintf v2',
    });
    const preflightSessionControls = {
      models: {
        commandToolIds: ['external-auto', 'external-v2'],
        resolveCommandToolId: ({ accountSettings }) => (
          accountSettings?.generation === 'v2' ? 'external-v2' : 'external-auto'
        ),
        command: { toolId: 'external-auto', args: ['models'] },
        parseOutput: ({ stdout }) => stdout.trim(),
      },
    } satisfies AgentPreflightSessionControlsContributionV1;
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'acme.external-agent' as never,
      preflightSessionControls,
      systemTools: [
        { id: 'external-auto', title: 'External Auto', executableNames: [autoExecutable] },
        { id: 'external-v2', title: 'External V2', executableNames: [v2Executable] },
      ],
      retirementSignal: new AbortController().signal,
      isCurrent: () => true,
    });

    try {
      expect(projected.needsAccountSettingsForProbes).toBe(true);
      expect(projected.resolveModelsProbeVariant?.({
        accountSettings: { generation: 'v2' },
      })).toContain('tool:external-v2');
      const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
      await expect(adapter?.probeModelsRaw?.({
        cwd: toolRoot,
        timeoutMs: 1_500,
        backendTarget: undefined,
        accountSettings: { generation: 'v2' },
      })).resolves.toBe('v2');
    } finally {
      await rm(toolRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a preflight command tool selector returns an undeclared tool id', async () => {
    const preflightSessionControls = {
      models: {
        commandToolIds: ['external-auto'],
        resolveCommandToolId: () => 'external-undeclared',
        command: { toolId: 'external-auto', args: ['models'] },
      },
    } satisfies AgentPreflightSessionControlsContributionV1;
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'acme.external-agent' as never,
      preflightSessionControls,
      systemTools: [{ id: 'external-auto', title: 'External Auto', executableNames: ['external-auto'] }],
      retirementSignal: new AbortController().signal,
      isCurrent: () => true,
    });

    const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
    await expect(adapter?.probeModelsRaw?.({
      cwd: process.cwd(),
      timeoutMs: 1_500,
      backendTarget: undefined,
      accountSettings: null,
    })).resolves.toBeNull();
  });

  it('shares one timeout budget between the primary and fallback model commands', async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), 'happier-agent-preflight-shared-budget-'));
    const executable = writeExecutableShimSync({
      dir: toolRoot,
      fileName: process.platform === 'win32' ? 'models.cmd' : 'models',
      contents: process.platform === 'win32' ? '@echo off\necho primary' : '#!/bin/sh\nprintf primary',
    });
    const realDateNow = Date.now.bind(Date);
    let elapsedMs = 0;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + elapsedMs);
    const primaryParseOutput = vi.fn(({ stdout }: Readonly<{ stdout: string }>) => {
      expect(stdout.trim()).toBe('primary');
      elapsedMs = 1_500;
      return null;
    });
    const fallbackParseOutput = vi.fn(() => 'fallback');
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'acme.external-agent' as never,
      preflightSessionControls: {
        models: {
          command: { toolId: 'external-models', args: ['primary'] },
          parseOutput: primaryParseOutput,
          fallback: {
            command: { toolId: 'external-models', args: ['fallback'] },
            parseOutput: fallbackParseOutput,
          },
        },
      },
      systemTools: [{ id: 'external-models', title: 'External models', executableNames: [executable] }],
      retirementSignal: new AbortController().signal,
      isCurrent: () => true,
    });

    try {
      const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
      await expect(adapter?.probeModelsRaw?.({
        cwd: toolRoot,
        timeoutMs: 1_500,
        backendTarget: undefined,
        accountSettings: null,
      })).resolves.toBeNull();
      // A failed OS fixture must not masquerade as the exhausted-budget case.
      expect(primaryParseOutput).toHaveBeenCalledOnce();
      expect(fallbackParseOutput).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
      await rm(toolRoot, { recursive: true, force: true });
    }
  });

  it('projects Agent CLI options through the host command owner', async () => {
    let current = true;
    const buildSessionOptions = vi.fn(() => ({
      ok: true as const,
      options: { externalAgentArgs: ['--fast'] },
    }));
    const declaration = {
      sessionRuntimeId: 'acme.external.backend',
      accountSettingsAgentId: 'acme.external',
      buildSessionOptions,
    } satisfies AgentCliSessionCommandDeclarationV1;
    const projected = projectAgentCliSessionCommandCatalogEntry({
      agentId: 'acme.external' as never,
      cliSessionCommand: declaration,
      isCurrent: () => current,
    });
    const handler = await projected.getCliCommandHandler?.();

    await handler?.({
      args: ['acme.external'],
      rawArgv: ['happier', 'acme.external'],
      terminalRuntime: null,
    });
    expect(runBackendSessionCliCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      backendIdForSessionRuntime: 'acme.external.backend',
      runtimeAuthorityAgentId: 'acme.external',
      agentIdForAccountSettings: 'acme.external',
      isExplicitCliSubcommand: true,
      resolveSessionRuntimePreferences: projected.resolveSessionRuntimePreferences,
    }));
    const preferencesInput = {
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
      settings: {},
      pluginSettings: {},
      environment: {},
      startOrigin: 'terminal' as const,
    };
    await expect(projected.resolveSessionRuntimePreferences?.(preferencesInput)).resolves.toEqual({
      externalAgentArgs: ['--fast'],
    });

    current = false;
    await handler?.({
      args: ['acme.external'],
      rawArgv: ['happier', 'acme.external'],
      terminalRuntime: null,
    });
    expect(runBackendSessionCliCommandMock).toHaveBeenCalledTimes(1);
    await expect(projected.resolveSessionRuntimePreferences?.(preferencesInput)).resolves.toEqual({});
    expect(buildSessionOptions).toHaveBeenCalledTimes(1);
  });

  it('injects only the owner-provided non-secret Settings projection for an Agent launch', async () => {
    const readOwnedMode = (
      scope: Readonly<Record<string, unknown>> | undefined,
    ): string | null => (
      typeof scope?.ownedMode === 'string' ? scope.ownedMode : null
    );
    const buildSessionOptions = vi.fn((input: AgentCliSessionCommandBuildInputV1) => ({
      ok: true as const,
      options: {
        accountSelected: readOwnedMode(input.pluginSettings.account),
        daemonSelected: readOwnedMode(input.pluginSettings.daemon),
      },
    }));
    const projected = projectAgentCliSessionCommandCatalogEntry({
      agentId: 'acme.external' as never,
      cliSessionCommand: {
        sessionRuntimeId: 'acme.external.backend',
        accountSettingsAgentId: 'acme.external',
        buildSessionOptions,
      },
      resolvePluginSettings: async () => ({
        account: { ownedMode: 'safe' },
        daemon: { ownedMode: 'daemon-safe' },
      }),
    });
    await expect(projected.resolveSessionRuntimePreferences?.({
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
      settings: { ownedMode: 'wrong-host-value' },
      pluginSettings: {},
      environment: {},
      startOrigin: 'terminal',
    })).resolves.toEqual({ accountSelected: 'safe', daemonSelected: 'daemon-safe' });
    expect(buildSessionOptions).toHaveBeenCalledWith(expect.objectContaining({
      pluginSettings: {
        account: { ownedMode: 'safe' },
        daemon: { ownedMode: 'daemon-safe' },
      },
    }));
  });

  it('refuses a retained CLI handler when its generation retires during async delegation', async () => {
    let current = true;
    let settleDelegation!: (value: { kind: 'continue' }) => void;
    const runBackendSessionCliCommand = vi.fn(async () => undefined);
    const getHandler = createCliSessionCommandHandler(
      {
        sessionRuntimeId: 'acme.external',
        accountSettingsAgentId: 'acme.external',
        implicitResumeDelegation: { resumeFlags: ['--resume'] },
      },
      {
        cliSubcommand: 'acme.external',
        runtimeAuthorityAgentId: 'acme.external',
      },
      null,
      {
        runBackendSessionCliCommand,
        resolveSessionCommandResumeDelegation: async () => await new Promise((resolve) => {
          settleDelegation = resolve;
        }),
      },
      () => current,
    );
    const handler = await getHandler();
    const invocation = handler({
      args: ['--resume', 'session-1'],
      rawArgv: ['happier', '--resume', 'session-1'],
      terminalRuntime: null,
    });

    current = false;
    settleDelegation({ kind: 'continue' });
    await invocation;

    expect(runBackendSessionCliCommand).not.toHaveBeenCalled();
  });
});
