import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import { managedAcpInstallId } from '@happier-dev/cli-common/agents';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createRegistryHostV1, BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';
import { ACP_REGISTRY_V1_FIXTURE } from '../../../../../../packages/protocol/src/registries/formats/fixtures/acpRegistryV1Fixture';
import { AcpCatalogSettingsV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { AgentsAcpBackendsInstallFromRegistryOutputV1Schema } from '@happier-dev/protocol/acp/catalog/registry/registryInstallActionV1';
import { projectAcpCatalogForMachineInventory } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import type { CapabilitiesDetectRequest } from '@/capabilities/types';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import type { ActionCliExecutionDeps } from '../executeCommand';
import { tryHandleAgentCliCommand } from './agentsArgv';
import { buildAgentBackendInventoryItems } from '@/session/actions/inventory/buildAgentBackendInventoryItems';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCapabilitiesService } from '@/capabilities/service';
import { createAcpAgentInventoryCapability } from '@/capabilities/registry/machineAgentsInventory';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; await Promise.all(roots.splice(0).map(removeTempDir)); });

describe('registry Agent CLI through the real registry and Action owners', () => {
  async function fixture(approval = false) {
    let catalog = AcpCatalogSettingsV1Schema.parse({ v: 2, backends: [] });
    let registryPayload: unknown = ACP_REGISTRY_V1_FIXTURE;
    let freshMachine = false;
    const token = 'header.eyJzdWIiOiJhbGljZSJ9.signature';
    const credentials = { token, encryption: null };
    const homes = new Map<string, string>();
    for (const id of ['linux', 'fresh', 'windows-arm']) { const home = await createTempDir('happier-cli-registry-machine-'); roots.push(home); homes.set(id, home); }
    const installs: unknown[] = [];
    const unused = async (): Promise<never> => { throw new Error('Unexpected transport'); };
    const registry = createRegistryHostV1({ host: 'node',
      http: { getJson: async () => ({ ok: true, value: registryPayload, fetchedAt: 10 }), getText: unused, getBytes: unused },
      readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
    const now = Date.now();
    const machine = (id: string, platform: string, arch: string | null, activeAt = Date.now()) => ({ id, kind: 'persistent',
      active: true, activeAt, revokedAt: null, replacedByMachineId: null, storageMode: 'plain', dataEncryptionKey: null,
      metadata: createMachineContentCodec({ encryptionMode: 'plain' }).encodeStored({ host: id, platform, ...(arch ? { arch } : {}),
        happyCliVersion: 'test', homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier' }) });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (!String(url).endsWith('/v1/machines')) throw new Error('Unexpected Account HTTP read');
      return { data: [machine('linux', 'linux', 'x64'), ...(freshMachine ? [machine('fresh', 'linux', 'x64')] : []),
        machine('offline', 'linux', 'x64', now - 60_001), machine('unknown', 'linux', null), machine('windows-arm', 'win32', 'arm64')] };
    });
    const machineDeps = new Map([...homes].map(([id, home]) => {
      const service = createCapabilitiesService({ capabilities: [createAcpAgentInventoryCapability({ accountId: 'alice',
        env: { HAPPIER_HOME_DIR: home }, platform: id === 'windows-arm' ? 'win32' : 'linux',
        arch: id === 'windows-arm' ? 'arm64' : 'x64' })], checklists: {
          [CHECKLIST_IDS.MACHINE_DETAILS]: [], [CHECKLIST_IDS.NEW_SESSION]: [],
        }, buildContext: async () => ({ cliSnapshot: null }) });
      return [id, createCliActionDeps({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
        machineActionDirectTargetTransport: { machineId: id, invoke: async (method, request) => {
          if (method !== 'capabilities.detect') throw new Error('Unexpected machine transport');
          // The untyped wire request is validated by the real registered capability.
          return service.detect(request as CapabilitiesDetectRequest);
        } } })] as const;
    }));
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      readActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: approval ? {} : { 'agents.acp.backends.installFromRegistry': ['cli'], 'machines.agents.uninstall': ['cli'] },
      }),
      registryActionExecute: ({ actionId, input }) => registry.execute(actionId, input),
      updateAccountAcpCatalogSettings: async ({ mutate }) => {
        catalog = AcpCatalogSettingsV1Schema.parse(mutate(catalog));
        return { ok: true, revision: 1 };
      },
      readAccountAcpCatalog: async () => ({ status: 'ready', revision: 1, record: { v: 1, definitions: catalog.backends } }),
      agentsBackendsList: async () => ({ items: await buildAgentBackendInventoryItems({ includeDisabled: true,
        acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: catalog.backends } },
      }) }),
      machinesAgentsList: async (request, context) => {
        const producer = machineDeps.get(request.machineId)?.machinesAgentsList;
        if (!producer) throw new Error('Unexpected machine');
        const projected = projectAcpCatalogForMachineInventory({ status: 'ready', revision: 1, record: { v: 1, definitions: catalog.backends } });
        return producer({ ...request, draftDefinitions: projected.definitions }, context);
      },
      machinesList: machineDeps.get('linux')!.machinesList,
      machineAgentInstallStart: async request => { installs.push(request); return { ok: true, jobId: `job-${request.machineId}` }; },
      machineAgentInstallRead: async () => ({ ok: true, events: [], steps: [], progress: [], nextCursor: 0,
        done: true, outcome: { kind: 'succeeded', version: '3579.7.0' } }),
    });
    const deps: Partial<ActionCliExecutionDeps> = { readCredentialsFn: async () => credentials,
      createExecutorFn: async () => ({ ...executor, async resolveSessionTarget() { throw new Error('Unexpected Session'); } }) };
    return { catalog: () => catalog, installs, run: (argv: readonly string[]) => tryHandleAgentCliCommand({ argv, actionExecutionDeps: deps }),
      enableFreshMachine: () => { freshMachine = true; },
      advanceRegistryPin: () => { registryPayload = { ...ACP_REGISTRY_V1_FIXTURE,
        agents: ACP_REGISTRY_V1_FIXTURE.agents.map(agent => agent.id === 'junie' ? { ...agent, version: '3579.7.1' } : agent) }; },
      markInstalled: async (definition: AcpBackendDefinitionV1) => {
        if (definition.launch.kind !== 'archive') throw new Error('Expected captured archive Agent');
        const current = join(homes.get('linux')!, 'tools', `dep.${managedAcpInstallId({ accountId: 'alice', definitionId: definition.id, version: definition.launch.version })}`, 'current');
        await mkdir(current, { recursive: true });
        await writeFile(join(current, '.happier-managed-version'), JSON.stringify({ definitionId: definition.id, title: definition.title, kind: 'archive', version: definition.launch.version }));
      },
    };
  }

  it.each(['first-use', 'now'] as const)('pins the actual registry read and admits %s through the one confirmed Action', async timing => {
    const owner = await fixture(); const output = captureConsoleLogAndMuteStdout();
    expect(await owner.run(['agents', 'add', 'builtin:acp-registry/junie', '--install', timing, '--json'])).toBe(true);
    const envelope = JSON.parse(String(output.logs.at(-1)));
    expect(envelope, JSON.stringify(envelope)).toMatchObject({ ok: true });
    const outcome = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse(envelope.data);
    expect(outcome.definition.origin?.provenance).toMatchObject({ itemId: 'junie', ref: { kind: 'version', version: '3579.7.0' } });
    expect(owner.catalog().backends).toEqual([outcome.definition]);
    expect(outcome.jobs).toEqual(timing === 'now' ? [
      { machineId: 'linux', jobId: 'job-linux' }, { machineId: 'windows-arm', jobId: 'job-windows-arm' },
    ] : []);
    expect(owner.installs).toEqual(timing === 'now' ? ['linux', 'windows-arm'].map(machineId =>
      expect.objectContaining({ machineId, agentId: 'custom-acp', definitionId: outcome.definition.id })) : []);
  });

  it('keeps rejected CLI approval ahead of admission and machine acquisition', async () => {
    const owner = await fixture(true); const output = captureConsoleLogAndMuteStdout();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await owner.run(['agents', 'add', 'builtin:acp-registry/junie', '--install', 'first-use', '--json']);
    expect(owner.catalog().backends).toEqual([]);
    expect(owner.installs).toEqual([]);
    expect(JSON.parse(String(output.logs.at(-1))).ok).toBe(false);
  });

  it('routes a definition version update through registry admission and only its installed machines', async () => {
    const owner = await fixture(); const output = captureConsoleLogAndMuteStdout();
    await owner.run(['agents', 'add', 'builtin:acp-registry/junie', '--install', 'first-use', '--json']);
    const previous = owner.catalog().backends[0];
    if (!previous) throw new Error('Missing admitted Agent');
    await owner.markInstalled(previous);
    owner.advanceRegistryPin(); owner.enableFreshMachine();
    await owner.run(['agents', 'update', previous.id, '--version', '3579.7.1', '--json']);
    const envelope = JSON.parse(String(output.logs.at(-1)));
    expect(envelope, JSON.stringify(envelope)).toMatchObject({ ok: true });
    const outcome = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse(envelope.data);
    expect(outcome.definition.id).toBe(previous.id);
    expect(outcome.definition.origin?.provenance.ref).toEqual({ kind: 'version', version: '3579.7.1' });
    expect(outcome.jobs).toEqual([{ machineId: 'linux', jobId: 'job-linux' }]);
    expect(owner.catalog().backends).toEqual([outcome.definition]);
    expect(owner.installs).toEqual([expect.objectContaining({ machineId: 'linux', definitionId: previous.id, intent: 'update' })]);
  });

  it('resolves a registry Agent label to its concrete definition for removal', async () => {
    const owner = await fixture(); const output = captureConsoleLogAndMuteStdout();
    await owner.run(['agents', 'add', 'builtin:acp-registry/junie', '--install', 'first-use', '--json']);
    const definition = owner.catalog().backends[0];
    if (!definition) throw new Error('Missing admitted Agent');
    await owner.run(['agents', 'remove', definition.title, '--machine', 'linux', '--json']);
    expect(owner.installs).toEqual([expect.objectContaining({ machineId: 'linux', definitionId: definition.id,
      agentId: 'custom-acp', intent: 'uninstall' })]);
    expect(JSON.parse(String(output.logs.at(-1)))).toMatchObject({ ok: true, data: { agentId: 'custom-acp' } });
  });

  it('updates an installed target and installs the same new pin on a fresh target', async () => {
    const owner = await fixture(); const output = captureConsoleLogAndMuteStdout();
    await owner.run(['agents', 'add', 'builtin:acp-registry/junie', '--install', 'first-use', '--json']);
    const previous = owner.catalog().backends[0];
    if (!previous) throw new Error('Missing admitted Agent');
    await owner.markInstalled(previous);
    owner.advanceRegistryPin(); owner.enableFreshMachine();
    await owner.run(['agents', 'add', 'builtin:acp-registry/junie', '--version', '3579.7.1', '--install', 'now', '--json']);
    const envelope = JSON.parse(String(output.logs.at(-1)));
    expect(envelope, JSON.stringify(envelope)).toMatchObject({ ok: true });
    expect(owner.installs).toEqual([
      expect.objectContaining({ machineId: 'linux', definitionId: previous.id, intent: 'update' }),
      expect.objectContaining({ machineId: 'fresh', definitionId: previous.id, intent: 'install' }),
      expect.objectContaining({ machineId: 'windows-arm', definitionId: previous.id, intent: 'install' }),
    ]);
  });
});
