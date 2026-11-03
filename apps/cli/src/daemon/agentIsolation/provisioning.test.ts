import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, createMachineSetupNativeBackend,
  createCaddyContainerSetupSteps } from '@happier-dev/cli-common/machineSetup';
import { buildAgentIsolationProvisioningSteps } from './provisioning';

describe('agent isolation provisioning', () => {
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

});
