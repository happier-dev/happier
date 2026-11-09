import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { applyPersistedManagedToolsRoot } from '@happier-dev/cli-common/firstPartyRuntime';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { buildAgentIsolationProvisioningSteps } from './provisioning';

it.skipIf(process.platform !== 'linux')('converts personal setup at restart and serves code to a member without home access', async () => {
  const root = await mkdtemp('/tmp/happier-personal-code-');
  const custodianHome = join(root, 'custodian');
  const home = join(custodianHome, '.happier');
  const run = promisify(execFile);
  vi.stubEnv('HOME', custodianHome);
  vi.stubEnv('HAPPIER_HOME_DIR', home);
  vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', '');
  vi.stubEnv('HAPPIER_MANAGED_TOOLS_ROOT', '');
  await chmod(root, 0o711);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(custodianHome, 0o700);
  const pluginId = 'acme.personal-code';
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home, plugins: [{
    manifest: createPluginManifestV2Fixture({ id: pluginId }),
    files: { 'daemon.mjs': 'export function activate() {}',
      'scm.mjs': 'export const checkout = () => "member-checkout";' },
  }] });
  try {
    const originalPaths = resolvePluginStorePaths({ happyHomeDir: home });
    const original = fixture.committed.generations.get(pluginId)!;
    const commit = await readFile(originalPaths.registryCurrentFilePath, 'utf8');
    const privateState = join(originalPaths.settingsDir, 'custodian-private');
    await writeFile(privateState, 'private settings', { mode: 0o600 });
    await writeFile(join(custodianHome, '.npmrc'), 'private config', { mode: 0o644 });
    // Reconcile the old traverse-only grants too: otherwise a world-readable
    // file like .npmrc remains reachable even though the directory cannot list.
    await run('setfacl', ['-m', 'u:65534:--x', '--', custodianHome, home]);
    const steps = buildAgentIsolationProvisioningSteps({ daemonUsername: 'alice', daemonPrimaryGroup: 'alice',
      requesterIdentity: { kind: 'isolated', separationRequired: true, homeServerIdentityId: 'home-server',
        requester: { serverId: 'server', machineId: 'machine', installationId: 'install', accountId: 'member' } },
      binaryPath: '/opt/happier/cli/current/happier', legacyPluginCodeRoot: originalPaths.generationsDir });
    const memberAccount = steps.find(step => step.kind === 'user');
    if (memberAccount?.kind !== 'user') throw new Error('Missing member account');
    expect(steps.filter(step => step.kind === 'pathTraversal' && step.path.startsWith(custodianHome)
      && step.state !== 'absent')).toEqual([]);
    const tools = steps.find(step => step.id === 'tools-root');
    expect(tools?.kind === 'directory' && tools.path.startsWith('/var/lib/happier/')).toBe(true);
    // Only OS identities and the system-root pathname are adapted to this
    // disposable native filesystem. The real reviewed file/directory effects,
    // startup layout reader and generation registry remain composed.
    const machineRoot = join(root, 'machine');
    const project = (value: string) => value.replaceAll('/var/lib/happier', machineRoot);
    const layoutSteps = steps.filter(step => step.id === 'machine-state-root' || step.id.startsWith('tools-')
      || step.kind === 'pathTraversal' && step.path.startsWith(root + '/')).map(step => {
      if (step.kind === 'directory') return { ...step, path: project(step.path) };
      if (step.kind === 'file' && step.content?.kind === 'literal') return {
        ...step, content: { ...step.content, value: project(step.content.value) },
      };
      return step;
    });
    const backend = createMachineSetupNativeBackend({ run: async command => {
      if (command.executable === 'getfacl' || command.executable === 'setfacl') {
        const result = await run(command.executable, [...command.args]);
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      }
      if (command.executable !== 'getent') throw new Error(`Unexpected native command ${command.executable}`);
      if (command.args.includes('passwd') && command.args.at(-1) === memberAccount.username) {
        return { code: 0, stderr: '', stdout: `${memberAccount.username}:x:65534:65534::${memberAccount.home}:/usr/sbin/nologin\n` };
      }
      return { code: 0, stderr: '', stdout: command.args.includes('passwd')
        ? `${command.args.at(-1)}:x:${process.getuid!()}:${process.getgid!()}::${custodianHome}:/bin/sh\n`
        : `${command.args.at(-1)}:x:${process.getgid!()}:\n` };
    } });
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'personal', desiredRevision: 1 }, steps: layoutSteps, backend });
    expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
    expect((await lstat(join(home, 'install-layout.json'))).mode & 0o777).toBe(0o600);
    const restarted: NodeJS.ProcessEnv = { HOME: custodianHome, HAPPIER_HOME_DIR: home };
    applyPersistedManagedToolsRoot({ env: restarted, happyHomeDir: home, platform: 'linux' });
    vi.stubEnv('HAPPIER_MANAGED_TOOLS_ROOT', restarted.HAPPIER_MANAGED_TOOLS_ROOT!);
    const store = createPluginRegistryStateStore({ happyHomeDir: home });
    await store.initialize();
    const generation = (await readCurrentCommittedPluginGenerations(store.paths))?.generations.get(pluginId);
    expect(generation?.immutableGenerationId).toBe(original.immutableGenerationId);
    expect(generation?.rootPath.startsWith(machineRoot + '/')).toBe(true);
    expect(await readFile(store.paths.registryCurrentFilePath, 'utf8')).toBe(commit);
    expect(await readFile(privateState, 'utf8')).toBe('private settings');
    const { stdout: acl } = await run('getfacl', ['-R', '-n', '-p', '--', custodianHome]);
    expect(acl).not.toMatch(/^user:\d+:/mu);
    const privatePaths = (await readdir(home)).map(name => join(home, name));
    const script = `
      const fs = require('node:fs/promises');
      const { pathToFileURL } = require('node:url');
      (async () => {
        const [gid, entry, config, ...privatePaths] = process.argv.slice(1);
        process.setgroups([]); process.setgid(Number(gid)); process.setuid(65534);
        const blocked = async path => {
          try { await fs.readFile(path); return false; } catch (e) { if (e.code !== 'EACCES') return false; }
          try { await fs.readdir(path); return false; } catch (e) { return e.code === 'EACCES'; }
        };
        console.log(JSON.stringify({ uid: process.getuid(),
          checkout: (await import(pathToFileURL(entry).href)).checkout(),
          privateUnreadable: await Promise.all([config, ...privatePaths].map(blocked)) }));
      })().catch(e => { console.error(e.code); process.exitCode = 1; });`;
    const { stdout } = await run('sudo', ['-n', '--', '/usr/bin/node', '-e', script,
      String(process.getgid!()), join(generation!.rootPath, 'scm.mjs'), join(custodianHome, '.npmrc'), ...privatePaths]);
    expect(JSON.parse(stdout)).toEqual({ uid: 65534, checkout: 'member-checkout',
      privateUnreadable: Array.from({ length: privatePaths.length + 1 }, () => true) });
  } finally {
    await fixture.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
