import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSeparateUserToolsLayout } from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveManagedToolsRoot } from '@happier-dev/cli-common/agents';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
  createCaddyContainerSetupSteps } from '@happier-dev/cli-common/machineSetup';
import { runMachineSetupEffectInternal } from '@/machines/setup/effectInternal';
import type { HostRequesterExecutionIdentity } from './agentIsolationLaunchPolicy';
import { buildAgentIsolationProvisioningSteps } from './provisioning';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { resolveAgentIsolationEffectIntentResult } from './effectIntent';
import { createDaemonAgentIsolationEffects } from './createDaemonAgentIsolationEffects';
import { buildAgentIsolationMemberCliRuntimeSteps, isAgentIsolationMemberCliCurrent } from './memberCliRuntime';
import { resolveAgentLaunchRuntimeCustody } from './agentLaunchAccountSettings';
import { resolveRetainedBundledPluginRoot } from '@/plugins/runtime/retainedPluginSourceAttestation';

afterEach(() => vi.unstubAllEnvs());

describe('agent isolation provisioning', () => {
  it.skipIf(process.platform !== 'linux')('reviews the member CLI payload through the elevated setup interpreter', async () => {
    const root = await mkdtemp(join(tmpdir(), "happier member's CLI-"));
    try {
      const payload = join(root, 'cli', 'current');
      await mkdir(payload, { recursive: true });
      const sourceCli = join(payload, 'happier');
      await writeFile(sourceCli, '#!/bin/sh\n', { mode: 0o700 });
      const runtimeRoot = join(root, 'member-runtime');
      const steps = await buildAgentIsolationMemberCliRuntimeSteps({ sourceCli, root: runtimeRoot,
        executable: join(runtimeRoot, 'current', 'happier') });
      const stdin = new PassThrough(), stdout = new PassThrough();
      let output = '';
      stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
      stdin.end(JSON.stringify({ v: 1, mode: 'check', machineId: 'guest', installationId: 'install', operationId: 'enrollment',
        basis: { kind: 'agentIsolation', machineId: 'guest', enabled: true, expectedPolicy: { enabled: false },
          review: { roots: [], ancestorAcls: [], sessionsToReplace: 0, memberProvisioning: 'linuxUsersV1' } }, steps }) + '\n');
      const code = await runMachineSetupEffectInternal(['--operation-id=enrollment', '--installation-id=install'],
        // Substitute the sudo identity only. The interpreter still checks the real payload on disk.
        { stdin, stdout, readUid: () => 0 });
      expect(JSON.parse(output.trim().split('\n').at(-1)!)).toMatchObject({ type: 'result', result: { status: 'checked',
        plan: { nativeFacts: expect.arrayContaining([{ stepId: 'member-cli-payload', status: 'drifted', facts: expect.any(Object) }]) } } });
      expect(code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform !== 'linux' || process.env.HAPPIER_RUN_REAL_UID_INTEGRATION !== '1')(
    'publishes the current managed CLI and its companion files for a member without opening the private home', async () => {
      const root = await mkdtemp(join(tmpdir(), 'happier-private-cli-'));
      const sudo = (...args: string[]) => execFileSync('/usr/bin/sudo', ['-n', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const requesterIdentity = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: 'home',
        requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
      const boundary = createAgentIsolationEffectsBoundary({ installationId: 'installation',
        installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: async () => {} });
      vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', root);
      const production = createDaemonAgentIsolationEffects({ getMachineClient: () => null,
        adminAccess: { target: () => null, observer: {
          read: () => null, inspect: async () => { throw new Error('unused fixture observer'); },
        } }, readRoots: () => [], trackedSessions: new Map(), protectedRoots: [], privateRoots: [] });
      const privateCli = production.elevation.installedCli;
      const effects = { ...production, elevation: { ...boundary.effects.elevation, installedCli: privateCli } };
      let publishedRoot: string | undefined;
      try {
        const source = dirname(dirname(privateCli));
        const stageRelease = async (version: string, companion: string) => {
          const payload = join(source, 'versions', version);
          await mkdir(join(payload, 'node_modules', '@happier-dev', 'plugins-claude'), { recursive: true });
          await writeFile(join(payload, 'companion'), companion, { mode: 0o600 });
          await writeFile(join(payload, 'happier'), '#!/bin/sh\ncat "$(dirname "$(realpath "$0")")/companion"\n', { mode: 0o700 });
          await symlink(payload, join(source, 'next'));
          await rename(join(source, 'next'), dirname(privateCli));
        };
        await stageRelease('v1', 'managed release\n');
        await writeFile(join(root, 'credentials'), 'private', { mode: 0o644 });
        expect(() => sudo('-u', 'nobody', '--', privateCli)).toThrow(/Permission denied/);
        const reviewed = await resolveAgentIsolationEffectIntentResult(true, effects, undefined, undefined, 'linuxUsersV1');
        if (reviewed.kind !== 'ready') throw new Error('Expected a ready policy Apply plan');
        const directory = reviewed.intent.steps.find(step => step.id === 'member-cli-root');
        const publish = reviewed.intent.steps.find(step => step.id === 'member-cli-payload');
        expect(directory).toMatchObject({ kind: 'directory', owner: 'root', group: 'root', protectedAncestors: true });
        if (directory?.kind !== 'directory' || publish?.kind !== 'script') throw new Error('No member runtime in Apply');
        publishedRoot = directory.path;
        sudo('install', '-d', '-m', '0755', '--', publishedRoot);
        sudo(publish.shell, '-c', publish.body);
        const prepared = await resolveAgentIsolationEffectIntentResult(true, effects, requesterIdentity);
        if (prepared.kind !== 'ready') throw new Error('Expected a ready member Apply plan');
        const rule = prepared.intent.steps.find(step => step.id === 'agent-runas');
        const target = rule?.kind === 'file' && rule.content?.kind === 'literal'
          ? / = (\S+) agent-launch/u.exec(rule.content.value)?.[1] : undefined;
        expect(target).toBeDefined();
        expect(sudo('-u', 'nobody', '--', target!, 'agent-launch')).toBe('managed release\n');
        expect(() => sudo('-u', 'nobody', '--', 'cat', join(root, 'credentials'))).toThrow(/Permission denied/);
        expect(() => sudo('-u', 'nobody', '--', 'test', '-w', target!)).toThrow();
        expect((await lstat(root)).mode & 0o777).toBe(0o700);
        const previous = await realpath(target!);
        const memberEnv = { HOME: '/nonexistent' };
        const frame = { v: 1 as const, executable: '/bin/true', args: [], cwd: '/', runtimeHome: '/nonexistent/runtime',
          environment: { HAPPIER_FIRST_PARTY_INSTALL_HOME: root }, selectedMaterials: [] };
        const readCustody = (executable: string) => resolveAgentLaunchRuntimeCustody(frame, {
          moduleUrl: 'file:///$bunfs/root/happier.js', currentExecPath: executable,
          argv: [executable, 'agent-launch'], processEnv: memberEnv,
        });
        const captured = readCustody(previous);
        expect(captured).toMatchObject({ root: dirname(previous),
          packagedRuntime: { kind: 'cli_version_root', versionRootId: basename(dirname(previous)) } });
        expect(readCustody(target!)).toEqual(captured);
        await stageRelease('v2', 'new managed release\n');
        expect(await isAgentIsolationMemberCliCurrent(production.memberCliRuntime!)).toBe(false);
        const upgrade = await resolveAgentIsolationEffectIntentResult(true, effects, requesterIdentity);
        const refresh = upgrade.kind === 'ready' && upgrade.intent.steps.find(step => step.id === 'member-cli-payload');
        if (!refresh || refresh.kind !== 'script') throw new Error('No member runtime refresh in Apply');
        sudo(refresh.shell, '-c', refresh.body);
        expect(await isAgentIsolationMemberCliCurrent(production.memberCliRuntime!)).toBe(true);
        expect(sudo('-u', 'nobody', '--', target!, 'agent-launch')).toBe('new managed release\n');
        expect(sudo('-u', 'nobody', '--', previous, 'agent-launch')).toBe('managed release\n');
        const current = await realpath(target!);
        expect(readCustody(current)?.root).toBe(dirname(current));
        expect(readCustody(join(publishedRoot, 'previous', 'happier'))).toEqual(captured);
        await expect(resolveRetainedBundledPluginRoot({ pluginId: 'happier.agent.claude',
          custody: { kind: 'bundled_first_party', packagedRuntime: captured!.packagedRuntime },
          moduleUrl: pathToFileURL(join(dirname(current), 'package-dist', 'index.mjs')).href,
          processEnv: memberEnv,
        })).resolves.toMatchObject({ rootPath: join(dirname(previous), 'node_modules', '@happier-dev', 'plugins-claude') });
        const forged = join(publishedRoot, 'a'.repeat(64));
        sudo('ln', '-s', '--', dirname(previous), forged);
        expect(() => readCustody(join(forged, 'happier'))).toThrowError(expect.objectContaining({
          code: 'FIRST_PARTY_VERSION_ROOT_OUTSIDE_LAYOUT',
        }));
        sudo('chmod', '0775', '--', publishedRoot);
        expect(() => readCustody(current)).toThrowError(expect.objectContaining({
          code: 'FIRST_PARTY_VERSION_ROOT_OUTSIDE_LAYOUT',
        }));
      } finally {
        if (publishedRoot) sudo('rm', '-rf', '--', publishedRoot);
        await rm(root, { recursive: true, force: true });
      }
    });
  it.skipIf(process.platform !== 'linux').each(['shared', 'member'] as const)('converts a personal install through the reviewed setup without opening its home (%s)', placement => {
    vi.stubEnv('HOME', '/home/alice');
    vi.stubEnv('HAPPIER_HOME_DIR', '/home/alice/.happier');
    vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', '');
    vi.stubEnv('HAPPIER_MANAGED_TOOLS_ROOT', '');
    const requesterIdentity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }> & { homeServerIdentityId: string } = {
      kind: 'isolated', separationRequired: true, homeServerIdentityId: 'home-server',
      requester: { serverId: 'server', machineId: 'machine', installationId: 'install', accountId: 'member' },
    };
    const steps = buildAgentIsolationProvisioningSteps({ daemonUsername: 'alice', daemonPrimaryGroup: 'alice',
      ...(placement === 'member' ? { requesterIdentity } : {}),
      binaryPath: '/opt/happier/cli/current/happier', legacyPluginCodeRoot: '/home/alice/.happier/plugins/plugins/generations' });
    const tools = steps.find(step => step.id === 'tools-root');
    expect(tools).toMatchObject({ kind: 'directory', owner: 'alice', group: 'alice', mode: 0o711 });
    expect(tools?.kind === 'directory' && tools.path.startsWith('/var/lib/happier/')).toBe(true);
    expect(steps).toContainEqual(expect.objectContaining({ kind: 'file', id: 'tools-layout',
      path: '/home/alice/.happier/install-layout.json', owner: 'alice', group: 'alice', mode: 0o600 }));
    expect(steps.filter(step => step.kind === 'pathTraversal' && step.path.startsWith('/home/alice')
      && step.state !== 'absent')).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('keeps one traversal effect for an explicitly admitted shared Workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-common-ancestor-'));
    try {
      const workspace = join(root, 'workspace');
      const legacyPluginCodeRoot = join(root, 'private-home', 'plugins', 'plugins', 'generations');
      await mkdir(workspace);
      await mkdir(legacyPluginCodeRoot, { recursive: true });
      const native = createAgentIsolationEffectsBoundary({ installationId: 'installation',
        installedCli: '/opt/happier/cli/current/happier', readRoots: () => [{ rootId: 'workspace', path: workspace }],
        readSessionsToReplace: () => 0, publishStatus: async () => {} });
      const resolved = await resolveAgentIsolationEffectIntentResult(true, { ...native.effects, legacyPluginCodeRoot });
      expect(resolved.kind).toBe('ready');
      if (resolved.kind !== 'ready') throw new Error('Expected native effect intent');
      expect(resolved.intent.steps.filter(step => step.kind === 'pathTraversal' && step.path === root)).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== 'linux').each(['shared', 'member'] as const)(
    'removes retained plugin ancestry ACLs without opening the custodian home (%s)', async placement => {
      const root = await mkdtemp(join(tmpdir(), 'happier-plugin-traversal-'));
      try {
        const custodianHome = join(root, 'custodian');
        const happyHome = join(custodianHome, '.happier');
        // Retained 42272298ec layout, independently of the current install root.
        const legacyPluginCodeRoot = join(happyHome, 'plugins', 'plugins', 'generations');
        await mkdir(legacyPluginCodeRoot, { recursive: true });
        await chmod(custodianHome, 0o700);
        await writeFile(join(custodianHome, '.npmrc'), 'private fixture', { mode: 0o644 });
        const requesterIdentity = placement === 'member' ? {
          kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: 'home',
          requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' },
        } : undefined;
        const input = { daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
          binaryPath: '/opt/happier/cli/current/happier', legacyPluginCodeRoot,
          ...(requesterIdentity ? { requesterIdentity } : {}) };
        const retained = [custodianHome, happyHome, join(happyHome, 'plugins'), join(happyHome, 'plugins', 'plugins')];
        const grants = new Set(retained);
        const unrelatedUid = new Set(retained);
        // Account and ACL commands are the native boundary. The actual setup
        // interpreter observes, reviews, applies and rechecks the selected UID.
        const backend = createMachineSetupNativeBackend({ run: async ({ executable, args }) => {
          if (executable === 'getent') return { code: 0, stderr: '',
            stdout: `${args.at(-1)}:x:2401:2401::/var/lib/member:/usr/sbin/nologin\n` };
          const path = String(args.at(-1));
          if (executable === 'getfacl') return { code: 0, stderr: '', stdout:
            `user::rwx\n${grants.has(path) ? 'user:2401:--x\n' : ''}${unrelatedUid.has(path) ? 'user:2403:--x\n' : ''}group::---\nmask::--x\nother::---\n` };
          if (executable === 'setfacl') {
            if (args.includes('-x')) { expect(args).toContain('u:2401'); grants.delete(path); }
            else { expect(args).toContain('u:2401:--x'); grants.add(path); }
            return { code: 0, stdout: '', stderr: '' };
          }
          throw new Error(`Unexpected OS command ${executable}`);
        } });
        const steps = buildAgentIsolationProvisioningSteps(input).filter(step =>
          step.kind === 'pathTraversal' && (step.path === root || step.path.startsWith(root + '/')));
        const basis = { kind: 'setup' as const, machineId: 'machine', desiredRevision: 1 };
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
        expect([...grants].filter(path => path === custodianHome || path.startsWith(custodianHome + '/'))).toEqual([]);
        expect(steps.filter(step => step.kind === 'pathTraversal'
          && (step.path === custodianHome || step.path.startsWith(custodianHome + '/'))
          && (!('state' in step) || step.state !== 'absent'))).toEqual([]);
        expect([...unrelatedUid]).toEqual(retained);
        expect((await lstat(custodianHome)).mode & 0o777).toBe(0o700);
        expect((await lstat(join(custodianHome, '.npmrc'))).mode & 0o777).toBe(0o644);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  it.skipIf(process.platform === 'win32').each(['caddy-first', 'member-first'] as const)(
    'shares the Machine state root with Caddy without a setup-order conflict (%s)', async order => {
      const root = await mkdtemp(join(tmpdir(), 'happier-shared-state-'));
      try {
        const stateRoot = join(root, 'happier'), stateDirectory = join(stateRoot, 'caddy');
        const member = buildAgentIsolationProvisioningSteps({ daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
          binaryPath: '/opt/happier/cli/current/happier', requesterIdentity: {
            kind: 'isolated', separationRequired: true, homeServerIdentityId: 'home-state',
            requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' },
          } });
        const memberRoot = member.find(step => step.kind === 'directory' && step.path === '/var/lib/happier');
        if (memberRoot?.kind !== 'directory') throw new Error('Missing member state root');
        const memberSteps = [{ ...memberRoot, path: stateRoot }];
        const caddySteps = createCaddyContainerSetupSteps({ containerName: 'happier-caddy', stateDirectory,
          adminDirectory: join(root, 'admin'), daemonGroup: 'happier', daemonGroupId: process.getgid!(),
          initialConfig: '{}', originPort: 8080, routedNetworks: [] });
        // getent is the OS identity boundary; both recipes, directory modes,
        // preservation checks and native application remain real.
        const backend = createMachineSetupNativeBackend({ run: async command => {
          if (command.executable !== 'getent') throw new Error('Unexpected native command');
          return { code: 0, stderr: '', stdout: command.args.includes('passwd')
            ? `${command.args.at(-1)}:x:${process.getuid!()}:${process.getgid!()}::/home/test:/bin/sh\n`
            : `${command.args.at(-1)}:x:${process.getgid!()}:\n` };
        } });
        const basis = { kind: 'setup' as const, machineId: 'machine', desiredRevision: 1 };
        const recipes = order === 'caddy-first' ? [caddySteps, memberSteps] : [memberSteps, caddySteps];
        for (const steps of recipes) {
          const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
          expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
        }
        // Every principal can traverse the shared root. The daemon group can
        // then traverse/read Caddy's directory and read its config.
        expect((await lstat(stateRoot)).mode & 0o777).toBe(0o711);
        expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o750);
        expect((await lstat(join(stateDirectory, 'initial.json'))).mode & 0o777).toBe(0o640);
        expect(await readFile(join(stateDirectory, 'initial.json'), 'utf8')).toBe('{}');
      } finally { await rm(root, { recursive: true, force: true }); }
    });

  it('uses the observed daemon primary group, not the daemon username or happier, for managed directory access', () => {
    vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', '/srv/agent-qa-payload');
    const requesterIdentity = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: 'home-group',
      requester: { serverId: 'profile-group', accountId: 'member-group', machineId: 'machine-group', installationId: 'installation-group' } };
    const input = { daemonUsername: 'alice', daemonPrimaryGroup: 'engineers',
      binaryPath: '/home/alice/.happier/stack-state/agent-qa/cli/cli/current/happier' };
    for (const member of [undefined, requesterIdentity]) {
      const steps = buildAgentIsolationProvisioningSteps({ ...input, ...(member ? { requesterIdentity: member } : {}) });
      expect(steps.find(step => step.id === 'tools-root')).toMatchObject({
        path: resolveManagedToolsRoot(), owner: 'alice', group: 'engineers', mode: 0o711 });
      if (member) {
        expect(steps.find(step => step.id === 'member-workspaces')).toMatchObject({ owner: 'alice', group: 'engineers' });
        expect(steps.find(step => step.id === 'member-workspace')).toMatchObject({ group: 'engineers', mode: 0o2770 });
      }
    }
    const missing = { ...input, daemonPrimaryGroup: null };
    expect(() => buildAgentIsolationProvisioningSteps(missing))
      .toThrowError(expect.objectContaining({ code: 'agent_isolation_unavailable', details: { reason: 'requester_authority_unavailable', phase: 'native_execution_preparation' } }));
  });

  it('provisions private qualified owner and member identities without common workspace group membership', () => {
    const homeServerIdentityId = 'home-member-test';
    const machineId = 'machine-member-test', installationId = 'installation-member-test';
    const usernames = new Set<string>();
    for (const accountId of ['owner', 'member-a', 'member-b']) {
      const requesterIdentity = { kind: 'isolated' as const, separationRequired: accountId !== 'owner', homeServerIdentityId,
        requester: { serverId: 'saved-profile', machineId, installationId, accountId } } satisfies HostRequesterExecutionIdentity & { homeServerIdentityId: string };
      const input = { daemonUsername: 'happier' as const, daemonPrimaryGroup: 'happier', binaryPath: '/opt/happier/cli/current/happier', requesterIdentity };
      const digest = createHash('sha256').update(JSON.stringify([homeServerIdentityId, machineId, installationId, accountId])).digest('hex');
      const username = `hpm-${digest.slice(0, 24)}`;
      const steps = buildAgentIsolationProvisioningSteps(input);
      expect(steps.find(step => step.kind === 'user')).toMatchObject({ username, home: `/var/lib/happier/members/${digest}`,
        shell: '/usr/sbin/nologin', locked: true, ownershipMarker: `happier-member-${digest}`, supplementaryGroups: [] });
      expect(steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'directory', path: `/var/lib/happier/members/${digest}`, owner: username, group: username, mode: 0o700 }),
        expect.objectContaining({ kind: 'directory', path: `/srv/happier/members/${digest}`, owner: username, group: 'happier', mode: 0o2770 }),
        expect.objectContaining({ kind: 'pathTraversal', path: '/srv/happier', agentUsername: username }),
      ]));
      expect(steps.some(step => step.kind === 'group')).toBe(false);
      const rule = steps.find(step => step.kind === 'file');
      if (rule?.kind !== 'file' || rule.content?.kind !== 'literal') throw new Error('Missing exact RunAs policy');
      expect(rule.path).toBe(`/etc/sudoers.d/91-happier-${username}`);
      expect(rule.content.value).toContain(`happier ALL=(${username}) NOPASSWD:NOSETENV:`);
      expect(rule.content.value).not.toMatch(/\(ALL|\(root|happier-agent/);
      usernames.add(username);
    }
    expect(usernames.size).toBe(3);
  });
  it('provisions the locked Agent, shared workspace and exact RunAs launch without root or Docker authority', () => {
    const input = { daemonUsername: 'happier', daemonPrimaryGroup: 'happier', binaryPath: '/opt/happier/cli/current/happier' };
    const steps = buildAgentIsolationProvisioningSteps(input);
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user', username: 'happier-agent', locked: true }),
      expect.objectContaining({ kind: 'group', name: 'happier-workspace', members: ['happier', 'happier-agent'] }),
      expect.objectContaining({ kind: 'directory', path: '/srv/happier', owner: 'happier', group: 'happier-workspace', mode: 0o2770 }),
      expect.objectContaining({ kind: 'directory', path: resolveSeparateUserToolsLayout({ machineStateRoot: '/var/lib/happier' }).toolsRoot,
        owner: 'happier', group: 'happier', mode: 0o711 }),
    ]));
    const rule = steps.find(step => step.kind === 'file' && step.path === '/etc/sudoers.d/91-happier-agent');
    expect(rule).toMatchObject({ kind: 'file', owner: 'root', group: 'root', mode: 0o440, validate: 'sudoers' });
    if (rule?.kind !== 'file' || rule.content?.kind !== 'literal') throw new Error('Missing exact RunAs policy');
    expect(rule.content.value).toContain('happier ALL=(happier-agent) NOPASSWD:NOSETENV:');
    expect(rule.content.value).toContain('/opt/happier/cli/current/happier agent-launch');
    expect(rule.content.value).toContain('umask=0002');
    expect(rule.content.value).toContain('umask_override');
    expect(rule.content.value).not.toMatch(/\(root\)|\(ALL/);
    expect(steps.filter(step => step.kind === 'group').map(step => step.name)).toEqual(['happier-workspace']);
  });
});
