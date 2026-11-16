import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({ axiosGet: vi.fn(), axiosPost: vi.fn() }));

vi.mock('axios', () => ({ default: { defaults: {}, get: boundaries.axiosGet, post: boundaries.axiosPost } }));
vi.mock('@/api/clientCompatibility/cliClientCompatibility', () => ({
  buildCurrentAccountStoredContentCompatibilityHttpHeaders: () => ({
    'X-Happier-Account-Content': 'current',
  }),
}));
vi.mock('@/api/client/serverHttpBaseUrl', () => ({
  normalizeServerHttpBaseUrl: (serverUrl: string) => serverUrl.replace(/\/+$/, ''),
  resolveServerHttpBaseUrl: () => 'https://api.example.test',
}));

import { listCurrentAccountAdministrationMachines, listCurrentAccountMachines, resolveCurrentAccountMachineTarget } from './resolveCurrentAccountMachineTarget';
import { PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { createMachineContentCodec } from './machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { DEFAULT_MACHINE_ONLINE_GRACE_MS } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import tweetnacl from 'tweetnacl';

function currentMachine(id: string, host?: string) {
  return {
    id,
    managedMachineRef: null,
    ...(host ? { metadata: JSON.stringify({ host }) } : {}),
    active: true,
    revokedAt: null,
    replacedByMachineId: null,
  };
}

beforeEach(() => {
  boundaries.axiosGet.mockReset();
  boundaries.axiosPost.mockReset();
});

describe('plugin-aware Account administration Machine selection', () => {
  const pluginId = 'example.widgets';
  const census = (complete = true) => PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1,
    inventoryComplete: complete, snapshots: [{ serverIdentityId: 'srv_widgets', machineId: 'capable', materializations: [{
      serverIdentityId: 'srv_widgets', machineId: 'capable', materializationId: 'materialization-counter', pluginId, version: '1.0.0',
      sourceClass: 'localPath', portableRelease: false, enabled: true, trustState: 'trusted', uiArtifacts: [], observedAt: 1,
    }] }], releases: [] });

  it('filters the existing reachable selection by the plugin census before preferring a Machine', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: ['unrelated', 'capable'].map(id => ({ ...currentMachine(id), activeAt: Date.now() })) });
    boundaries.axiosPost.mockResolvedValue({ data: census() });
    expect(await listCurrentAccountAdministrationMachines({ token: 'captured', serverHttpBaseUrl: 'https://captured.test',
      preferredMachineId: 'unrelated', requiredPluginId: pluginId })).toEqual(['capable']);
    expect(boundaries.axiosPost).toHaveBeenCalledWith('https://captured.test/v1/plugins/availability/materializations/read', {},
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer captured' }) }));
  });

  it('returns no candidate when no reachable trusted enabled Machine carries the plugin', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('unrelated'), activeAt: Date.now() }] });
    boundaries.axiosPost.mockResolvedValue({ data: census() });
    expect(await listCurrentAccountAdministrationMachines({ token: 'captured', requiredPluginId: pluginId })).toEqual([]);
    const available = census();
    const disabled = { ...available, snapshots: available.snapshots.map(snapshot => ({ ...snapshot,
      materializations: snapshot.materializations.map(materialization => ({ ...materialization, enabled: false })),
    })) };
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('capable'), activeAt: Date.now() }] });
    boundaries.axiosPost.mockResolvedValue({ data: disabled });
    expect(await listCurrentAccountAdministrationMachines({ token: 'captured', requiredPluginId: pluginId })).toEqual([]);
  });

  it('does not turn an incomplete census into proof that no Machine has the plugin', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('capable'), activeAt: Date.now() }] });
    boundaries.axiosPost.mockResolvedValue({ data: census(false) });
    await expect(listCurrentAccountAdministrationMachines({ token: 'captured', requiredPluginId: pluginId }))
      .rejects.toMatchObject({ code: 'machine_inventory_unavailable' });
  });

  it('preserves an explicit target without requiring a plugin census', async () => {
    expect(await listCurrentAccountAdministrationMachines({ token: 'captured', requestedMachineId: 'explicit', requiredPluginId: pluginId }))
      .toEqual(['explicit']);
    expect(boundaries.axiosPost).not.toHaveBeenCalled();
  });
});

describe('resolveCurrentAccountMachineTarget', () => {
  it('transfers only demanded Machine rows as unrelated fleet inventory grows', async () => {
    for (const unrelatedCount of [128, 1024]) {
      let delivered = 0;
      let requests = 0;
      const selected = ['selected-a', 'selected-b'].map(id => ({ ...currentMachine(id),
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }));
      const fleet = [...selected, ...Array.from({ length: unrelatedCount }, (_, i) => currentMachine(`unrelated-${i}`))];
      boundaries.axiosGet.mockImplementation(async () => {
        requests += 1; delivered += fleet.length;
        return { data: fleet };
      });
      boundaries.axiosPost.mockImplementation(async (_url, body: { machineIds: string[] }) => {
        requests += 1;
        const results = body.machineIds.map(machineId => {
          const machine = fleet.find(row => row.id === machineId);
          if (!machine) return { machineId, status: 'not_found' };
          delivered += 1;
          return { machineId, status: 'found', machine };
        });
        return { data: { results } };
      });
      const input = { token: 'token', projection: 'hostFacts' as const,
        machineIds: ['selected-a', 'selected-b', 'selected-a', 'missing'] };
      expect((await listCurrentAccountMachines(input)).map(row => row.id)).toEqual(['selected-a', 'selected-b']);
      expect({ requests, delivered }).toEqual({ requests: 1, delivered: 2 });
      expect(await listCurrentAccountMachines({ ...input, machineIds: [] })).toEqual([]);
      expect({ requests, delivered }).toEqual({ requests: 1, delivered: 2 });
      expect((await listCurrentAccountMachines({ ...input, machineIds: ['selected-a'] })).map(row => row.id)).toEqual(['selected-a']);
      expect({ requests, delivered }).toEqual({ requests: 2, delivered: 3 });
      expect((await listCurrentAccountMachines({ ...input, credentials: { token: 'token', encryption: null } })).map(row => row.id))
        .toEqual(['selected-a', 'selected-b']);
      expect({ requests, delivered }).toEqual({ requests: 3, delivered: 5 });
    }
  });
  it('reads released Home ordinary Machines without a managed reference and refuses malformed explicit references', async () => {
    // 0.2 Home serializeMachineRow at 1321319f omits managedMachineRef.
    const legacy = { id: 'legacy-machine', active: true, activeAt: Date.now(), revokedAt: null, replacedByMachineId: null };
    boundaries.axiosGet.mockResolvedValue({ data: [legacy] });
    expect(await listCurrentAccountMachines({ token: 'token', projection: 'hostFacts' })).toMatchObject([
      { id: legacy.id, managedMachineRef: null },
    ]);
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...legacy, managedMachineRef: { homeId: 'home' } }] });
    await expect(listCurrentAccountMachines({ token: 'token', projection: 'hostFacts' }))
      .rejects.toMatchObject({ code: 'machine_inventory_unavailable' });
  });
  it.each([{ machineIds: [] }, { machineIds: ['offline-one', 'offline-two'] }])('retains the typed no-active-Machine refusal and known ids: $machineIds', async ({ machineIds }) => {
    boundaries.axiosGet.mockResolvedValue({ data: machineIds.map(id => ({ ...currentMachine(id), active: false })) });
    expect(await resolveCurrentAccountMachineTarget({ token: 'token' })).toMatchObject({
      kind: 'unavailable', code: 'machine_offline', details: { machineIds },
    });
    expect(boundaries.axiosGet).toHaveBeenCalledTimes(1);
  });

  it('selects the sole reachable Machine when another legacy heartbeat has expired', async () => {
    const nowMs = Date.now();
    boundaries.axiosGet.mockResolvedValue({ data: [
      { ...currentMachine('expired'), activeAt: nowMs - DEFAULT_MACHINE_ONLINE_GRACE_MS - 1 },
      { ...currentMachine('reachable'), activeAt: nowMs },
    ] });

    expect(await resolveCurrentAccountMachineTarget({ token: 'token' })).toMatchObject({
      kind: 'selected', target: { machineId: 'reachable' },
    });
  });

  it('reports offline with known ids when every legacy heartbeat has expired', async () => {
    const activeAt = Date.now() - DEFAULT_MACHINE_ONLINE_GRACE_MS - 1;
    boundaries.axiosGet.mockResolvedValue({ data: ['expired-one', 'expired-two'].map(id => ({ ...currentMachine(id), activeAt })) });

    expect(await resolveCurrentAccountMachineTarget({ token: 'token' })).toMatchObject({
      kind: 'unavailable', code: 'machine_offline', details: { machineIds: ['expired-one', 'expired-two'] },
    });
  });

  it('retains Home-owned presence when the heartbeat timestamp is old', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('home-present'),
      activeAt: Date.now() - DEFAULT_MACHINE_ONLINE_GRACE_MS - 1, presenceProtocolVersion: 1 }] });

    expect(await resolveCurrentAccountMachineTarget({ token: 'token' })).toMatchObject({
      kind: 'selected', target: { machineId: 'home-present' },
    });
  });

  it('reads fresh host facts without opening unrelated Machine metadata', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    const secret = new Uint8Array(32).fill(7);
    const codec = createMachineContentCodec({ encryptionMode: 'e2ee', encryptionVariant: 'legacy', encryptionKey: secret });
    const metadata = codec.encodeStored(MachinePublishedMetadataV1Schema.parse({ host: 'worker', platform: 'linux',
      happyCliVersion: 'test', homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier' }));
    const access = { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage' as const,
      resourceMode: 'e2ee' as const, accessState: 'ready' as 'ready' | 'key_pending' };
    const selected = { ...currentMachine('selected'), revokedAt: null as number | null,
      metadata, storageMode: 'e2ee', activeAt: Date.now(), access };
    const fleet = Array.from({ length: 128 }, (_, index) => ({ ...selected, id: `unrelated-${index}` }));
    let current = selected;
    boundaries.axiosGet.mockImplementation(async (url: string) => ({ data: url.endsWith('/v1/machines/selected')
      ? { machine: current } : [current, ...fleet] }));
    // Cryptographic opening is the external boundary; parsing and access projection stay real.
    const opens = vi.spyOn(tweetnacl.secretbox, 'open');
    try {
      const params = { token, credentials: { token, encryption: { type: 'legacy' as const, secret } },
        projection: 'hostFacts' as const, machineIds: ['selected'] };
      const ready = await listCurrentAccountMachines(params);
      expect(opens).not.toHaveBeenCalled();
      expect(boundaries.axiosGet).toHaveBeenCalledWith('https://api.example.test/v1/machines/selected',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json;happier-machine-projection=host-facts' }) }));
      expect(ready).toHaveLength(1);
      expect(ready.find(machine => machine.id === 'selected')).toMatchObject({ label: 'selected', active: true,
        activeAt: selected.activeAt, revokedAt: null, access });
      current = { ...selected, active: false, revokedAt: 5,
        access: { ...access, accessState: 'key_pending' } };
      expect((await listCurrentAccountMachines(params)).find(machine => machine.id === 'selected')).toMatchObject({
        active: false, revokedAt: 5, access: { accessState: 'key_pending' },
      });
      expect(opens).not.toHaveBeenCalled();
      expect(await listCurrentAccountAdministrationMachines({ token: params.token, credentials: params.credentials }))
        .toHaveLength(fleet.length);
      expect(opens).not.toHaveBeenCalled();
      // Ordinary label consumers retain their explicit content demand.
      const named = await listCurrentAccountMachines({ token: params.token, credentials: params.credentials });
      expect(opens).toHaveBeenCalledTimes(fleet.length);
      expect(named.find(machine => machine.id === 'unrelated-0')).toMatchObject({ platform: 'linux', label: expect.stringContaining('worker') });
      expect(boundaries.axiosGet.mock.calls.at(-1)?.[1].headers).not.toHaveProperty('Accept');
    } finally { opens.mockRestore(); }
  });
  it('does not return host facts when the inventory read is cancelled', async () => {
    const controller = new AbortController();
    let finishRead: ((response: { data: ReturnType<typeof currentMachine>[] }) => void) | undefined;
    boundaries.axiosGet.mockImplementation(() => new Promise(resolve => { finishRead = resolve; }));
    const params = { token: 'token', projection: 'hostFacts' as const, signal: controller.signal };
    const reading = listCurrentAccountMachines(params);
    controller.abort();
    finishRead!({ data: [currentMachine('selected')] });
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(boundaries.axiosGet).toHaveBeenCalledWith('https://api.example.test/v1/machines',
      expect.objectContaining({ signal: controller.signal }));
  });
  it.each(['plain', 'e2ee'] as const)('projects platform facts through the canonical %s Machine content reader', async mode => {
    const secret = new Uint8Array(32).fill(7);
    const metadata = MachinePublishedMetadataV1Schema.parse({ host: 'worker', platform: 'linux', arch: 'arm64',
      happyCliVersion: 'test', homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier',
      agentInventory: { checkedAt: 122, installedAgentIds: ['claude'] } });
    const codec = createMachineContentCodec(mode === 'plain' ? { encryptionMode: 'plain' }
      : { encryptionMode: 'e2ee', encryptionVariant: 'legacy', encryptionKey: secret });
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('machine'), metadata: codec.encodeStored(metadata),
      storageMode: mode, dataEncryptionKey: null, activeAt: 123 }] });
    const machines = await listCurrentAccountMachines({ token: 'token', credentials: {
      token: 'token', encryption: mode === 'plain' ? null : { type: 'legacy', secret },
    } });
    expect(machines).toEqual([expect.objectContaining({ id: 'machine', kind: 'persistent', platform: 'linux', arch: 'arm64', homeDir: '/home/worker', activeAt: 123,
      agentInventory: metadata.agentInventory })]);
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('machine'), metadata: 'unreadable',
      storageMode: mode, dataEncryptionKey: 'broken-key' }] });
    const unavailable = await listCurrentAccountMachines({ token: 'token', credentials: {
      token: 'token', encryption: mode === 'plain' ? null : { type: 'legacy', secret },
    } });
    expect(unavailable[0]).not.toHaveProperty('platform');
    expect(unavailable[0]).not.toHaveProperty('arch');
    expect(unavailable[0]).not.toHaveProperty('homeDir');
    expect(unavailable[0]).not.toHaveProperty('agentInventory');
  });
  it('reads the Account mode in the exact Home when legacy Machine rows do not declare it', async () => {
    const secret = new Uint8Array(32).fill(9);
    const codec = createMachineContentCodec({ encryptionMode: 'e2ee', encryptionVariant: 'legacy', encryptionKey: secret });
    const metadata = MachinePublishedMetadataV1Schema.parse({ host: 'worker', platform: 'linux', arch: 'x64',
      happyCliVersion: 'test', homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier' });
    boundaries.axiosGet.mockImplementation(async (url: string) => url.endsWith('/v1/account/encryption')
      ? { status: 200, data: AccountEncryptionModeResponseSchema.parse({ mode: 'e2ee', updatedAt: 1 }) } : { data: [
        { ...currentMachine('one'), metadata: codec.encodeStored(metadata), dataEncryptionKey: null },
        { ...currentMachine('two'), metadata: codec.encodeStored(metadata), dataEncryptionKey: null },
      ] });
    const inventory = await listCurrentAccountMachines({ token: 'token', serverHttpBaseUrl: 'https://fixed-home.example.test',
      credentials: { token: 'token', encryption: { type: 'legacy', secret } } });
    expect(inventory.map(machine => machine.platform)).toEqual(['linux', 'linux']);
    expect(boundaries.axiosGet).toHaveBeenCalledWith('https://fixed-home.example.test/v1/account/encryption',
      expect.objectContaining({ headers: { Authorization: 'Bearer token' } }));
  });
  it('resolves usable Machines beside key-pending rows with withheld metadata and preserves their access state', async () => {
    const access = { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'e2ee', accessState: 'key_pending' };
    const pending = MachinePublishedRowV1Schema.parse({ ...currentMachine('shared'), access,
      metadata: null, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 });
    boundaries.axiosGet.mockResolvedValue({ data: [pending, currentMachine('usable', 'worker')] });
    expect(await resolveCurrentAccountMachineTarget({ token: 'token' })).toMatchObject({
      kind: 'selected', target: { machineId: 'usable', machineLabel: 'worker' },
    });
    expect(boundaries.axiosGet).toHaveBeenCalledTimes(1);
    expect(await listCurrentAccountAdministrationMachines({ token: 'token' })).toEqual(['usable']);
    boundaries.axiosGet.mockResolvedValue({ data: [pending] });
    expect(await listCurrentAccountMachines({ token: 'token' })).toEqual([
      { id: 'shared', label: 'shared', kind: 'persistent', installationId: null, active: true, revokedAt: null, replacedByMachineId: null, managedMachineRef: null, access },
    ]);
    expect(await resolveCurrentAccountMachineTarget({ token: 'token' })).toMatchObject({ kind: 'unavailable', code: 'no_current_machine' });
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('shared'), access: { ...access, accessState: 'ready' } }] });
    expect(await resolveCurrentAccountMachineTarget({ token: 'token' })).toMatchObject({ kind: 'selected', target: { machineId: 'shared' } });
  });

  it('projects the complete signed Account inventory without hiding revoked machines', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [
      currentMachine('machine-current', 'desk'),
      { ...currentMachine('machine-old', 'old-desk'), active: false, revokedAt: 7, replacedByMachineId: 'machine-current' },
    ] });
    await expect(listCurrentAccountMachines({ token: 'token-1' })).resolves.toEqual([
      { id: 'machine-current', label: 'desk', kind: 'persistent', installationId: null, active: true, revokedAt: null, replacedByMachineId: null, managedMachineRef: null },
      { id: 'machine-old', label: 'old-desk', kind: 'persistent', installationId: null, active: false, revokedAt: 7, replacedByMachineId: 'machine-current', managedMachineRef: null },
    ]);
  });

  it('never selects a Temporary computer as the automatic current-daemon target', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [
      currentMachine('machine-desk', 'desk'),
      { ...currentMachine('runner-1'), kind: 'ephemeral_session_runner' },
    ] });

    // Two rows are current, but only the persistent one is an automatic target.
    await expect(resolveCurrentAccountMachineTarget({ token: 'token-1' })).resolves.toEqual({
      kind: 'selected',
      target: { machineId: 'machine-desk', machineLabel: 'desk' },
    });
  });

  it('selects the sole current API-token bootstrap machine without metadata', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [currentMachine('machine-remote')] });

    await expect(resolveCurrentAccountMachineTarget({ token: 'token-1' })).resolves.toEqual({
      kind: 'selected',
      target: { machineId: 'machine-remote', machineLabel: 'machine-remote' },
    });
    expect(boundaries.axiosGet).toHaveBeenCalledWith(
      'https://api.example.test/v1/machines',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'X-Happier-Account-Content': 'current',
        }),
      }),
    );
  });

  it('reads a fixed Action executor inventory from its qualified Home endpoint', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [currentMachine('machine-fixed')] });

    await expect(resolveCurrentAccountMachineTarget({
      token: 'token-fixed',
      serverHttpBaseUrl: 'https://fixed-home.example.test',
    })).resolves.toMatchObject({
      kind: 'selected',
      target: { machineId: 'machine-fixed' },
    });
    expect(boundaries.axiosGet).toHaveBeenCalledWith(
      'https://fixed-home.example.test/v1/machines',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-fixed' }),
      }),
    );
  });

  it('requires an explicit choice when multiple current machines exist', async () => {
    const activeAt = Date.now();
    boundaries.axiosGet.mockResolvedValue({
      data: [
        { ...currentMachine('machine-laptop', 'laptop'), activeAt },
        { ...currentMachine('machine-build', 'build-host'), activeAt },
      ],
    });

    await expect(resolveCurrentAccountMachineTarget({ token: 'token-1' })).resolves.toEqual({
      kind: 'selection_required',
      candidates: [
        { machineId: 'machine-laptop', machineLabel: 'laptop' },
        { machineId: 'machine-build', machineLabel: 'build-host' },
      ],
    });
  });

  it('uses an explicit machine target without reading account inventory', async () => {
    await expect(resolveCurrentAccountMachineTarget({
      token: 'token-1',
      requestedMachineId: ' machine-explicit ',
    })).resolves.toEqual({
      kind: 'selected',
      target: { machineId: 'machine-explicit', machineLabel: 'machine-explicit' },
    });

    expect(boundaries.axiosGet).not.toHaveBeenCalled();
  });

  it('parses inventory rows through the Protocol external Action bootstrap schema, not a local grammar', async () => {
    // A Protocol-invalid id must fail the inventory closed instead of being
    // silently trimmed into a different machine identity.
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('machine-1'), id: ' machine-1 ' }] });
    await expect(listCurrentAccountMachines({ token: 'token-1' }))
      .rejects.toMatchObject({ code: 'machine_inventory_unavailable' });

    // Absolute revocation timestamps are integer wall-clock milliseconds.
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('machine-1'), revokedAt: 1.5 }] });
    await expect(listCurrentAccountMachines({ token: 'token-1' }))
      .rejects.toMatchObject({ code: 'machine_inventory_unavailable' });
  });
});
