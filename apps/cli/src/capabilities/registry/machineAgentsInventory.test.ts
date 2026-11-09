import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCapabilitiesService } from '../service';
import { createAcpAgentInventoryCapability } from './machineAgentsInventory';
import { createCapabilityChecklists } from '../checklists';
import { managedAcpInstallId } from '@happier-dev/cli-common/agents';
import { buildMachineAgentsDetectRequest, projectAcpCatalogForMachineInventory, projectMachineAgentsDetectResponse } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';

const roots: string[] = [];
const checklists = createCapabilityChecklists({ descriptors: [] }, { agents: [], agentDefinitionsById: new Map() });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('machine ACP definition inventory', () => {
  it('projects actual draft command existence without executing the Agent or exposing environment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-acp-command-inventory-')); roots.push(home);
    const marker = join(home, 'executed');
    const command = join(home, process.platform === 'win32' ? 'draft.cmd' : 'draft');
    await writeFile(command, process.platform === 'win32' ? `@echo off\necho executed > "${marker}"\n`
      : `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
    const configured = [
      { definitionId: 'found', title: 'Found', launch: { kind: 'command' as const, command, args: [] } },
      { definitionId: 'missing', title: 'Missing', launch: { kind: 'command' as const, command: join(home, 'absent'), args: [] } },
    ];
    const inventory = projectAcpCatalogForMachineInventory({ status: 'ready', revision: 1, record: { v: 1,
      definitions: configured.map(({ definitionId, ...definition }) => AcpBackendDefinitionV1Schema.parse({
        ...definition, id: definitionId, name: definitionId, env: { PRIVATE_TOKEN: { t: 'literal', v: 'never-disclose' } },
        createdAt: 1, updatedAt: 1,
      })),
    } });
    const service = createCapabilitiesService({ capabilities: [createAcpAgentInventoryCapability({ accountId: 'alice', env: { HAPPIER_HOME_DIR: home } })],
      checklists, buildContext: async () => ({ cliSnapshot: null }) });
    const request = buildMachineAgentsDetectRequest({ agents: [], ...inventory, refresh: true });
    const response = await service.detect(request);
    expect(projectMachineAgentsDetectResponse({ agents: [], ...inventory, response })).toMatchObject({ items: [
      { definitionId: 'found', installed: true, managed: false, version: null, update: { supported: false }, install: { available: false, mode: 'none' } },
      { definitionId: 'missing', installed: false, managed: false, version: null },
    ] });
    expect(JSON.stringify(request)).not.toContain('never-disclose');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reads managed versions only for caller definitions without enumerating another Account or installing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-acp-inventory-')); roots.push(home);
    for (const [definitionId, title, accountId] of [['requested', 'Private installed name', 'alice'], ['requested', 'Other Account secret name', 'bob']]) {
      const current = join(home, 'tools', `dep.${managedAcpInstallId({ accountId: accountId!, definitionId: definitionId!, version: '1.2.3' })}`, 'current');
      await mkdir(current, { recursive: true });
      await writeFile(join(current, '.happier-managed-version'), JSON.stringify({ definitionId, title, kind: 'archive', version: '1.2.3' }));
    }
    const launch = { kind: 'archive', version: '2.0', args: [], assetsByPlatform: {
      'linux-x64': { archiveUrl: 'https://fixture.test/agent.zip', executableSubpath: 'agent' },
    } } as const;
    const service = createCapabilitiesService({ capabilities: [createAcpAgentInventoryCapability({ accountId: 'alice', env: { HAPPIER_HOME_DIR: home }, platform: 'linux', arch: 'x64' })],
      checklists, buildContext: async () => ({ cliSnapshot: null }) });
    const response = await service.detect({ requests: [{ id: 'tool.acpAgentInventory', params: { definitions: [
      { definitionId: 'requested', title: 'Caller title', launch }, { definitionId: 'missing', title: 'Missing', launch },
    ] } }] });
    expect(response.results['tool.acpAgentInventory']).toMatchObject({ ok: true, data: { items: [
      { agentId: 'happier.agent.custom-acp/custom-acp', definitionId: 'requested', title: 'Caller title', installed: true, version: '1.2.3', managed: true, fit: { kind: 'can_run', via: 'archive', target: 'linux-x64' } },
      { agentId: 'happier.agent.custom-acp/custom-acp', definitionId: 'missing', title: 'Missing', installed: false, version: null, managed: false },
    ] } });
    expect(JSON.stringify(response)).not.toContain('Private installed name');
    expect(JSON.stringify(response)).not.toContain('Other Account');
    expect(JSON.stringify(response)).not.toContain('foreign');
    const denied = await service.detect({ requests: [{ id: 'tool.acpAgentInventory', params: { definitions: [
      { definitionId: 'requested', title: 'Caller title', launch: { kind: 'command', command: 'npx', args: ['should-never-install'], env: { SECRET: 'never-disclose' } } },
    ] } }] });
    expect(denied.results['tool.acpAgentInventory']).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });
});
