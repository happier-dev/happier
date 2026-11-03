import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { retireAgentIsolationMemberIdentity } from './agentIsolationProvisioner';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { deriveAgentIsolationMemberIdentity } from './provisioning';

it('withdraws exact managed RunAs after the natural boundary even when the retained binding is unreadable', async () => {
  const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-member-withdrawal-'));
  try {
    const scope = { activeServerDir, homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation' };
    const member = deriveAgentIsolationMemberIdentity({ homeServerIdentityId: scope.homeServerIdentityId,
      requester: { serverId: 'home', accountId: 'revoked-member', machineId: scope.machineId, installationId: scope.installationId } });
    const root = join(activeServerDir, 'agent-isolation', 'members');
    await mkdir(join(activeServerDir, 'agent-isolation'), { mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    const binding = join(root, `${member.digest}.json`);
    await writeFile(binding, 'damaged binding', { mode: 0o600 });
    let present = true, boundarySettled = false;
    // OS file state only. Admission, elevation and CHECK/APPLY remain real.
    const native = createAgentIsolationEffectsBoundary({ installedCli: '/opt/happier/cli/current/happier',
      installationId: scope.installationId, readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: async () => {},
      backend: {
        async observe(step) { return { stepId: step.id, status: present ? 'drifted' : 'satisfied', facts: { present } }; },
        async apply(step) {
          expect(boundarySettled).toBe(true);
          expect(step).toMatchObject({ kind: 'file', state: 'absent', path: `/etc/sudoers.d/91-happier-${member.username}`,
            owner: 'root', group: 'root', mode: 0o440, expectedContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
          present = false;
        },
      } });
    const result = await machineNativeEffectAdmission.run({ operation: { operationId: 'withdrawal', kind: 'agentIsolation' },
      keys: [{ kind: 'machineSetup' }] }, nativeEffectContext => retireAgentIsolationMemberIdentity({
      scope, accountId: member.requester.accountId, operationId: 'withdrawal', nativeEffectContext,
      isCurrentInstallation: () => true,
      waitForNaturalBoundary: async () => { boundarySettled = true; return { kind: 'settled' }; },
      cleanupOwnedWork: async () => ({ kind: 'settled' }),
    }, native.effects));
    expect(result).toEqual({ kind: 'settled' });
    expect(present).toBe(false);
    expect(await readFile(binding, 'utf8')).toBe('damaged binding');
  } finally { await rm(activeServerDir, { recursive: true, force: true }); }
});
