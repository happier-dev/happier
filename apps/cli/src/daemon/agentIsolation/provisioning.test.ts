import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveManagedToolsRoot } from '@happier-dev/cli-common/agents';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
  createCaddyContainerSetupSteps } from '@happier-dev/cli-common/machineSetup';
import type { HostRequesterExecutionIdentity } from './agentIsolationLaunchPolicy';
import { buildAgentIsolationProvisioningSteps } from './provisioning';
import { resolvePluginStorePathLayout } from '@/plugins/store/pathLayout';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { resolveAgentIsolationEffectIntentResult } from './effectIntent';

afterEach(() => vi.unstubAllEnvs());

describe('agent isolation provisioning', () => {
  it.skipIf(process.platform !== 'linux')('reviews a common Workspace and installed-code ancestor once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-common-ancestor-'));
    try {
      const workspace = join(root, 'workspace');
      const pluginCodeRoot = resolvePluginStorePathLayout(join(root, 'private-home')).generationsDir;
      await mkdir(workspace);
      await mkdir(pluginCodeRoot, { recursive: true });
      const native = createAgentIsolationEffectsBoundary({ installationId: 'installation',
        installedCli: '/opt/happier/cli/current/happier', readRoots: () => [{ rootId: 'workspace', path: workspace }],
        readSessionsToReplace: () => 0, publishStatus: async () => {} });
      const resolved = await resolveAgentIsolationEffectIntentResult(true, { ...native.effects, pluginCodeRoot });
      expect(resolved.kind).toBe('ready');
      if (resolved.kind !== 'ready') throw new Error('Expected native effect intent');
      expect(resolved.intent.steps.filter(step => step.kind === 'pathTraversal' && step.path === root)).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== 'linux').each(['shared', 'member'] as const)(
    'allows installed code traversal while keeping daemon state private with an /opt payload (%s)', async placement => {
      const root = await mkdtemp(join(tmpdir(), 'happier-plugin-traversal-'));
      try {
        const happyHome = join(root, 'private-home');
        const pluginCodeRoot = resolvePluginStorePathLayout(happyHome).generationsDir;
        await mkdir(pluginCodeRoot, { recursive: true });
        await chmod(happyHome, 0o700);
        const privateState = join(happyHome, 'private-state');
        await mkdir(privateState, { mode: 0o700 });
        await writeFile(join(privateState, 'credentials'), 'private', { mode: 0o600 });
        const requesterIdentity = placement === 'member' ? {
          kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: 'home',
          requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' },
        } : undefined;
        const input = { daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
          binaryPath: '/opt/happier/cli/current/happier', pluginCodeRoot,
          ...(requesterIdentity ? { requesterIdentity } : {}) };
        const grants = new Map<string, string>();
        // POSIX ACL/account commands are the OS boundary; planning, no-follow
        // path checks, identity pinning and native CHECK/APPLY remain real.
        const backend = createMachineSetupNativeBackend({ run: async ({ executable, args }) => {
          if (executable === 'getent') return { code: 0, stderr: '',
            stdout: `${args.at(-1)}:x:2401:2401::/var/lib/member:/usr/sbin/nologin\n` };
          if (executable === 'getfacl') return { code: 0, stderr: '', stdout:
            `user::rwx\n${grants.has(String(args.at(-1))) ? 'user:2401:--x\n' : ''}group::---\nmask::--x\nother::---\n` };
          if (executable === 'setfacl') {
            expect(args.slice(0, 3)).toEqual(['-m', 'u:2401:--x', '--']);
            grants.set(String(args.at(-1)), 'x');
            return { code: 0, stdout: '', stderr: '' };
          }
          throw new Error(`Unexpected OS command ${executable}`);
        } });
        const steps = buildAgentIsolationProvisioningSteps(input).filter(step =>
          step.kind === 'pathTraversal' && (step.path === root || step.path.startsWith(root + '/')));
        const basis = { kind: 'setup' as const, machineId: 'machine', desiredRevision: 1 };
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
        expect(grants.get(happyHome)).toBe('x');
        expect(grants.get(join(happyHome, 'plugins'))).toBe('x');
        expect(grants.get(join(happyHome, 'plugins', 'plugins'))).toBe('x');
        expect(grants.has(pluginCodeRoot)).toBe(false);
        expect(grants.has(privateState)).toBe(false);
        expect((await lstat(happyHome)).mode & 0o777).toBe(0o700);
        expect((await lstat(privateState)).mode & 0o777).toBe(0o700);
        expect((await lstat(join(privateState, 'credentials'))).mode & 0o777).toBe(0o600);
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
      expect.objectContaining({ kind: 'directory', path: resolveManagedToolsRoot(), owner: 'happier', group: 'happier', mode: 0o711 }),
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
