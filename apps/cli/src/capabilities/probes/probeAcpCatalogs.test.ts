import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { createLocalPathPluginDistributionIdentity, createPluginTrustRecord } from '@/plugins/store/install/trustIdentity';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { ANTIGRAVITY_PLUGIN } from '@happier-dev/plugins-antigravity';
import { resolveInstallablesRegistry, type InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';
import { createStablePluginManagedDependenciesHost } from '@/plugins/runtime/invocation/services/managedDependencies';
import { CURSOR_PLUGIN } from '@happier-dev/plugins-cursor';
import { OH_MY_PI_PLUGIN } from '@happier-dev/plugins-ohmypi';
import { GEMINI_PLUGIN } from '@happier-dev/plugins-gemini';

import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { projectManifestAgentAcpCatalogPreflight } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';

import { probeAcpCatalogs } from './probeAcpCatalogs';

const commands = [{ name: 'review', description: 'Review the project', input: { hint: 'target' } }];

function writeFixture(dir: string, scenario: 'before' | 'after' | 'empty' | 'absent' | 'auth' | 'authMissing' | 'exit' | 'ohmypi' | 'cursor' | 'antigravity' | 'authRequired' | 'cursorModels') {
  const evidencePath = join(dir, 'requests.jsonl');
  const script = writeAcpTestAgentScript({ dir, fileName: 'catalog-agent.mjs', source: `
    import { appendFileSync } from 'node:fs';
    const scenario = ${JSON.stringify(scenario)};
    if (scenario === 'ohmypi' && JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--mode', 'acp'])) process.exit(2);
    if (scenario === 'cursor' && JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['-e', 'https://cursor.fixture.invalid', 'acp'])) process.exit(2);
    if (scenario === 'cursorModels') {
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['-e', 'https://cursor.fixture.invalid', 'models'])) process.exit(2);
      process.stdout.write('fixture-cursor-model - Selected Endpoint Model\\n');
      process.exit(0);
    }
    const record = (method, params) => appendFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({ method, params }) + '\\n');
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
    const publish = (sessionId, availableCommands) => send({ method: 'session/update', params: {
      sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands },
    } });
    let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\\n'); buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.method) record(request.method, request.params);
        if (request.id === 'permission') { record('permission-result', request.result); continue; }
        if (request.method === 'initialize') send({ id: request.id, result: {
          protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } },
          authMethods: (scenario === 'antigravity' || scenario === 'authRequired') ? [{ id: 'oauth-personal', name: 'Antigravity cached login' }] : scenario === 'auth' ? [{ id: 'fixture-native', name: 'Fixture native auth' }] : scenario === 'cursor' ? [{ id: 'cursor_login', name: 'Cursor cached login' }] : [],
        } });
        else if (request.method === 'authenticate') send({ id: request.id, result: {} });
        else if (request.method === 'session/new') {
          if (scenario === 'authRequired') { send({ id: request.id, error: { code: -32000, message: 'Authentication required' } }); continue; }
          send({ id: 'permission', method: 'session/request_permission', params: { sessionId: 'native-session', toolCall: { toolCallId: 'fixture' }, options: [] } });
          if (scenario === 'before' || scenario === 'empty' || scenario === 'auth' || scenario === 'ohmypi' || scenario === 'cursor' || scenario === 'antigravity') {
            publish('native-session', scenario === 'empty' ? [] : ${JSON.stringify(commands)});
            publish('different-session', [{ name: 'wrong', description: 'Wrong session' }]);
          }
          send({ id: request.id, result: { sessionId: 'native-session' } });
          if (scenario === 'after') setTimeout(() => { publish('different-session', []); publish('native-session', ${JSON.stringify(commands)}); }, 100);
          if (scenario === 'exit') setTimeout(() => process.exit(7), 25);
        }
        else if (request.id !== undefined) send({ id: request.id, result: {} });
      }
    });
  ` });
  return { script, evidencePath };
}

async function runProbe(dir: string, scenario: Parameters<typeof writeFixture>[1]) {
  const fixture = writeFixture(dir, scenario);
  const controller = new AbortController();
  // The fixture owns this cancellation budget, as the preflight host does in production.
  const timer = setTimeout(() => controller.abort(new Error('Fixture probe deadline')), scenario === 'absent' ? 1_500 : 10_000);
  const executable = { kind: 'systemTool' as const, id: 'fixture-acp' };
  const service = createStablePluginExecService({
    allowedExecutables: [executable], allowedEnvKeys: [], signal: controller.signal, isOccurrenceCurrent: () => true,
    resolveExecutable: async () => ({ command: process.execPath, args: [fixture.script] }),
    resolvePath: async () => dir,
  });
  const handle = await service.clients.spawn({
    kind: 'jsonRpc', launch: { executable, cwd: { root: 'workspace', relativePath: '' } },
    framing: 'jsonLines', maxFrameBytes: 65_536, requestTimeoutMs: 10_000,
  }, { signal: controller.signal });
  try {
    return await probeAcpCatalogs({
      client: handle.client, cwd: dir, signal: controller.signal,
      ...((scenario === 'auth' || scenario === 'authMissing') ? { authenticationMethodId: 'fixture-native' } : {}),
    });
  } finally {
    clearTimeout(timer);
    await handle.dispose();
  }
}

describe('ACP preflight catalogs through the host JSON-RPC process owner', () => {
  it.each(['before', 'after'] as const)('observes the matching native session update %s session/new resolves', async (scenario) => {
    await withTempDir('acp-preflight-catalog-', async (dir) => {
      await expect(runProbe(dir, scenario)).resolves.toEqual({ commands, skills: null });
      const evidence = readFileSync(join(dir, 'requests.jsonl'), 'utf8');
      expect(evidence).toContain('"method":"session/close"');
      expect(evidence).toContain('"outcome":"cancelled"');
      expect(evidence).not.toContain('session/prompt');
    });
  });

  it('preserves an observed empty snapshot', async () => {
    await withTempDir('acp-preflight-empty-', async (dir) => {
      await expect(runProbe(dir, 'empty')).resolves.toEqual({ commands: [], skills: null });
    });
  });

  it('treats an absent update as unavailable when the host cancels', async () => {
    await withTempDir('acp-preflight-absent-', async (dir) => {
      await expect(runProbe(dir, 'absent')).rejects.toThrow(/Fixture probe deadline/);
    });
  });

  it('authenticates only through the explicitly declared and advertised native method', async () => {
    await withTempDir('acp-preflight-auth-', async (dir) => {
      await expect(runProbe(dir, 'auth')).resolves.toEqual({ commands, skills: null });
      expect(readFileSync(join(dir, 'requests.jsonl'), 'utf8')).toContain('"method":"authenticate","params":{"methodId":"fixture-native"}');
    });
    await withTempDir('acp-preflight-auth-missing-', async (dir) => {
      await expect(runProbe(dir, 'authMissing')).rejects.toThrow(/advertis/i);
      expect(readFileSync(join(dir, 'requests.jsonl'), 'utf8')).not.toContain('"method":"authenticate"');
    });
  });
});


describe('Oh My Pi preflight catalog registration through host execution', () => {
  it('discovers native commands using the declared ACP startup', async () => {
    const plugin = await createPluginTestkit({ manifest: OH_MY_PI_PLUGIN.manifest, module: { activate: OH_MY_PI_PLUGIN.activate } });
    try {
      const preflight = plugin.registration('agents', 'ohmypi')?.preflightSessionControls;
      expect(preflight).toBeDefined();
      await withTempDir('ohmypi-preflight-catalog-', async (dir) => {
        const fixture = writeFixture(dir, 'ohmypi');
        const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
        const executable = writeExecutableShimSync({
          dir, fileName: process.platform === 'win32' ? 'omp.cmd' : 'omp',
          contents: process.platform === 'win32'
            ? `@echo off\r\n"${process.execPath}" "${fixture.script}" %*\r\n`
            : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture.script)} "$@"\n`,
        });
        const projected = projectAgentPreflightSessionControlsCatalogEntry({
          agentId: 'ohmypi', preflightSessionControls: preflight!,
          systemTools: [{ id: 'ohmypi-cli', title: 'Oh My Pi', executableNames: [executable] }],
          retirementSignal: new AbortController().signal, isCurrent: () => true,
        });
        const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
        expect(adapter?.probeCatalogsRaw).toBeTypeOf('function');
        await expect(adapter?.probeCatalogsRaw?.({ cwd: dir, timeoutMs: 10_000 })).resolves.toEqual({ commands, skills: null });
        const evidence = readFileSync(fixture.evidencePath, 'utf8');
        expect(evidence).toContain('"method":"session/close"');
        expect(evidence).not.toContain('session/prompt');
      });
    } finally {
      await plugin.dispose();
    }
  });
});


describe('Cursor daemon-selected preflight ACP launch', () => {
  it('uses the owning daemon settings for its binary, endpoint, fallback and authentication', async () => {
    const plugin = await createPluginTestkit({ manifest: CURSOR_PLUGIN.manifest, module: { activate: CURSOR_PLUGIN.activate } });
    try {
      const preflight = plugin.registration('agents', 'cursor')?.preflightSessionControls;
      expect(preflight).toBeDefined();
      await withTempDir('cursor-preflight-catalog-', async (dir) => {
        const fixture = writeFixture(dir, 'cursor');
        const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
        const executable = writeExecutableShimSync({
          dir, fileName: process.platform === 'win32' ? 'cursor-selected.cmd' : 'cursor-selected',
          contents: process.platform === 'win32'
            ? `@echo off\r\n"${process.execPath}" "${fixture.script}" %*\r\n`
            : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture.script)} "$@"\n`,
        });
        const projected = projectAgentPreflightSessionControlsCatalogEntry({
          agentId: 'cursor', preflightSessionControls: preflight!,
          systemTools: ['cursor-agent', 'cursor-agent-no-fallback'].map((id) => ({ id, title: id, executableNames: ['missing-cursor-fixture'] })),
          resolvePluginSettings: async () => ({ daemon: {
            cursorBinaryPath: executable, cursorAgentFallbackEnabled: false, cursorApiEndpoint: 'https://cursor.fixture.invalid',
          }, account: { cursorBinaryPath: '/wrong-account-path' } }),
          retirementSignal: new AbortController().signal, isCurrent: () => true,
        });
        const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
        expect(adapter?.probeCatalogsRaw).toBeTypeOf('function');
        await expect(adapter?.probeCatalogsRaw?.({ cwd: dir, timeoutMs: 10_000 })).resolves.toEqual({ commands, skills: null });
        expect(readFileSync(fixture.evidencePath, 'utf8')).toContain('"method":"authenticate","params":{"methodId":"cursor_login"}');
        writeFixture(dir, 'cursorModels');
        await expect(adapter?.probeModelsRaw?.({ cwd: dir, timeoutMs: 10_000, pluginSettings: await projected.resolveProbePluginSettings?.() ?? undefined })).resolves.toEqual([
          { id: 'fixture-cursor-model', name: 'Selected Endpoint Model' },
        ]);
      });
    } finally { await plugin.dispose(); }
  });
});


describe('Antigravity declared ready native ACP catalog', () => {
  it('uses the native managed grant and rejects absent grants and unavailable dependencies', async () => {
    const plugin = await createPluginTestkit({ manifest: ANTIGRAVITY_PLUGIN.manifest, module: { activate: ANTIGRAVITY_PLUGIN.activate } });
    try {
      const declaration = PluginManifestV2Schema.parse(ANTIGRAVITY_PLUGIN.manifest).contributes?.agents?.find((agent) => agent.id === 'antigravity');
      const preflight = declaration ? projectManifestAgentAcpCatalogPreflight(declaration, ANTIGRAVITY_PLUGIN.manifest.id)?.contribution : undefined;
      expect(preflight).toBeDefined();
      await withTempDir('antigravity-preflight-catalog-', async (dir) => {
        const fixture = writeFixture(dir, 'antigravity');
        const dependency: InstallableDependencyDescriptor = {
          id: 'agy-acp-server', key: 'agy-acp-server', kind: 'dep', capabilityId: 'dep.agy-acp-server',
          version: 'fixture', capabilityGates: [], permissionGates: [], redaction: 'none', hidden: false,
          display: { name: 'Native ACP fixture' }, description: 'Fixture native executable',
          source: { kind: 'github_release_binary', repo: 'fixture/transport' },
          binary: { commands: ['agy-acp-server'], systemFirst: true, managedFallback: true },
          defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'notify' },
          consent: { install: 'not_required', update: 'not_required' }, stability: { experimental: false, supported: true },
        };
        let ready = true;
        let installations = 0;
        const host = createStablePluginManagedDependenciesHost({
          installablesRegistry: resolveInstallablesRegistry({ externalPlugins: [{
            owner: { provenance: 'external_plugin', ownerId: 'fixture', pluginId: 'happier.agent.antigravity' }, descriptor: dependency,
          }] }),
          getSettings: () => ({ machineId: 'fixture-machine' }),
          // This fixture controls the native executable/install OS boundary, retaining the real managed resolver.
          resolveAdapter: async () => ({ key: dependency.key, capabilityId: dependency.capabilityId,
            detectLaunchResolution: async () => ({ availability: ready ? { ok: true } : { ok: false, errorMessage: 'Native dependency unavailable' }, canAutoInstall: true, canBackgroundAutoUpdate: false }),
            resolveLaunchCommand: async () => ready ? { ok: true, command: process.execPath, args: [fixture.script], source: 'managed' } : { ok: false, errorMessage: 'Native dependency unavailable', canAutoInstall: true },
            installOrUpgrade: async () => { installations += 1; return { ok: true, logPath: null }; },
            runBackgroundAutoUpdateCheck: async () => {},
          }),
          removeManagedInstall: async () => {},
        });
        const ref = { kind: 'managedDependency' as const, id: 'agy-acp-server' };
        const project = (granted: boolean) => projectAgentPreflightSessionControlsCatalogEntry({
          agentId: 'antigravity', preflightSessionControls: preflight!, systemTools: [],
          managedExecutableRefs: granted ? [ref] : [],
          resolveReadyManagedExecutable: (executable) => host.resolveExecutable(executable, 'happier.agent.antigravity', { requireReady: true }),
          retirementSignal: new AbortController().signal, isCurrent: () => true,
        });
        const adapter = await project(true).getPreflightSessionControlsProbeAdapter?.();
        await expect(adapter?.probeCatalogsRaw?.({ cwd: dir, timeoutMs: 10_000 })).resolves.toEqual({ commands, skills: null });
        expect(readFileSync(fixture.evidencePath, 'utf8')).not.toContain('"method":"authenticate"');
        const denied = await project(false).getPreflightSessionControlsProbeAdapter?.();
        await expect(denied?.probeCatalogsRaw?.({ cwd: dir, timeoutMs: 10_000 })).rejects.toThrow();
        writeFixture(dir, 'authRequired');
        await expect(adapter?.probeCatalogsRaw?.({ cwd: dir, timeoutMs: 10_000 })).rejects.toThrow(/Authentication required/);
        expect(readFileSync(fixture.evidencePath, 'utf8')).not.toContain('"method":"authenticate"');
        ready = false;
        await expect(adapter?.probeCatalogsRaw?.({ cwd: dir, timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'plugin_managed_dependency_executable_unavailable' });
        expect(installations).toBe(0);
      });
    } finally { await plugin.dispose(); }
  });
});



async function commitNativePluginFixture(params: Readonly<{ happyHomeDir: string; pluginId: string; pluginRoot: string }>) {
    const distribution = await createLocalPathPluginDistributionIdentity(params.pluginRoot);
    return await writeCommittedLocalPathPluginFixture({
        happyHomeDir: params.happyHomeDir, pluginId: params.pluginId, sourceRootPath: params.pluginRoot,
        plugin: {
            source: { kind: 'path', locator: params.pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                resolvedPath: params.pluginRoot, manifestPath: join(params.pluginRoot, '.happier-plugin', 'plugin.json') },
            compatibility: { status: 'unknown', diagnostics: [] },
            install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null,
                trust: createPluginTrustRecord({ pluginId: params.pluginId, distribution, approvedAtMs: 1 }) },
            state: { enabled: true },
        },
    });
}

describe('admitted declarative ACP catalog producer', () => {
  it('projects the native manifest into an invoked OS ACP probe without plugin runtime registration', async () => {
    await withTempDir('declarative-native-catalog-', async (dir) => {
      const pluginId = 'acme.declarative-catalog';
      const fixture = writeFixture(dir, 'before');
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const executable = writeExecutableShimSync({
        dir, fileName: process.platform === 'win32' ? 'native-acp.cmd' : 'native-acp',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${fixture.script}" %*\r\n`
          : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture.script)} "$@"\n`,
      });
      const pluginRoot = join(dir, 'plugin');
      const happyHomeDir = join(dir, 'home');
      const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
        id: pluginId, entrypoints: undefined,
        hostAccess: { required: [{ id: 'process', capability: 'process', reason: 'Run native ACP fixture', scope: { executables: [{ kind: 'systemTool', id: 'native-acp' }] } }], optional: [] },
        contributes: {
          agents: [{ id: 'native', title: 'Native fixture', primary: 'sessions',
            runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'native-acp' }, preferredPath: executable, args: [] } },
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          }],
          systemTools: [{ id: 'native-acp', title: 'Native ACP fixture', executableNames: ['missing-native-acp'] }],
        },
      }));
      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest));
      await commitNativePluginFixture({ happyHomeDir, pluginId, pluginRoot });
      const sourceSpec = { kind: 'path' as const, locator: pluginRoot, trustPolicy: 'local_trusted' as const, installPolicy: 'link' as const };
      const systemTools = manifest.contributes!.systemTools!;
      const agent = projectManifestAgentContribution({
        definition: manifest.contributes!.agents![0]!, pluginId, provenance: 'external', source: { kind: 'path' },
        systemTools, hostAccess: manifest.hostAccess, sourceSpec,
      });
      const contributes = createResolvedContributionRegistry({
        agents: [agent], activationTargets: [], systemTools: systemTools.map((definition) => ({ provenance: 'external' as const, source: { kind: 'path' as const }, pluginId, sourceSpec, definition })),
      });
      const registry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir, contributes, generation: 1,
        generationAuthority: await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir })) ?? undefined,
      });
      try {
        const catalog = registry.contributes.agents.find((entry) => entry.id === agent.id)?.catalogEntry;
        const adapter = await catalog?.getPreflightSessionControlsProbeAdapter?.();
        expect(adapter?.probeCatalogsRaw).toBeTypeOf('function');
        await expect(adapter?.probeCatalogsRaw?.({ cwd: dir, timeoutMs: 10_000 })).resolves.toEqual({ commands, skills: null });
        expect(readFileSync(fixture.evidencePath, 'utf8')).toContain('"method":"session/new"');
        expect(readFileSync(fixture.evidencePath, 'utf8')).not.toContain('"method":"session/prompt"');
      } finally { await registry.dispose(); }
    });
  });
});


describe('Gemini preflight authentication through native execution', () => {
  function fixture(dir: string, authentication: 'cached' | 'missing') {
    const browserPath = join(dir, 'browser-opened');
    const pidPath = join(dir, 'native-pid');
    const script = writeAcpTestAgentScript({ dir, fileName: 'gemini-catalog.mjs', source: `
      import { writeFileSync } from 'node:fs';
      if (process.argv.includes('--help')) { process.stdout.write('Usage: gemini --acp'); process.exit(0); }
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      const send = (message) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n');
      const refuseAuthentication = (id) => {
        // Gemini v0.38.2 and v0.63.0 suppress browser authentication when CI is nonempty.
        if (!process.env.CI) writeFileSync(${JSON.stringify(browserPath)}, 'opened');
        send({id,error:{code:-32000,message:'Authentication required'}});
      };
      let buffer='';
      process.stdin.on('data',chunk=>{
        buffer+=chunk;const lines=buffer.split('\\n');buffer=lines.pop()||'';
        for(const line of lines){
          if(!line.trim())continue;const request=JSON.parse(line);
          if(request.method==='initialize')send({id:request.id,result:{protocolVersion:1,
            agentCapabilities:{sessionCapabilities:{close:{}}},authMethods:[{id:'oauth-personal',name:'Native login'}]}});
          else if(request.method==='authenticate')refuseAuthentication(request.id);
          else if(request.method==='session/new'){
            if(${JSON.stringify(authentication)}==='missing'){refuseAuthentication(request.id);continue;}
            send({method:'session/update',params:{sessionId:'native-session',update:{
              sessionUpdate:'available_commands_update',availableCommands:${JSON.stringify(commands)}}}});
            send({id:request.id,result:{sessionId:'native-session'}});
          }else if(request.id!==undefined)send({id:request.id,result:{}});
        }
      });
    ` });
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const executable = writeExecutableShimSync({
      dir, fileName: process.platform === 'win32' ? 'gemini.cmd' : 'gemini',
      contents: process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    });
    return { browserPath, pidPath, script, executable };
  }

  it.each(['cached', 'missing'] as const)('does not open a browser during catalog discovery with %s authentication', async (authentication) => {
    const plugin = await createPluginTestkit({ manifest: GEMINI_PLUGIN.manifest, module: { activate: GEMINI_PLUGIN.activate } });
    try {
      const preflight = plugin.registration('agents', 'gemini')?.preflightSessionControls;
      expect(preflight).toBeDefined();
      await withTempDir('gemini-catalog-auth-', async (dir) => {
        const f = fixture(dir, authentication);
        const projected = projectAgentPreflightSessionControlsCatalogEntry({
          agentId: 'gemini', preflightSessionControls: preflight!,
          systemTools: [{ id: 'gemini-cli', title: 'Gemini', executableNames: [f.executable] }],
          retirementSignal: new AbortController().signal, isCurrent: () => true,
        });
        const adapter = (await projected.getPreflightSessionControlsProbeAdapter!())!;
        const discovery = adapter.probeCatalogsRaw!({ cwd: dir, timeoutMs: 10_000, env: { ...process.env, CI: '' } });
        if (authentication === 'cached') await expect(discovery).resolves.toEqual({ commands, skills: null });
        else await expect(discovery).rejects.toThrow();
        expect(existsSync(f.browserPath)).toBe(false);
        expect(() => process.kill(Number(readFileSync(f.pidPath, 'utf8')), 0)).toThrow();
      });
    } finally { await plugin.dispose(); }
  });

  it('keeps browser authentication available for an ordinary native ACP launch', async () => {
    await withTempDir('gemini-ordinary-auth-', async (dir) => {
      const f = fixture(dir, 'missing');
      const executable = { kind: 'systemTool' as const, id: 'gemini-cli' };
      const service = createStablePluginExecService({
        allowedExecutables: [executable], allowedEnvKeys: ['CI'], environment: { CI: '' },
        signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        resolveExecutable: async () => ({ command: process.execPath, args: [f.script, '--acp'] }),
        resolvePath: async () => dir,
      });
      const handle = await service.clients.spawn({ kind: 'jsonRpc', launch: { executable },
        framing: 'jsonLines', maxFrameBytes: 65_536, requestTimeoutMs: 10_000 });
      try {
        await handle.client.request('initialize', { protocolVersion: 1 });
        await expect(handle.client.request('authenticate', { methodId: 'oauth-personal' })).rejects.toThrow();
        expect(existsSync(f.browserPath)).toBe(true);
      } finally { await handle.dispose(); }
      expect(() => process.kill(Number(readFileSync(f.pidPath, 'utf8')), 0)).toThrow();
    });
  });
});
