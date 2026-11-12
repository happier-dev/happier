import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { projectMachineAgentsDetectResponse } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { managedAcpInstallId } from '@happier-dev/cli-common/agents';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents/resolution';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { createCliCapabilitiesService } from '../capabilities';
import { invalidateCliSnapshots } from '@/capabilities/snapshots/cliSnapshot';
import { createFilesystemEffectByteOwner } from './filesystemEffectBytes';
import { FilesystemEffectConfigurationSchema } from './filesystemEffectOperation';
import { resolveAgentCliRuntimeSpecForLookupId } from '@/packagedRuntime/managedTools/requireAgentCliCommand';

it.skipIf(process.platform !== 'linux')('publishes member-native Agent facts and install scope without changing owner inventory', async () => {
  await withTempDir('native-member-agent-inventory-', async root => {
    const ownerHome = join(root, 'owner');
    const memberHome = join(root, 'member');
    const ownerBinary = join(ownerHome, 'bin', 'claude');
    const memberBinary = join(memberHome, '.local', 'bin', 'claude');
    await mkdir(join(ownerHome, 'bin'), { recursive: true });
    await mkdir(join(memberHome, '.local', 'bin'), { recursive: true });
    await writeFile(ownerBinary, '#!/bin/sh\necho codex-cli 9.0.0\n', { mode: 0o755 });
    await writeFile(memberBinary, '#!/bin/sh\necho codex-cli 2.0.0\n', { mode: 0o755 });
    for (const { home, version } of [{ home: ownerHome, version: '9.0.0' }, { home: memberHome, version: '2.0.0' }]) {
      const install = join(home, 'tools', `dep.${managedAcpInstallId({ accountId: 'member', definitionId: 'private-acp', version })}`, 'current');
      await mkdir(install, { recursive: true });
      await writeFile(join(install, '.happier-managed-version'), JSON.stringify({
        definitionId: 'private-acp', title: 'Private native title', kind: 'archive', version,
      }));
    }
    const environment = createEnvKeyScope(['HOME', 'USERPROFILE', 'HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_CLAUDE_PATH',
      'HAPPIER_FIRST_PARTY_INSTALL_HOME', 'HAPPIER_MANAGED_TOOLS_ROOT']);
    const definitions = [{ definitionId: 'private-acp', title: 'Private ACP', launch: {
      kind: 'archive' as const, version: '3.0.0', args: [], assetsByPlatform: {
        [`linux-${process.arch}`]: { archiveUrl: 'https://fixture.invalid/agent.zip', executableSubpath: 'agent' },
      },
    } }];
    const request = { requests: [{ id: 'cli.claude' as const },
      { id: 'tool.acpAgentInventory' as const, params: { definitions } }], bypassCache: true };
    const inventory = (response: unknown) => projectMachineAgentsDetectResponse({
      agents: [{ agentId: 'claude', title: 'Claude' }], definitions, response,
    });
    try {
      environment.patch({ HOME: ownerHome, USERPROFILE: ownerHome, HAPPIER_HOME_DIR: ownerHome,
        HAPPIER_FIRST_PARTY_INSTALL_HOME: ownerHome, HAPPIER_MANAGED_TOOLS_ROOT: join(ownerHome, 'tools'),
        PATH: join(ownerHome, 'bin'), HAPPIER_CLAUDE_PATH: ownerBinary });
      reloadConfiguration();
      const owner = inventory(await (await createCliCapabilitiesService()).detect(request, { accountId: 'member' }));
      expect(owner.items[0]).toMatchObject({ installed: true, version: '9.0.0' });
      expect(owner.items[0]?.install).not.toHaveProperty('executionScope');
      expect(owner.items[1]).toMatchObject({ definitionId: 'private-acp', installed: true, version: '9.0.0' });
      expect(owner.items[1]?.install).not.toHaveProperty('executionScope');

      // Substitute only the native process environment. Its production
      // capability dispatcher, detection and inventory projection stay real.
      environment.patch({ HOME: memberHome, USERPROFILE: memberHome, HAPPIER_HOME_DIR: memberHome,
        HAPPIER_FIRST_PARTY_INSTALL_HOME: memberHome, HAPPIER_MANAGED_TOOLS_ROOT: join(memberHome, 'tools'),
        PATH: join(ownerHome, 'bin'), HAPPIER_CLAUDE_PATH: ownerBinary });
      reloadConfiguration();
      invalidateCliSnapshots();
      const child = createFilesystemEffectByteOwner(FilesystemEffectConfigurationSchema.parse({ workingDirectory: memberHome,
        accessPolicy: { kind: 'osUser' }, requesterAccountId: 'member', capabilityAgentInstallExecutionScope: 'member' }));
      try {
        const detect = () => child.execute({ kind: 'filesystem.rpc', method: RPC_METHODS.CAPABILITIES_DETECT, input: request });
        const member = inventory(await detect());
        expect(member.items[0]).toMatchObject({ installed: true, version: '2.0.0',
          install: { executionScope: 'member', mode: 'vendor_recipe', available: true } });
        expect(member.items[1]).toMatchObject({ definitionId: 'private-acp', installed: true, version: '2.0.0',
          install: { executionScope: 'member', mode: 'managed' }, update: { supported: true } });
        expect(JSON.stringify(member)).not.toContain('Private native title');
        await rm(memberBinary);
        expect(inventory(await detect()).items[0]).toMatchObject({ installed: false, version: null,
          install: { executionScope: 'member' } });
        expect(owner.items[0]).toMatchObject({ version: '9.0.0' });
        expect(owner.items[0]?.install).not.toHaveProperty('executionScope');
      } finally { await child.dispose(); }

      const sharedTools = join(root, 'shared-tools');
      const sharedEnvironment = { HAPPIER_MANAGED_TOOLS_ROOT: sharedTools };
      const runtimeSpec = resolveAgentCliRuntimeSpecForLookupId('codex');
      const sharedCli = resolveAgentCliManagedCommandPathForRuntime(runtimeSpec, { processEnv: sharedEnvironment });
      await mkdir(dirname(sharedCli), { recursive: true });
      await writeFile(sharedCli, '#!/bin/sh\necho codex-cli 4.0.0\n', { mode: 0o755 });
      const sharedChild = createFilesystemEffectByteOwner(FilesystemEffectConfigurationSchema.parse({
        workingDirectory: memberHome, accessPolicy: { kind: 'osUser' }, requesterAccountId: 'member',
        capabilityAgentInstallExecutionScope: 'member', capabilityAgentSharedManagedToolsRoot: sharedTools,
      }));
      try {
        const detect = () => sharedChild.execute({ kind: 'filesystem.rpc', method: RPC_METHODS.CAPABILITIES_DETECT,
          input: { requests: [{ id: 'cli.codex' }], bypassCache: true } });
        const project = (response: unknown) => projectMachineAgentsDetectResponse({
          agents: [{ agentId: 'codex', title: 'Codex' }], response,
        });
        const shared = await detect();
        expect(project(shared).items[0]).toMatchObject({ installed: true, version: '4.0.0',
          update: { supported: false }, install: { executionScope: 'member' } });
        expect(shared).toMatchObject({ results: { 'cli.codex': { data: { updateSupported: false } } } });
        const localCli = resolveAgentCliManagedCommandPathForRuntime(runtimeSpec, { processEnv: process.env });
        await mkdir(dirname(localCli), { recursive: true });
        await writeFile(localCli, '#!/bin/sh\necho codex-cli 5.0.0\n', { mode: 0o755 });
        const local = await detect();
        expect(project(local).items[0]).toMatchObject({ installed: true, version: '5.0.0',
          update: { supported: true }, install: { executionScope: 'member' } });
        expect(local).toMatchObject({ results: { 'cli.codex': { data: { updateSupported: true } } } });
      } finally { await sharedChild.dispose(); }
    } finally {
      environment.restore();
      reloadConfiguration();
      invalidateCliSnapshots();
    }
  });
});
