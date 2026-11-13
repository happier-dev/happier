import { expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { projectMachineAgentsDetectResponse } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createAgentIsolationMemberPreparationBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

it.skipIf(process.platform !== 'linux').each(['member', 'requester'])('reports cold Agent inventory without preparing a missing member binding and preserves owner discovery', async actorAccountId => {
  let isolationEnabled = true;
  let member: ReturnType<typeof createAgentIsolationMemberPreparationBoundary> | undefined;
  const getMember = (input: Parameters<NonNullable<HostAgentIsolationLaunchContext['readMember']>>[0]): ReturnType<typeof createAgentIsolationMemberPreparationBoundary> => member ??= (
    createAgentIsolationMemberPreparationBoundary({ activeServerDir: fixture.directory,
      requesterIdentity: input.requesterIdentity, custodianAccountId: 'requester', encryptionMode: 'plain', uid: 2402 })
  );
  const fixture = await createInstalledFilesystemMachineFixture({ agentIsolation: {
    managedHappierBinaryPath: '/opt/happier/cli/current/happier',
    read: () => ({ enabled: isolationEnabled, memberProvisioning: 'linuxUsersV1',
      status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [] }),
    readMember: input => getMember(input).members.read(input),
    prepareMember: async input => {
      const result = await getMember(input).members.prepare(input);
      if (result.kind !== 'ready') throw Object.assign(new Error('Member setup unavailable'), { code: 'agent_isolation_unavailable' });
      return result;
    },
  } });
  try {
    const request = { requests: [{ id: 'cli.codex' as const }], bypassCache: true };
    const cold = await fixture.invoke(RPC_METHODS.CAPABILITIES_DETECT, request, { actorAccountId, role: 'use' });
    expect(cold).toMatchObject({ results: { 'cli.codex': { ok: true, data: {
      preparation: 'member_not_prepared', installed: false, install: { available: true, executionScope: 'member' },
    } } } });
    await expect(fixture.invoke(RPC_METHODS.CAPABILITIES_DETECT, {
      requests: [{ id: 'tool.acpAgentInventory', params: { definitions: [{
        definitionId: 'present-on-daemon', title: 'Daemon executable',
        launch: { kind: 'command', command: process.execPath, args: [] },
      }] } }],
    }, { actorAccountId, role: 'use' })).resolves.toMatchObject({
      results: { 'tool.acpAgentInventory': { ok: true, data: { items: [{
        preparation: 'member_not_prepared', installed: false,
        install: { available: false, executionScope: 'member' },
      }] } } },
    });
    expect(member).toBeDefined();
    // This cost is the contract: a read starts zero owner setup effects or
    // policy/preparation observations when the committed member is absent.
    expect(member?.launches).toEqual([]);
    expect(member?.daemonInspections()).toBe(0);
    isolationEnabled = false;
    const ownerCli = join(fixture.directory, 'owner-codex');
    await writeFile(ownerCli, '#!/bin/sh\necho codex-cli 9.0.0\n', { mode: 0o755 });
    vi.stubEnv('HAPPIER_CODEX_PATH', ownerCli);
    const owner = projectMachineAgentsDetectResponse({ agents: [{ agentId: 'codex', title: 'Codex' }],
      response: await fixture.invoke(RPC_METHODS.CAPABILITIES_DETECT, request) });
    expect(owner.items).toHaveLength(1);
    expect(owner.items[0]).toMatchObject({ installed: true, version: '9.0.0' });
    expect(owner.items[0]?.install).not.toHaveProperty('executionScope');
  } finally { await fixture.machine.shutdown(); vi.unstubAllEnvs(); vi.restoreAllMocks(); }
});
