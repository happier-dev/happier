import { expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { managedAcpAccountNamespace, managedAcpInstallId } from '@happier-dev/cli-common/agents';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { TrackedSession } from '@/daemon/types';
import { isAgentInstallTargetInUse, listManagedAcpInstalls } from './managedAgentInstalls';

it('discovers configured ACP receipts in the same dedicated tools payload used for launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-managed-acp-tools-'));
  try {
    const installHome = join(root, 'payload');
    const tools = join(installHome, 'tools');
    const installId = `dep.${managedAcpInstallId({ accountId: 'account-1', definitionId: 'definition-1', version: '1' })}`;
    const installRoot = join(tools, installId);
    await mkdir(join(installRoot, 'current'), { recursive: true });
    await writeFile(join(installRoot, 'current', '.happier-managed-version'), JSON.stringify({
      version: '1', definitionId: 'definition-1', title: 'Configured Agent', kind: 'archive',
    }));
    await expect(listManagedAcpInstalls({
      accountId: 'account-1', env: { HAPPIER_HOME_DIR: join(root, 'private'), HAPPIER_FIRST_PARTY_INSTALL_HOME: installHome },
    })).resolves.toEqual([{
      accountNamespace: managedAcpAccountNamespace('account-1'), installId, installRoot,
      definitionId: 'definition-1', title: 'Configured Agent', version: '1', kind: 'archive',
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('uses tracked definition identity across admitted and adopted sessions while keeping neighboring definitions independent', () => {
  const target = { agentId: 'custom-acp', definitionId: 'alpha' };
  const selected: TrackedSession = { pid: process.pid, startedBy: 'daemon', spawnOptions: { directory: tmpdir(),
    agentTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'alpha' } } };
  expect(isAgentInstallTargetInUse(target, [selected])).toBe(true);
  expect(isAgentInstallTargetInUse({ ...target, definitionId: 'beta' }, [selected])).toBe(false);
  const adopted: TrackedSession = { pid: process.pid, startedBy: 'terminal', spawnOptions: { directory: tmpdir(),
    runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: { definitionId: 'alpha' } } } };
  expect(isAgentInstallTargetInUse(target, [adopted])).toBe(true);
  const unknownDefinition: TrackedSession = { pid: process.pid, startedBy: 'daemon', spawnOptions: { directory: tmpdir(),
    runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: {} } } };
  expect(isAgentInstallTargetInUse(target, [unknownDefinition])).toBe(true);
  const otherAgent: TrackedSession = { pid: process.pid, startedBy: 'daemon', spawnOptions: { directory: tmpdir(),
    runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } } };
  expect(isAgentInstallTargetInUse(target, [otherAgent])).toBe(false);
});
