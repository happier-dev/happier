import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { BrowserExtensionsListResultV1Schema } from '@happier-dev/protocol/actions';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { useBrowserExtensionsInventory } = await import('./storeBrowserExtensions');
afterEach(async () => { standardCleanup(); await homes.reset(); });

it('retains finite list loading, profile-qualified entries, typed unavailable and explicit refresh through the real Action front door', async () => {
  const serverId = await homes.addHome({ name: 'Browser extensions', serverUrl: 'https://browser-extensions.test',
    serverIdentityId: 'srv_browser_extensions', accountId: 'alice', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const machineId = 'machine-a';
  const machine = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'alice' }), installationId: 'installation-a' };
  homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine } });
  homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({
    body: await createMachineReadBatchResponseFixture(input, () => machine).json(),
  }) });
  const pending = createDeferred<void>();
  const extensionId = 'a'.repeat(32);
  let value = BrowserExtensionsListResultV1Schema.parse({ status: 'ready', entries: ['work', 'personal'].map(profileId => ({
    profileId, restartRequired: true, extension: { id: extensionId, name: 'Passwords', version: '1.0', enabled: true,
      source: { kind: 'webStore', extensionId }, directory: '/browser/extensions/passwords', permissions: ['storage'], hostPermissions: [] },
  })) });
  const path = '/v1/actions/browser.extensions.list';
  homes.answer(serverId, path, { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    expect(envelope.input).toEqual({ machineId });
    await pending.promise;
    return { body: { v: 1, actionId: 'browser.extensions.list', requestId: envelope.requestId, execution: { ok: true, result: value } } };
  } });
  let presented = false;
  const hook = await renderHook(() => useBrowserExtensionsInventory({ scope: account.accountLifetime.scope,
    machineIds: [machineId], presented }));
  try {
    await flushHookEffects();
    expect(homes.requestsFor(path)).toHaveLength(0);
    presented = true;
    await hook.rerender();
    await vi.waitFor(() => expect(homes.requestsFor(path)).toHaveLength(1));
    expect(hook.getCurrent().coverage).toBe('loading');
    await act(async () => pending.resolve());
    await vi.waitFor(() => expect(hook.getCurrent().rows).toHaveLength(2));
    expect(hook.getCurrent().coverage).toBe('available');
    expect(new Set(hook.getCurrent().rows.map(row => row.key)).size).toBe(2);
    expect(hook.getCurrent().rows[0]?.native.restartRequired).toBe(true);
    await hook.rerender();
    await flushHookEffects();
    expect(homes.requestsFor(path)).toHaveLength(1);
    value = { status: 'unavailable', code: 'managed_browser_required' };
    await act(async () => hook.getCurrent().refresh());
    await vi.waitFor(() => expect(hook.getCurrent().coverage).toMatchObject({ unavailable: [{
      machineId, reason: { kind: 'browser', value: { status: 'unavailable', code: 'managed_browser_required' } },
    }] }));
    expect(hook.getCurrent().rows).toEqual([]);
    value = { status: 'ready', entries: [] };
    await act(async () => hook.getCurrent().refresh());
    await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: 'available' }));
    expect(homes.requestsFor(path)).toHaveLength(3);
  } finally { await hook.unmount(); account.dispose(); }
});
