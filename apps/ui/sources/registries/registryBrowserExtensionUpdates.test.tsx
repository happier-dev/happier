import { afterEach, beforeEach, expect, it } from 'vitest';
import { createMachineFixture, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
const { storage } = await import('@/sync/domains/state/storageStore');
const { createUiRegistryHostV1 } = await import('./registryHostDeps');
beforeEach(async () => { await homes.reset(); });
afterEach(async () => { await standardCleanup(); await homes.reset(); });

it.each([
  { filter: { kind: 'browserExtension' as const }, target: undefined },
  { filter: {}, target: undefined },
  { filter: { kind: 'browserExtension' as const, keys: [JSON.stringify(['work', 'a'.repeat(32)])] }, target: undefined },
  { filter: { kind: 'browserExtension' as const }, target: { kind: 'machine' as const, machineId: 'machine-b' } },
])('qualifies browser profile update keys by the actual Machine with $filter and target $target', async ({ filter, target }) => {
  const serverId = await homes.addHome({ name: 'Extension updates', serverUrl: 'https://browser-extension-updates.test',
    serverIdentityId: 'srv_extension_updates', accountId: 'alice', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const machines = ['machine-a', 'machine-b'].map(id => createMachineFixture({ id, activeAt: Date.now() }));
  storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
    machineListByServerId: { [serverId]: machines }, machineListStatusByServerId: { [serverId]: 'idle' } });
  const plain = machines.map(machine => ({ ...createPlainMachineRowFixture({ id: machine.id, accountId: 'alice' }), installationId: `installation-${machine.id}` }));
  for (const machine of plain) homes.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine } });
  homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({
    body: await createMachineReadBatchResponseFixture(input, id => plain.find(machine => machine.id === id) ?? null).json(),
  }) });
  const key = JSON.stringify(['work', 'a'.repeat(32)]);
  const targets: string[] = [];
  homes.answer(serverId, '/v1/actions/registries.updates.check', { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    if (envelope.target?.kind !== 'machine') throw new Error('Expected exact Machine target');
    targets.push(envelope.target.machineId);
    expect(envelope.input).toEqual(target || envelope.target.machineId === 'machine-a' ? filter : { ...filter, kind: 'browserExtension' });
    const accountResults = envelope.target.machineId === 'machine-a' && !('kind' in filter)
      ? [{ kind: 'skill', key: 'account-skill', upstream: { state: 'current' } }] : [];
    return { body: { v: 1, actionId: 'registries.updates.check', requestId: envelope.requestId, execution: { ok: true,
      result: { checkedAt: 10, results: [{ kind: 'browserExtension', key,
        upstream: { state: 'update_available', latest: { kind: 'version', version: envelope.target.machineId === 'machine-a' ? '2.0' : '3.0' } } }, ...accountResults] } } } };
  } });
  try {
    const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
    const host = await createUiRegistryHostV1(account, port, target ? { externalActionTarget: target } : {});
    const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(await host.execute('registries.updates.check', filter));
    expect(targets.sort()).toEqual(target ? ['machine-b'] : ['machine-a', 'machine-b']);
    const extensions = [
      { kind: 'browserExtension', key, machineId: 'machine-a', upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } } },
      { kind: 'browserExtension', key, machineId: 'machine-b', upstream: { state: 'update_available', latest: { kind: 'version', version: '3.0' } } },
    ];
    const expected = [
      ...extensions.filter(item => !target || item.machineId === target.machineId),
      ...('kind' in filter ? [] : [{ kind: 'skill', key: 'account-skill', upstream: { state: 'current' } }]),
    ];
    expect(result.results).toHaveLength(expected.length);
    expect(result.results).toEqual(expect.arrayContaining(expected));
  } finally { account.dispose(); }
});
