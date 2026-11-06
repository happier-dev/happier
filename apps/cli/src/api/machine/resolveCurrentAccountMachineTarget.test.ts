import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({ axiosGet: vi.fn(), axiosPost: vi.fn() }));

vi.mock('axios', () => ({ default: { get: boundaries.axiosGet, post: boundaries.axiosPost } }));
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
    expect(machines).toEqual([expect.objectContaining({ id: 'machine', kind: 'persistent', platform: 'linux', arch: 'arm64', activeAt: 123,
      agentInventory: metadata.agentInventory })]);
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('machine'), metadata: 'unreadable',
      storageMode: mode, dataEncryptionKey: 'broken-key' }] });
    const unavailable = await listCurrentAccountMachines({ token: 'token', credentials: {
      token: 'token', encryption: mode === 'plain' ? null : { type: 'legacy', secret },
    } });
    expect(unavailable[0]).not.toHaveProperty('platform');
    expect(unavailable[0]).not.toHaveProperty('arch');
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
  it('preserves accessible Machine readiness and never auto-selects a pending shared target', async () => {
    const access = { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'e2ee', accessState: 'key_pending' };
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('shared'), access }] });
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
      { ...currentMachine('machine-old', 'old-desk'), active: false, revokedAt: 7, replacedByMachineId: 'machine-current', managedMachineRef: null },
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
    boundaries.axiosGet.mockResolvedValue({
      data: [currentMachine('machine-laptop', 'laptop'), currentMachine('machine-build', 'build-host')],
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
