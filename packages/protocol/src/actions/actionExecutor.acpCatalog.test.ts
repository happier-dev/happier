import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyAcpBackendUpsertV1 } from '../acp/catalog/catalogMutationsV1.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { createRegistryHostV1 } from '../registries/registryHostV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '../registries/registrySourcesV1.js';
import { ACP_REGISTRY_V1_FIXTURE } from '../registries/formats/fixtures/acpRegistryV1Fixture.js';
import { AcpCatalogRecordV1Schema } from '../acp/catalog/catalogSchemasV1.js';
import { normalizeAcpCatalogSettingsV1 } from '../acp/catalog/catalogMutationsV1.js';
import { AgentsAcpBackendsInstallFromRegistryOutputV1Schema } from '../acp/catalog/registry/registryInstallActionV1.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    detachedExecutionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    // Routing tests exercise the domain ports, not the shared approval owner.
    isActionApprovalRequired: () => false,
    ...overrides,
  });
}

/** An in-memory Account settings owner: the host port only persists what the executor computes. */
function createCatalogStore(initial: unknown) {
  let stored: unknown = initial;
  let revision = 0;
  const updateAccountAcpCatalogSettings = vi.fn(async ({ mutate }: { mutate: (current: unknown) => unknown }) => {
    const next = mutate(stored);
    if (next !== stored) { stored = next; ++revision; }
    return { ok: true as const, revision };
  });
  return { read: () => stored, readAccountAcpCatalog: async () => ({ status: 'ready' as const, revision,
    record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: normalizeAcpCatalogSettingsV1(stored).backends }) }), updateAccountAcpCatalogSettings };
}

const authored = {
  id: 'my-agent',
  name: 'my-agent',
  title: 'My agent',
  launch: { kind: 'command' as const, command: 'my-agent', args: ['--acp'] },
};

describe('createActionExecutor (custom ACP agent catalog)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores exactly what the Settings editor stores for the same authored agent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = createCatalogStore({ v: 2, backends: [] });
    const executor = createExecutor({ updateAccountAcpCatalogSettings: store.updateAccountAcpCatalogSettings } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('agents.acp.backends.upsert', { backend: authored }, { surface: 'mcp' });

    const editorResult = applyAcpBackendUpsertV1({ settings: { v: 2, backends: [] }, backend: authored, nowMs: 1_000 });
    if (!editorResult.ok) throw new Error('expected the editor path to accept the agent');
    expect(store.read()).toEqual(editorResult.settings);
    expect(res).toEqual({ ok: true, result: { backend: editorResult.backend, revision: 1 } });
  });

  it('returns the catalog owner\'s typed codes and writes nothing on a rejected change', async () => {
    const existing = applyAcpBackendUpsertV1({ settings: { v: 2, backends: [] }, backend: authored, nowMs: 1 });
    if (!existing.ok) throw new Error('fixture');
    const store = createCatalogStore(existing.settings);
    const executor = createExecutor({ updateAccountAcpCatalogSettings: store.updateAccountAcpCatalogSettings } as Partial<ActionExecutorDeps>);

    await expect(executor.execute('agents.acp.backends.upsert', {
      backend: { ...authored, id: 'other-id' },
    }, { surface: 'mcp' })).resolves.toMatchObject({ ok: false, errorCode: 'acp_backend_name_conflict' });
    await expect(executor.execute('agents.acp.backends.delete', { backendId: 'missing' }, { surface: 'mcp' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'acp_backend_not_found' });
    expect(store.read()).toEqual(existing.settings);

    await expect(executor.execute('agents.acp.backends.delete', { backendId: 'my-agent' }, { surface: 'mcp' }))
      .resolves.toEqual({ ok: true, result: { backendId: 'my-agent', deleted: true } });
    expect(store.read()).toEqual({ v: 2, backends: [] });
  });

  it('reports a host without an Account settings writer as unsupported', async () => {
    const executor = createExecutor();
    await expect(executor.execute('agents.acp.backends.delete', { backendId: 'x' }, { surface: 'mcp' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it('admits reviewed registry output through the catalog owner and starts typed jobs without losing env edits on update', async () => {
    let fixture: { version: string; agents: Array<Record<string, unknown>> } = {
      version: ACP_REGISTRY_V1_FIXTURE.version, agents: ACP_REGISTRY_V1_FIXTURE.agents.map(agent => ({ ...agent })),
    };
    const unused = async (): Promise<never> => { throw new Error('Unexpected HTTP transport'); };
    const registry = createRegistryHostV1({ host: 'node', readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1,
      http: { getJson: async () => ({ ok: true, value: fixture, fetchedAt: 1 }), getText: unused, getBytes: unused } });
    const store = createCatalogStore({ v: 2, backends: [] });
    const installed = new Map<string, string>();
    const executor = createExecutor({ readAccountAcpCatalog: store.readAccountAcpCatalog,
      updateAccountAcpCatalogSettings: store.updateAccountAcpCatalogSettings,
      registryActionExecute: ({ actionId, input }) => registry.execute(actionId, input),
      machinesAgentsList: async request => ({ items: [{ agentId: 'happier.agent.custom-acp/custom-acp', definitionId: request.definitionId,
        title: 'Registry agent', installed: installed.has(request.machineId), managed: installed.has(request.machineId),
        version: installed.get(request.machineId) ?? null, latestVersion: null,
        update: { supported: installed.has(request.machineId), command: null },
        signIn: { status: 'unknown', loginSupport: 'unsupported' }, platform: { supported: true },
        install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
      }] }),
      // Machine transport is the system boundary; the server composed test exercises its real RPC/job owner.
      machineAgentInstallStart: async request => {
        expect(request).toMatchObject({ agentId: 'happier.agent.custom-acp/custom-acp',
          intent: installed.has(request.machineId) ? 'update' : 'install', consent: { vendorRecipe: false } });
        const saved = await store.readAccountAcpCatalog();
        const definition = saved.record.definitions.find(definition => definition.id === request.definitionId);
        if (!definition || definition.launch.kind === 'command') throw new Error('The registry definition must be durable before acquisition');
        expect(request.expectedDefinitionVersion).toBe(definition.launch.version);
        installed.set(request.machineId, definition.launch.version);
        return { ok: true, jobId: `job-${request.machineId}-${definition.launch.version}` };
      },
    });
    const input = { fromRegistry: { sourceId: 'builtin:acp-registry', itemId: 'claude-acp', version: '0.89.1' }, installOn: ['machine-a', 'machine-b'] };
    const added = await executor.execute('agents.acp.backends.installFromRegistry', input, { surface: 'mcp' });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(added.errorCode);
    const first = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse(added.result);
    expect(first.jobs).toEqual([{ machineId: 'machine-a', jobId: 'job-machine-a-0.89.1' }, { machineId: 'machine-b', jobId: 'job-machine-b-0.89.1' }]);
    expect(first.definition.origin?.provenance.ref).toEqual({ kind: 'version', version: '0.89.1' });
    expect(await executor.execute('agents.acp.backends.upsert', { backend: { ...first.definition,
      launch: { kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: '0.90.0', args: [] },
    } }, { surface: 'mcp' })).toMatchObject({ ok: false, errorCode: 'registry_change_requires_install',
      details: { use: 'agents.acp.backends.installFromRegistry' },
    });
    expect((await store.readAccountAcpCatalog()).record.definitions[0]).toEqual(first.definition);
    const env = { API_KEY: { t: 'literal' as const, v: 'my-custom-value' } };
    expect(await executor.execute('agents.acp.backends.upsert', { backend: { ...first.definition, env, defaultModel: 'mine' } }, { surface: 'mcp' })).toMatchObject({ ok: true });
    fixture = { ...fixture, agents: fixture.agents.map(agent => agent.id === 'claude-acp'
      ? { ...agent, version: '0.90.0', distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.90.0' } } } : agent) };
    const updated = await executor.execute('agents.acp.backends.installFromRegistry', {
      fromRegistry: { ...input.fromRegistry, version: '0.90.0' }, installOn: input.installOn,
    }, { surface: 'mcp' });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error(updated.errorCode);
    expect(AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse(updated.result)).toMatchObject({ jobs: [
      { machineId: 'machine-a', jobId: 'job-machine-a-0.90.0' }, { machineId: 'machine-b', jobId: 'job-machine-b-0.90.0' },
    ], definition: {
      id: first.definition.id, env, defaultModel: 'mine', launch: { version: '0.90.0' },
    } });
    expect((await store.readAccountAcpCatalog()).record.definitions).toHaveLength(1);
  });

  it('checks command existence on reachable machines and retains offline platform fit without writing the Account catalog', async () => {
    const store = createCatalogStore({ v: 2, backends: [] });
    const executor = createExecutor({ ...store, machinesList: async () => ({ items: [
      { machineId: 'online', presence: 'online', platform: 'linux', arch: 'x64' },
      { machineId: 'unknown-arch', presence: 'online', platform: 'win32' },
      { machineId: 'offline', presence: 'offline', platform: 'darwin', arch: 'arm64' },
    ] }), machinesAgentsList: async ({ machineId }, _context) => {
      if (machineId === 'offline') throw new Error('An offline machine must not be probed');
      return { items: [{ agentId: 'happier.agent.custom-acp/custom-acp', definitionId: authored.id, title: authored.title,
        installed: machineId === 'online', managed: false, version: null, latestVersion: null,
        update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
        platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null },
        dependencies: [],
      }] };
    } });
    expect(await executor.execute('agents.acp.backends.upsert', { backend: authored, dryRun: true }, { surface: 'ui' }))
      .toMatchObject({ ok: true, result: { dryRun: true, machines: [
        { machineId: 'online', commandFound: true, fit: { kind: 'can_run', via: 'command' } },
        { machineId: 'unknown-arch', commandFound: false, fit: { kind: 'unknown', reason: 'arch_unknown' } },
        { machineId: 'offline', commandFound: null, fit: { kind: 'can_run', via: 'command' } },
      ] } });
    expect(store.read()).toEqual({ v: 2, backends: [] });
  });
});
