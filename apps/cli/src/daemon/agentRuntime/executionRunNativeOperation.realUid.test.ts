import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { resolveAgentLaunchNativeEnvironment } from '@/daemon/agentIsolation/agentLaunchRuntime';
import { createExecutionRunNativeOperationOwner, type ExecutionRunNativeOperation } from './executionRunNativeOperation';

it.skipIf(process.platform !== 'linux' || process.env.HAPPIER_RUN_REAL_UID_INTEGRATION !== '1')(
  'uses the captured member operation for Agent invocation services while retaining requester selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-run-uid-'));
    await chmod(root, 0o755);
    const home = join(root, 'member');
    const executable = join(root, 'fixture-agent');
    const shim = join(root, 'dist/native-shim.mjs');
    const ownerFile = join(root, 'owner-auth');
    await writeFile(ownerFile, 'machine-owner-only', { mode: 0o600 });
    await copyFile('/usr/bin/node', executable);
    const sourceRoot = resolve(__dirname, '../../../../..');
    await mkdir(join(root, 'dist'));
    await mkdir(join(root, 'scripts'));
    await copyFile(join(sourceRoot, 'apps/cli/scripts/process_tree.cjs'), join(root, 'scripts/process_tree.cjs'));
    const { SOURCE_RUNTIME_COMMONJS_BANNER, SOURCE_RUNTIME_COMMONJS_DEFINE, SOURCE_RUNTIME_OUTPUT_OPTIONS,
      createWorkspaceSourceResolver, readWorkspacePackages } = await import('@happier-dev/cli-common/sourceRuntimeEntries');
    // The fixed RunAs executable is the OS adapter: compile only its real material/Exec owner
    // into a fixture readable by nobody. Shared checkout/home permissions remain untouched.
    await build({ stdin: { contents: `try { process.env.HOME = ${JSON.stringify(home)};
const { readAgentLaunchFrame } = await import('./apps/cli/src/daemon/agentIsolation/agentLaunchFrame.ts');
const { executeAgentLaunchPayload } = await import('./apps/cli/src/daemon/agentIsolation/agentLaunchShim.ts');
const payload = await readAgentLaunchFrame(process.stdin, undefined, true);
const result = await executeAgentLaunchPayload(payload, { agentHome: ${JSON.stringify(home)}, input: process.stdin,
  stdout: process.stdout, stderr: process.stderr }); process.exitCode = result.code ?? 1;
} catch (error) { process.stderr.write(String(error?.stack ?? error)); process.exitCode = 1; }`,
      resolveDir: sourceRoot, sourcefile: 'native-run-shim.ts' }, bundle: true, platform: 'node', format: 'esm',
      ...SOURCE_RUNTIME_OUTPUT_OPTIONS, banner: { js: `#!/usr/bin/node\n${SOURCE_RUNTIME_COMMONJS_BANNER}` },
      define: SOURCE_RUNTIME_COMMONJS_DEFINE, outfile: shim, tsconfig: join(sourceRoot, 'apps/cli/tsconfig.json'),
      conditions: ['happier-source'], plugins: [createWorkspaceSourceResolver({ workspacePackages: await readWorkspacePackages(sourceRoot),
        requireFromProject: createRequire(join(sourceRoot, 'apps/cli/package.json')), externalPackages: [] }),
        { name: 'legacy-commonjs-escapes', setup(builder) {
          builder.onLoad({ filter: /qrcode-terminal\/lib\/main\.js$/ }, async args => ({
            contents: (await readFile(args.path, 'utf8')).replaceAll('\\033', '\\x1b'), loader: 'js',
          }));
        } }],
      external: ['*.node'], logLevel: 'silent' });
    await chmod(shim, 0o755);
    execFileSync('/usr/bin/sudo', ['-n', 'install', '-d', '-o', 'nobody', '-g', 'nogroup', '-m', '0700', home]);
    let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    try {
      fixture = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [createFirstConversationAgentFixture('native-placement', { nativeReply: { executableNames: [executable], args: [] } })],
      });
      const lease = [...fixture.registry.agentRuntimesByAgentId.values()].find(candidate => candidate.pluginId === 'acme.project-launch');
      if (!lease) throw new Error('Native fixture Agent was not admitted');
      const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
        requester: { serverId: 'home', accountId: 'folder-member', machineId: 'machine', installationId: 'installation' } };
      const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ ...requesterIdentity, homeServerIdentityId: 'home' }),
        username: 'nobody', primaryGroup: 'nogroup', home, workspaceRoot: home, agentUid: 65534, agentGid: 65534 };
      const environment = { ...resolveAgentLaunchNativeEnvironment(home), SELECTED_PROVIDER: 'requester-account' };
      const nativeOperation: ExecutionRunNativeOperation = { requesterIdentity, memberIdentity, workingDirectory: home,
        signal: new AbortController().signal, materialTarget: { runtimeHome: join(home, 'runtime/operations/native-run'), memberIdentity },
        agentIsolation: { requesterIdentity, read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux' },
          workspaceRoots: [home], memberIdentity, localTransport: { agentUid: 65534, agentGid: 65534 },
          launch: { managedHappierBinaryPath: shim, runtimeHome: join(home, 'runtime/operations/native-run'),
            environment, selectedEnvironmentKeys: Object.keys(environment), selectedMaterials: [] } }) }, async dispose() {} };
      const caller = new AbortController();
      const owner = createExecutionRunNativeOperationOwner({ ingress: { signal: caller.signal },
        agentIsolation: nativeOperation.agentIsolation,
        // The same person's own member folder; another person's folder is refused before preparation.
        resolveRequesterIdentity: async () => ({ kind: 'owner_person', requester: requesterIdentity.requester }),
        machine: { readMemberFolderOwner: async () => requesterIdentity,
          prepareNativeOperation: async input => {
            expect(input.requesterIdentity).toEqual(requesterIdentity);
            return nativeOperation;
          } },
      });
      const admittedOperation = await owner.prepareNativeOperation(home, caller.signal, 'requester-run');
      const services = await fixture.registry.createAgentInvocationServices({ pluginId: lease.pluginId,
        pluginVersion: lease.pluginVersion, agentId: lease.agentId, occurrenceId: lease.occurrenceId,
        correlationId: 'requester-run', cwd: home, signal: nativeOperation.signal, isOccurrenceCurrent: lease.isCurrent,
        environment: { HAPPIER_DAEMON_TOKEN: 'machine-owner-only', HOME: root }, nativeOperation: admittedOperation });
      const resolved = await services.exec.systemTools.resolve({ toolId: 'native-cli', purpose: 'Observe actual native placement', cwd: home });
      const result = await services.exec.run({ executable: resolved.executable, cwd: home, args: ['-e',
        `let ownerFileReadable = false; try { require('node:fs').readFileSync(${JSON.stringify(ownerFile)}); ownerFileReadable = true; } catch {}
process.stdout.write(JSON.stringify({ uid: process.getuid(), home: process.env.HOME, cwd: process.cwd(),
  config: process.env.XDG_CONFIG_HOME, provider: process.env.SELECTED_PROVIDER, token: process.env.HAPPIER_DAEMON_TOKEN ?? null, ownerFileReadable }));`] });
      expect(result.termination.observed, Buffer.from(result.stderr).toString()).toEqual({ kind: 'exit', exitCode: 0 });
      expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({ uid: 65534, home, cwd: home,
        config: join(home, '.config'), provider: 'requester-account', token: null, ownerFileReadable: false });
      expect(process.getuid?.()).not.toBe(65534);
      expect(await readFile(ownerFile, 'utf8')).toBe('machine-owner-only');
      await owner.disposeNativeOperation();
    } finally {
      await fixture?.dispose();
      execFileSync('/usr/bin/sudo', ['-n', 'rm', '-rf', '--', home]);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
