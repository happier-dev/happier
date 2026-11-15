import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { BrowserExtensionsListResultV1Schema } from '@happier-dev/protocol/actions';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { useBrowserExtensionsInventory } = await import('./storeBrowserExtensions');
// The Home transport is installed per case, as the harness's other multi-case suites do.
beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(homes); });
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
  let gate: Promise<void> | null = null;
  const extensionId = 'a'.repeat(32);
  let value = BrowserExtensionsListResultV1Schema.parse({ status: 'ready', entries: ['work', 'personal'].map(profileId => ({
    profileId, restartRequired: true, extension: { id: extensionId, name: 'Passwords', version: '1.0', enabled: true,
      source: { kind: 'webStore', extensionId }, directory: '/browser/extensions/passwords', permissions: ['storage'], hostPermissions: [] },
  })) });
  const path = '/v1/actions/browser.extensions.list';
  homes.answer(serverId, path, { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    expect(envelope.input).toMatchObject({ machineId });
    await pending.promise;
    if (gate) await gate;
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
    const first = hook.getCurrent().rows[0];
    expect(first?.subject === 'extension' && first.native.restartRequired).toBe(true);
    await hook.rerender();
    await flushHookEffects();
    expect(homes.requestsFor(path)).toHaveLength(1);
    const unchangedProfile = hook.getCurrent().rows[1];
    if (value.status !== 'ready') throw new Error('Expected the ready extension fixture');
    value = { ...value, entries: value.entries.map((entry, index) => index === 0
      ? { ...entry, extension: { ...entry.extension, version: '2.0' } } : entry) };
    await act(async () => hook.getCurrent().refresh());
    await vi.waitFor(() => {
      const updated = hook.getCurrent().rows[0];
      expect(updated?.subject === 'extension' && updated.native.extension.version).toBe('2.0');
    });
    expect(hook.getCurrent().rows[1]).toBe(unchangedProfile);
    value = { status: 'unavailable', code: 'managed_browser_required' };
    // A refresh of the same list keeps its last settled rows until the new answer lands.
    const refreshed = createDeferred<void>();
    gate = refreshed.promise;
    await act(async () => hook.getCurrent().refresh());
    await vi.waitFor(() => expect(homes.requestsFor(path)).toHaveLength(3));
    expect(hook.getCurrent().rows).toHaveLength(2);
    gate = null;
    await act(async () => refreshed.resolve());
    // REVIEW-2 R4 (UI refinements 09:23Z): a Machine whose managed browser isn't available (its runtime wasn't acquired)
    // stays a typed failure, never an empty inventory, and the Store's coverage line carries its reason.
    await vi.waitFor(() => expect(hook.getCurrent().coverage).toMatchObject({ unavailable: [{
      machineId, reason: { kind: 'browser', value: { status: 'unavailable', code: 'managed_browser_required' } },
    }] }));
    expect(hook.getCurrent().rows).toEqual([]);
    const { inventoryFamilyDiagnosticCode } = await import('@/components/store/inventory/inventoryCoverage');
    expect(inventoryFamilyDiagnosticCode(hook.getCurrent().coverage as never)).toBe('managed_browser_required');
    value = { status: 'ready', entries: [] };
    await act(async () => hook.getCurrent().refresh());
    await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: 'available' }));
    expect(homes.requestsFor(path)).toHaveLength(4);
  } finally { await hook.unmount(); account.dispose(); }
});

it('shows each Machine\'s extensions as it answers, without waiting for an unreachable Machine', async () => {
  const serverId = await homes.addHome({ name: 'Browser machines', serverUrl: 'https://browser-extensions-machines.test',
    serverIdentityId: 'srv_browser_extensions_machines', accountId: 'alice', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const machines = ['machine-a', 'machine-b'].map(id => ({ ...createPlainMachineRowFixture({ id, accountId: 'alice' }), installationId: `installation-${id}` }));
  for (const machine of machines) homes.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine } });
  homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({
    body: await createMachineReadBatchResponseFixture(input, id => machines.find(machine => machine.id === id) ?? machines[0]!).json(),
  }) });
  const unreachable = createDeferred<void>();
  const extensionId = 'c'.repeat(32);
  const path = '/v1/actions/browser.extensions.list';
  homes.answer(serverId, path, { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    const machineId = (envelope.input as { machineId: string }).machineId;
    if (machineId === 'machine-b') await unreachable.promise;
    const value = { status: 'ready', entries: machineId === 'machine-b' ? [] : [{ profileId: 'work', restartRequired: false,
      extension: { id: extensionId, name: 'Reader', version: '1.0', enabled: true, source: { kind: 'webStore', extensionId },
        directory: '/browser/extensions/reader', permissions: [], hostPermissions: [] } }] };
    return { body: { v: 1, actionId: 'browser.extensions.list', requestId: envelope.requestId, execution: { ok: true, result: value } } };
  } });
  const hook = await renderHook(() => useBrowserExtensionsInventory({ scope: account.accountLifetime.scope,
    machineIds: ['machine-a', 'machine-b'], presented: true }));
  try {
    await vi.waitFor(() => expect(hook.getCurrent().rows.map(row => row.machineId)).toEqual(['machine-a']));
    expect(hook.getCurrent().coverage).toBe('loading');
    await act(async () => unreachable.resolve());
    await vi.waitFor(() => expect(hook.getCurrent().coverage).toBe('available'));
  } finally { await hook.unmount(); account.dispose(); }
});

it('lists each held Machine once per open while the Machine set grows, and one refusing Machine settles as its own failure', async () => {
  const { projectExternalActionHttpError } = await import('@happier-dev/protocol/actions/externalActionHttpError');
  const serverId = await homes.addHome({ name: 'Browser growth', serverUrl: 'https://browser-extensions-growth.test',
    serverIdentityId: 'srv_browser_extensions_growth', accountId: 'alice', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const ids = ['machine-a', 'machine-b', 'machine-c'];
  const machines = ids.map(id => ({ ...createPlainMachineRowFixture({ id, accountId: 'alice' }), installationId: `installation-${id}` }));
  for (const machine of machines) homes.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine } });
  homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({
    body: await createMachineReadBatchResponseFixture(input, id => machines.find(machine => machine.id === id) ?? machines[0]!).json(),
  }) });
  const slow = createDeferred<void>();
  const path = '/v1/actions/browser.extensions.list';
  const extension = (id: string) => ({ id, name: 'Reader', version: '1.0', enabled: true, source: { kind: 'webStore', extensionId: id },
    directory: `/browser/extensions/${id}`, permissions: [], hostPermissions: [] });
  homes.answer(serverId, path, { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    const machineId = (envelope.input as { machineId: string }).machineId;
    if (machineId === 'machine-b') {
      const refused = projectExternalActionHttpError('target_unavailable', envelope.requestId);
      return { status: refused.statusCode, body: refused.payload };
    }
    if (machineId === 'machine-a') await slow.promise;
    const id = machineId === 'machine-a' ? 'a'.repeat(32) : 'c'.repeat(32);
    return { body: { v: 1, actionId: 'browser.extensions.list', requestId: envelope.requestId,
      execution: { ok: true, result: { status: 'ready', entries: [{ profileId: 'work', restartRequired: false, extension: extension(id) }] } } } };
  } });
  let held = ids.slice(0, 1);
  const hook = await renderHook(() => useBrowserExtensionsInventory({ scope: account.accountLifetime.scope, machineIds: held, presented: true }));
  try {
    await vi.waitFor(() => expect(homes.requestsFor(path)).toHaveLength(1));
    // Installed learns its held Machines one by one; each arrival lists only the new Machine.
    held = ids.slice(0, 2);
    await hook.rerender();
    held = [...ids];
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().rows.map(row => row.machineId)).toEqual(['machine-c']));
    await act(async () => slow.resolve());
    await vi.waitFor(() => expect(hook.getCurrent().rows.map(row => row.machineId)).toEqual(['machine-a', 'machine-c']));
    expect(hook.getCurrent().coverage).toMatchObject({ partial: [{ machineId: 'machine-b', reason: { kind: 'action', code: 'target_unavailable' } }] });
    await flushHookEffects();
    expect(homes.requestsFor(path)).toHaveLength(3);
  } finally { await hook.unmount(); account.dispose(); }
});

it('reads only Machines presence reports reachable; offline ones settle from presence without a read, and one coming online is read', async () => {
  const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
  const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
  const { useInstalledScope } = await import('./storeAccountAdmission');
  const { useInstalledBrowserExtensions } = await import('./storeBrowserExtensions');
  const serverId = await homes.addHome({ name: 'Browser presence', serverUrl: 'https://browser-extensions-presence.test',
    serverIdentityId: 'srv_browser_extensions_presence', accountId: 'alice', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const scope = account.accountLifetime.scope;
  const online = { ...createMachineFixture({ id: 'machine-online', activeAt: Date.now() }), installationId: 'installation-online' };
  const offline = ['machine-off-1', 'machine-off-2', 'machine-off-3'].map(id => ({ ...createMachineFixture({ id, active: false, activeAt: 1 }),
    installationId: `installation-${id}` }));
  const all = [online, ...offline];
  for (const machine of all) homes.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine } });
  homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({
    body: await createMachineReadBatchResponseFixture(input, id => all.find(machine => machine.id === id) ?? null).json(),
  }) });
  const path = '/v1/actions/browser.extensions.list';
  const extensionId = 'd'.repeat(32);
  homes.answer(serverId, path, { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    return { body: { v: 1, actionId: 'browser.extensions.list', requestId: envelope.requestId, execution: { ok: true, result: {
      status: 'ready', entries: [{ profileId: 'work', restartRequired: false, extension: { id: extensionId, name: 'Reader', version: '1.0',
        enabled: true, source: { kind: 'webStore', extensionId }, directory: '/browser/extensions/reader', permissions: [], hostPermissions: [] } }] } } } };
  } });
  await publishMachineInventoryForTest(scope, all);
  const input = { scope, machine: null, projectKey: null } as const;
  const hook = await renderHook(() => useInstalledBrowserExtensions(input, { presented: true }, useInstalledScope(input)));
  // A Machine settled from presence carries the Home's own refusal; a Machine that was read carries its read's outcome.
  // (Machines published to local inventory route this harness's read off HTTP, so the read count itself is measured live.)
  const reasons = () => {
    const coverage = hook.getCurrent().coverage;
    const failures = typeof coverage === 'object' ? 'partial' in coverage ? coverage.partial : 'unavailable' in coverage ? coverage.unavailable : [] : [];
    return Object.fromEntries((failures as readonly { machineId: string; reason: { code?: string } }[])
      .map(entry => [entry.machineId, entry.reason.code === 'target_unavailable' ? 'presence' : 'read']));
  };
  try {
    await vi.waitFor(() => expect(reasons()).toEqual({ 'machine-online': 'read', 'machine-off-1': 'presence',
      'machine-off-2': 'presence', 'machine-off-3': 'presence' }), { timeout: 20000 });
    // A Machine coming online through the existing presence path is read; the others are still not.
    await act(async () => { await publishMachineInventoryForTest(scope, [online, { ...offline[0]!, active: true, activeAt: Date.now() }, offline[1]!, offline[2]!]); });
    await vi.waitFor(() => expect(reasons()).toEqual({ 'machine-online': 'read', 'machine-off-1': 'read',
      'machine-off-2': 'presence', 'machine-off-3': 'presence' }), { timeout: 20000 });
  } finally { await hook.unmount(); account.dispose(); }
});

it('lists a saved profile with no extensions as its own row, so its page is reachable from Installed', async () => {
  const serverId = await homes.addHome({ name: 'Browser profiles', serverUrl: 'https://browser-profiles.test',
    serverIdentityId: 'srv_browser_profiles', accountId: 'alice', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const machineId = 'machine-a';
  const machine = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'alice' }), installationId: 'installation-a' };
  homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine } });
  const extensionId = 'b'.repeat(32);
  const value = BrowserExtensionsListResultV1Schema.parse({ status: 'ready', entries: [{
    profileId: 'work', restartRequired: true, extension: { id: extensionId, name: 'Passwords', version: '1.0', enabled: true,
      source: { kind: 'webStore', extensionId }, directory: '/browser/extensions/passwords', permissions: [], hostPermissions: [] },
  }], profiles: [{ profileId: 'work', displayName: 'Work' }, { profileId: 'research', displayName: 'Research' }] });
  const path = '/v1/actions/browser.extensions.list';
  homes.answer(serverId, path, { select: async body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    return { body: { v: 1, actionId: 'browser.extensions.list', requestId: envelope.requestId, execution: { ok: true, result: value } } };
  } });
  const hook = await renderHook(() => useBrowserExtensionsInventory({ scope: account.accountLifetime.scope, machineIds: [machineId], presented: true }));
  try {
    await vi.waitFor(() => expect(hook.getCurrent().coverage).toBe('available'));
    const rows = hook.getCurrent().rows;
    // The profile that holds an extension is reached through that extension's row; the empty one gets a row of its own.
    expect(rows.map(row => row.subject === 'profile' ? ['profile', row.native.displayName] : ['extension', row.native.extension.name]))
      .toEqual([['extension', 'Passwords'], ['profile', 'Research']]);
    expect(new Set(rows.map(row => row.key)).size).toBe(2);
  } finally { await hook.unmount(); account.dispose(); }
});
