import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { preparePiHappierToolsExtension } from '../../../../../packages/plugins/pi/src/agent/tools/assets';
import { PI_PROVIDER_BINDING_ADAPTER } from '../../../../../packages/plugins/pi/src/agent/providerBinding';
import { buildPiRpcLaunch } from '../../../../../packages/plugins/pi/src/agent/runtime/rpc/args';
import { PI_REQUEST_AUTH_CAPABILITY_PATH_ENV, resolvePiRequestAuthExtensionPath } from '../../../../../packages/plugins/pi/src/agent/auth/services/requestAuth';
import { authorizeResolvedProjectExecLaunchForHost, createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { deriveAgentIsolationMemberIdentity } from './provisioning';
import { createUnixAgentIdentityLaunch } from './unixAgentIdentityAdapter';
import { readAgentLaunchFrame } from './agentLaunchFrame';
import { executeAgentLaunchPayload } from './agentLaunchShim';

it('refuses the member Pi launch before spawning when its host tools extension is not materialized for the native identity', async () => {
  const memberHome = await mkdtemp(join(tmpdir(), 'pi-member-native-'));
  const tools = await preparePiHappierToolsExtension({ directory: memberHome });
  try {
    // Recorded #144 shape: paired tools flag and extension, bound provider, but
    // host-private extension paths do not exist in the native member namespace.
    const { extensionPath, configPath } = tools;
    // Constructed OS observation: the member UID/home differs from the host
    // that produced these 0700-directory / 0600-file assets. No sudo is needed.
    const memberIdentity = { ...deriveAgentIsolationMemberIdentity({
      homeServerIdentityId: 'home', requester: { serverId: 'home', accountId: 'member',
        machineId: 'team-machine', installationId: 'installation' },
    }), home: memberHome, agentUid: (process.getuid?.() ?? 1000) + 1, agentGid: (process.getgid?.() ?? 1000) + 1 };
    await expect(readFile(extensionPath)).resolves.toBeInstanceOf(Buffer);
    const { args, requiredFiles } = buildPiRpcLaunch({ providerModelId: 'selected-model',
      happierToolsExtension: { extensionPath, configPath } });
    expect(() => createUnixAgentIdentityLaunch({
      managedHappierBinaryPath: '/opt/happier/cli/current/happier', executable: process.execPath,
      args: ['-e', 'process.stdout.write("child-spawned")', '--', ...args],
      cwd: memberHome, runtimeHome: join(memberHome, 'runtime'), environment: {},
      selectedEnvironmentKeys: [], selectedMaterials: [], memberIdentity,
      requiredFiles,
    })).toThrow(expect.objectContaining({ code: 'agent_launch_required_file_unavailable',
      data: expect.objectContaining({ details: { phase: 'materialization', reason: 'not_materialized' } }) }));
  } finally { await tools.dispose(); await rm(memberHome, { recursive: true, force: true }); }
});

it('allows the paired Pi files after their native materialization and retires them with the launch', async () => {
  const memberHome = await mkdtemp(join(tmpdir(), 'pi-member-ready-'));
  const mcpToolPolicy = { a: { unlisted: 'ask' as const, tools: { echo: 'ask' as const } } };
  const tools = await preparePiHappierToolsExtension({ directory: memberHome, mcpToolPolicy });
  try {
    const runtimeHome = join(memberHome, 'runtime');
    const extensionPath = join(runtimeHome, 'files', 'extension.mjs');
    const configPath = join(runtimeHome, 'files', 'config.json');
    const launch = createUnixAgentIdentityLaunch({
      managedHappierBinaryPath: '/opt/happier/cli/current/happier', executable: process.execPath,
      args: ['-e', 'const fs=require("node:fs"); for(const file of process.argv.slice(1).filter(arg=>arg.endsWith(".mjs")||arg.endsWith(".json"))) fs.readFileSync(file); process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--happier-tools-config")+1],"utf8")).mcpToolPolicy))', '--', ...buildPiRpcLaunch({
        happierToolsExtension: { extensionPath, configPath } }).args],
      cwd: memberHome, runtimeHome, environment: {}, selectedEnvironmentKeys: [],
      selectedMaterials: [
        { relativePath: 'files/extension.mjs', contentBase64: (await readFile(tools.extensionPath)).toString('base64') },
        { relativePath: 'files/config.json', contentBase64: (await readFile(tools.configPath)).toString('base64') },
      ],
      requiredFiles: buildPiRpcLaunch({ happierToolsExtension: { extensionPath, configPath } }).requiredFiles,
    });
    const payload = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble], { objectMode: false }));
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
    expect(await executeAgentLaunchPayload(payload, { agentHome: memberHome,
      input: Readable.from([]), stdout, stderr: new PassThrough() })).toEqual({ code: 0, signal: null });
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(mcpToolPolicy);
    await expect(readFile(extensionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await tools.dispose(); await rm(memberHome, { recursive: true, force: true }); }
});

it('requires every configured Pi extension and config, with one dependency per file', () => {
  const runtimeHome = join(tmpdir(), 'pi-selected-runtime');
  const agentDir = join(runtimeHome, 'agent');
  const extensionPath = join(runtimeHome, 'tools.mjs');
  const configPath = join(runtimeHome, 'tools.json');
  const discoveryPath = join(runtimeHome, 'discovery.mjs');
  const expectedFiles = [resolvePiRequestAuthExtensionPath(agentDir), discoveryPath, extensionPath, configPath];
  const launch = buildPiRpcLaunch({ modelDiscoveryExtensionPath: discoveryPath,
    env: { PI_CODING_AGENT_DIR: agentDir, [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/fixture/capability' },
    happierToolsExtension: { extensionPath, configPath } });
  // Four actual roles in a fully configured launch; no duplicate payload entries.
  expect(launch.requiredFiles).toHaveLength(expectedFiles.length);
  for (const missing of expectedFiles) {
    expect(() => createUnixAgentIdentityLaunch({
      managedHappierBinaryPath: '/nonexistent/happier', executable: '/nonexistent/pi', ...launch,
      cwd: runtimeHome, runtimeHome, environment: {}, selectedEnvironmentKeys: [],
      selectedMaterials: expectedFiles.filter(file => file !== missing).map(file => ({
        relativePath: relative(runtimeHome, file), contentBase64: '',
      })),
    })).toThrow(expect.objectContaining({ code: 'agent_launch_required_file_unavailable' }));
  }
});

it('keeps the own-host Pi launch able to read its prepared files without native selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-own-host-'));
  const tools = await preparePiHappierToolsExtension({ directory: root });
  const controller = new AbortController();
  try {
    const exec = createStablePluginExecService({ signal: controller.signal, isOccurrenceCurrent: () => true,
      resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => root });
    const result = await exec.run({ executable: { kind: 'systemTool', id: 'fixture.node' },
      requiredFiles: buildPiRpcLaunch({ happierToolsExtension: tools }).requiredFiles,
      args: ['-e', 'const fs=require("node:fs"); fs.readFileSync(process.argv[1]); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2],"utf8")).directory)',
        tools.extensionPath, tools.configPath], cwd: root });
    expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
    expect(Buffer.from(result.stdout).toString()).toBe(root);
  } finally { controller.abort(); await tools.dispose(); await rm(root, { recursive: true, force: true }); }
});


it.skipIf(process.platform !== 'linux')('selects generated Pi tools for the member at the real exec finalizer and retires the native copies', async () => {
  const memberHome = await mkdtemp(join(tmpdir(), 'pi-member-selected-'));
  const tools = await preparePiHappierToolsExtension({ directory: memberHome, permissionMode: 'read-only' });
  const runtimeHome = join(memberHome, 'runtime');
  const controller = new AbortController();
  try {
    const pi = buildPiRpcLaunch({ happierToolsExtension: tools });
    const launch = await authorizeResolvedProjectExecLaunchForHost({
      launch: { command: process.execPath, args: ['-e',
        'const fs=require("node:fs"); const args=process.argv.slice(1); fs.readFileSync(args[args.indexOf("--extension")+1]); process.stdout.write(fs.readFileSync(args[args.indexOf("--happier-tools-config")+1],"utf8"))',
        '--', ...pi.args], requiredFiles: pi.requiredFiles, cwd: memberHome, env: {} },
      agentIsolation: { read: () => ({ enabled: true,
        status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [memberHome],
        localTransport: { agentUid: 2402, agentGid: 2402 },
        launch: { managedHappierBinaryPath: '/fixture/happier', runtimeHome, selectedEnvironmentKeys: [], selectedMaterials: [] } }) },
      requesterIdentity: { kind: 'isolated', separationRequired: false,
        requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } },
      agentLaunchKind: 'workspaceExec', signal: controller.signal, assertCurrent() {},
    });
    try {
      const payload = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble!], { objectMode: false }));
      const extensionPath = payload.args[payload.args.indexOf('--extension') + 1]!;
      const configPath = payload.args[payload.args.indexOf('--happier-tools-config') + 1]!;
      expect(extensionPath.startsWith(runtimeHome + '/files/')).toBe(true);
      expect(configPath.startsWith(runtimeHome + '/files/')).toBe(true);
      expect(payload.args).not.toContain(tools.extensionPath);
      expect(payload.args).not.toContain(tools.configPath);
      // The same UID executes the real shim; the separate-UID loaded replay belongs to MACH.
      const stdout = new PassThrough();
      const chunks: Buffer[] = [];
      stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
      expect(await executeAgentLaunchPayload(payload, { agentHome: memberHome,
        input: Readable.from([]), stdout, stderr: new PassThrough() })).toEqual({ code: 0, signal: null });
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(JSON.parse(await readFile(tools.configPath, 'utf8')));
      await expect(readFile(extensionPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
      // The plugin retains ownership of its host-side lifetime.
      await expect(readFile(tools.extensionPath)).resolves.toBeInstanceOf(Buffer);
    } finally { await launch.release(); }
  } finally { controller.abort(); await tools.dispose(); await rm(memberHome, { recursive: true, force: true }); }
});


it.skipIf(process.platform !== 'linux')('selects the bound Pi provider catalog into the member native home before construction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-member-provider-'));
  const tools = await preparePiHappierToolsExtension({ directory: root });
  try {
    const sourceHome = join(root, 'provider-binding');
    const runtimeHome = join(root, 'runtime');
    const nativeHome = join(runtimeHome, 'pi');
    await mkdir(sourceHome);
    // Recorded #150 shape: the relay Provider is in a late private models.json,
    // while the admitted member home contains no ambient vendor configuration.
    const transport = { id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } as const;
    const model = { id: 'muse-spark-1.2-contributor', name: 'Selected model' };
    const materialized = await PI_PROVIDER_BINDING_ADAPTER.materialize({ v: 1,
      prepared: PI_PROVIDER_BINDING_ADAPTER.prepare(),
      binding: { v: 1, agentTargetKey: 'pi', contributionKey: null,
        selection: { connectionId: 'brokered-team-muse', model },
        endpoint: { endpointTemplateId: 'responses', normalizedUrl: 'http://127.0.0.1:7777/v1',
          protocol: 'openai-responses', publicHeaders: {} },
        runtimeCredentialTransport: transport, compatibilityFingerprint: 'admitted' },
      credential: { kind: 'apiKey', transport, value: 'synthetic-relay-only' } });
    for (const file of materialized.files) await writeFile(join(sourceHome, file.relativePath), file.utf8);
    const models = JSON.parse(materialized.files[0]!.utf8);
    const pi = buildPiRpcLaunch({ providerModelId: 'muse-spark-1.2-contributor',
      env: { PI_CODING_AGENT_DIR: sourceHome }, happierToolsExtension: tools });
    const launch = await authorizeResolvedProjectExecLaunchForHost({
      launch: { command: process.execPath, args: [...pi.args], requiredFiles: pi.requiredFiles,
        cwd: root, env: { PI_CODING_AGENT_DIR: sourceHome } },
      agentIsolation: { read: () => ({ enabled: true,
        status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [root],
        localTransport: { agentUid: 2402, agentGid: 2402 },
        launch: { managedHappierBinaryPath: '/fixture/happier', runtimeHome,
          environment: { PI_CODING_AGENT_DIR: nativeHome }, selectedEnvironmentKeys: ['PI_CODING_AGENT_DIR'], selectedMaterials: [] } }) },
      requesterIdentity: { kind: 'isolated', separationRequired: false,
        requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } },
      agentLaunchKind: 'workspaceExec', signal: new AbortController().signal, assertCurrent() {},
    });
    try {
      const frame = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble!], { objectMode: false }));
      const selected = frame.selectedMaterials.find(file => join(frame.runtimeHome, file.relativePath) === join(frame.environment.PI_CODING_AGENT_DIR!, 'models.json'));
      expect(selected, 'native Pi must discover the selected relay Provider').toBeDefined();
      expect(JSON.parse(Buffer.from(selected!.contentBase64, 'base64').toString())).toEqual(models);
    } finally { await launch.release(); }
  } finally { await tools.dispose(); await rm(root, { recursive: true, force: true }); }
});
