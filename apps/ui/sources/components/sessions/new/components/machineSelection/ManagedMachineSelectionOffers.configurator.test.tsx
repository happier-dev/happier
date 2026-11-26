import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storage';
import { createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { Modal } from '@/modal';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands, useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';

const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push } }).module);

/**
 * The configurator outlives the picker that opened it (lab m-pick): the host closes first, then the
 * configurator opens as its own modal and stays open when the picker's content unmounts.
 * The modal provider is the overlay host boundary; it is replaced with a recording one.
 */
function recordModalHost() {
  const events: string[] = [];
  const shown: Array<Readonly<{ id: string; props: Record<string, unknown> }>> =
    [];
  Modal.setFunctions(
    (config) => {
      const id = `modal-${shown.length + 1}`;
      events.push(`show:${id}`);
      shown.push({
        id,
        props: (config as { props?: Record<string, unknown> }).props ?? {},
      });
      return id;
    },
    (id) => {
      events.push(`hide:${id}`);
    },
    () => {
      events.push('hideAll');
    },
  );
  return { events, shown };
}

function binding(current = true): ServerCredentialAccountScopeBinding {
  return {
    accountId: 'account-a',
    serverId: 'server-a',
    revision: 1,
    scope: { serverId: 'server-a', accountId: 'account-a' },
    isCurrent: () => current,
    onRetire: () => Object.freeze({ dispose(): void {} }),
  } as unknown as ServerCredentialAccountScopeBinding;
}

describe('useManagedMachineConfigurator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes the picker first, then opens the configurator, which survives the picker unmounting', async () => {
    const host = recordModalHost();
    const { useManagedMachineConfigurator } =
      await import('./ManagedMachineSelectionOffers');
    const onConfigure = vi.fn(() => {
      host.events.push('picker:close');
    });
    const onUse = vi.fn();
    const accountBinding = binding();
    const hook = await renderHook(() =>
      useManagedMachineConfigurator({
        serverId: 'server-a',
        binding: accountBinding,
        onUse,
        onConfigure,
      }),
    );

    hook.getCurrent()(null);
    await hook.unmount();

    expect(host.events).toEqual(['picker:close', 'show:modal-1']);
    // The opener's binding dies with the picker (its isCurrent() follows the picker's mount), so the
    // modal takes the Account to keep, not the binding: a stale binding closed it in a loop live.
    expect(host.shown[0]?.props.binding).toBeUndefined();
    expect(host.shown[0]?.props.accountId).toBe(accountBinding.accountId);
    expect(host.shown[0]?.props.preset).toBeNull();
  });

  it('keeps the configurator identity across fresh host handlers and opens with the newest one', async () => {
    const host = recordModalHost();
    const { useManagedMachineConfigurator } =
      await import('./ManagedMachineSelectionOffers');
    const accountBinding = binding();
    let onConfigure = vi.fn();
    const hook = await renderHook(() =>
      useManagedMachineConfigurator({
        serverId: 'server-a',
        binding: accountBinding,
        onUse: () => {},
        onConfigure: () => onConfigure(),
      }),
    );
    const first = hook.getCurrent();
    await hook.rerender();
    expect(hook.getCurrent()).toBe(first);
    const latest = vi.fn();
    onConfigure = latest;
    first(null);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(host.shown).toHaveLength(1);
    await hook.unmount();
  });

  it.each([[true, true], [false, false], [undefined, false]] as const)(
    'opens the configurator to start the session only when the composer holds a drafted prompt (%s)',
    async (drafted, startsSession) => {
      const host = recordModalHost();
      const { useManagedMachineConfigurator } = await import('./ManagedMachineSelectionOffers');
      const onUse = vi.fn();
      const hook = await renderHook(() =>
        useManagedMachineConfigurator({ serverId: 'server-a', binding: binding(), onUse,
          ...(drafted === undefined ? {} : { startsSession: () => drafted }) }),
      );
      hook.getCurrent()(null);
      // Read once, as the configurator opens: the modal never subscribes to the composer's text.
      expect(host.shown[0]?.props.startsSession).toBe(startsSession);
      await hook.unmount();
    },
  );

  it('opens nothing and leaves the picker alone for an Account that is no longer current', async () => {
    const host = recordModalHost();
    const { useManagedMachineConfigurator } =
      await import('./ManagedMachineSelectionOffers');
    const onConfigure = vi.fn();
    const hook = await renderHook(() =>
      useManagedMachineConfigurator({
        serverId: 'server-a',
        binding: binding(false),
        onUse: vi.fn(),
        onConfigure,
      }),
    );

    hook.getCurrent()(null);

    expect(onConfigure).not.toHaveBeenCalled();
    expect(host.events).toEqual([]);
    await hook.unmount();
  });
});

/** Where the offer's cost column says a local machine runs: the controller's current name. */
const runsOn = (offer: { cost?: unknown }) => (offer.cost as { props?: { runsOn?: string } } | undefined)?.props?.runsOn;

describe('useManagedMachineSelectionOffers', () => {
  it('disables only an assigned-controller preset while its controller is unavailable and recovers on presence', async () => {
    const { useManagedMachineSelectionOffers } = await import('./ManagedMachineSelectionOffers');
    const accountBinding = binding();
    const presetInput = {
      id: 'preset-a', homeId: 'home-a', revision: 1, name: 'Build box',
      owner: { kind: 'account', accountId: 'account-a' },
      launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
      controller: { machineId: 'machine-a', installationId: 'installation-a' },
    } as const;
    const preset = createPlainManagedMachinePresetFixture(presetInput).opened;
    const poolPreset = createPlainManagedMachinePresetFixture({ ...presetInput, id: 'pool-preset', controller: undefined,
      controllerPoolId: '11111111-1111-4111-8111-111111111111' }).opened;
    const accountPreset = createPlainManagedMachinePresetFixture({ ...presetInput, id: 'account-preset', controller: undefined }).opened;
    const presets = [preset, poolPreset, accountPreset];
    const beforeState = storage.getState();
    const machine = createMachineFixture({ id: 'machine-a', installationId: 'installation-a', active: false,
      activeAt: 1, metadata: createMachineMetadataFixture({ displayName: 'Mac Studio' }) });
    storage.getState().applyMachines([machine], true, { sourceServerId: 'server-a', sourceAccountId: 'account-a' });
    const configure = vi.fn();
    let renders = 0;
    const hook = await renderHook(() => {
      renders++;
      return useManagedMachineSelectionOffers({ homeId: 'home-a', binding: accountBinding,
        serverId: 'server-a', presets, configure });
    });
    try {
      expect(hook.getCurrent()[0]).toMatchObject({ disabled: true, unavailableText: expect.any(String) });
      expect(hook.getCurrent()[0]!.unavailableText).toContain('Mac Studio');
      expect(hook.getCurrent().slice(1).every(offer => offer.disabled !== true)).toBe(true);
      await act(async () => {
        storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: Date.now() }],
          { sourceServerId: 'server-a', sourceAccountId: 'account-a' });
      });
      expect(hook.getCurrent()[0]!.disabled).not.toBe(true);
      const onlineOffers = hook.getCurrent();
      const onlineRenders = renders;
      for (let tick = 1; tick <= 10; tick++) await act(async () => {
        storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: Date.now() + tick }],
          { sourceServerId: 'server-a', sourceAccountId: 'account-a' });
      });
      expect(renders).toBe(onlineRenders);
      expect(hook.getCurrent()).toBe(onlineOffers);
      await act(async () => storage.getState().applyMachines([{ ...machine, installationId: 'replacement' }], false,
        { sourceServerId: 'server-a', sourceAccountId: 'account-a' }));
      expect(hook.getCurrent()[0]!.disabled).toBe(true);
    } finally { await hook.unmount(); standardCleanup(); storage.setState(beforeState, true); }
  });

  it('offers a Team-delegated preset whose controller this Account cannot see, leaving readiness to admission', async () => {
    const { useManagedMachineSelectionOffers } = await import('./ManagedMachineSelectionOffers');
    const accountBinding = binding();
    const presetInput = {
      id: 'team-preset', homeId: 'home-a', revision: 1, name: 'Team box',
      owner: { kind: 'team', teamId: 'team-a' },
      launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
      controller: { machineId: 'owner-controller', installationId: 'installation-o' },
    } as const;
    const delegated = createPlainManagedMachinePresetFixture({ ...presetInput, teamAcquireDelegated: true }).opened;
    const undelegated = createPlainManagedMachinePresetFixture({ ...presetInput, id: 'own-preset' }).opened;
    const hook = await renderHook(() => useManagedMachineSelectionOffers({ homeId: 'home-a', binding: accountBinding,
      serverId: 'server-a', presets: [delegated, undelegated], configure: vi.fn() }));
    try {
      const offer = (presetId: string) => hook.getCurrent().find(row => row.presetId === presetId);
      expect(offer('team-preset')).toBeDefined();
      expect(offer('team-preset')!.disabled).not.toBe(true);
      expect(offer('own-preset')!.disabled).toBe(true);
    } finally { await hook.unmount(); standardCleanup(); }
  });

  it('keeps the offers identity across a machine list change that leaves the controller name alone', async () => {
    const { useManagedMachineSelectionOffers } = await import('./ManagedMachineSelectionOffers');
    const accountBinding = binding();
    const preset = createPlainManagedMachinePresetFixture({
      id: 'preset-a', homeId: 'home-a', revision: 1, name: 'Build box',
      owner: { kind: 'account', accountId: 'account-a' },
      launch: { provider: { pluginId: 'acme.compute', localId: 'acme' }, schemaVersion: 1, name: 'Guest', choices: {} },
      controller: { machineId: 'machine-a', installationId: 'installation-a' },
    }).opened;
    const presets = [preset];
    const configure = vi.fn();
    const beforeState = storage.getState();
    const machine = createMachineFixture({ id: 'machine-a', metadata: createMachineMetadataFixture({ displayName: 'Mac Studio', host: 'mac' }) });
    storage.getState().applyMachines([machine], true, { sourceServerId: 'server-a' });
    let renders = 0;
    const hook = await renderHook(() => {
      renders++;
      return useManagedMachineSelectionOffers({ homeId: 'home-a', binding: accountBinding,
        serverId: 'server-a', presets, configure });
    });
    try {
      const before = hook.getCurrent();
      expect(before.map(runsOn)).toContain('Mac Studio');
      const initialRenders = renders;
      for (let tick = 1; tick <= 10; tick++) await act(async () => {
        storage.getState().applyMachines([{ ...machine, activeAt: machine.activeAt + tick }], false, { sourceServerId: 'server-a' });
      });
      expect(renders).toBe(initialRenders);
      expect(hook.getCurrent()).toBe(before);
      await act(async () => storage.getState().applyMachines([{ ...machine,
        metadata: { ...machine.metadata!, displayName: 'Renamed Mac' } }], false, { sourceServerId: 'server-a' }));
      expect(hook.getCurrent().map(runsOn)).toContain('Renamed Mac');
    } finally { await hook.unmount(); standardCleanup(); storage.setState(beforeState, true); }
  });
});

describe('managed machine offers approval navigation', () => {
  it('publishes only the foreground machine picker commands and opens its preset-read approval like Details', async () => {
    const homes = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(homes);
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { NewSessionMachineSelectionContent } = await import('../NewSessionMachineSelectionContent');
    try {
      // The terminal bearer narrows this UI read to Account automation, whose Ask opens a durable approval.
      const accountId = 'owner';
      const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId, session: 'terminal-test' })).toString('base64url')}.test`;
      const serverId = await homes.addHome({ name: 'Build', serverUrl: 'https://managed-offers.test',
        serverIdentityId: 'srv_managed_offers', accountId, credentials: { token } });
      const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId };
      storage.setState({ profileScope: scope, settingsScope: scope });
      publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
      homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 } });
      await act(async () => { storage.getState().applySettingsLocal({ managedMachineCreationEnabled: true }); });
      await homes.requireUiApproval(serverId, 'machines.presets.list');
      const authority = captureActiveServerAccountScopeLifetime();
      function Publication() {
        const commands = useCurrentUiContextComposedCommands();
        usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
        return null;
      }
      function BackgroundCommand() {
        useCurrentUiContextLocalCommands([{ key: 'page.open', title: 'Open page settings', invoke: () => {} }]);
        return null;
      }
      const pickerProps = { groups: [], selectedMachine: null, selectedServerId: scope.serverId, recentMachines: [],
        favoriteMachines: [], onSelectMachine: vi.fn(), onSelectScopedMachine: vi.fn(), onSelectManagedMachine: vi.fn() };
      const surface = (visible: boolean) => <CurrentUiContextCommandsProvider authority={authority}>
        <Publication /><BackgroundCommand />
        {visible ? <NewSessionMachineSelectionContent {...pickerProps} maxHeight={400} showSearch={false}
          currentUiContextCommandScope="placement.machine" currentUiContextForegroundOverlay /> : null}
      </CurrentUiContextCommandsProvider>;
      const executor = createDefaultActionExecutor();
      const readCommands = async () => {
        const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
        if (!read.ok) throw new Error(`Expected current context, got ${read.errorCode}`);
        return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
      };
      const screen = await renderMountedCurrentUiContext(surface(false));
      try {
        expect((await readCommands()).map(command => command.title)).toEqual(['Open page settings']);
        await screen.update(surface(true));
        const control = 'managed-machine-selection-approval.action';
        await waitForHomeGovernance(() => expect(screen.findByTestId(control)).not.toBeNull());
        const [approval] = homes.artifacts(serverId).list();
        if (!approval) throw new Error('Expected the persisted preset list approval');
        const expectedRoute = buildApprovalHref(approval.id, scope.serverId);
        await screen.pressByTestIdAsync(control);
        expect(push.mock.calls).toEqual([[expectedRoute]]);
        const inventory = await readCommands();
        expect(inventory.map(command => command.title).sort()).toEqual([t('common.choose'), t('common.close'), t('approvals.details')].sort());
        const commandId = inventory.find(command => command.title === t('approvals.details'))!.id;
        await act(async () => {
          expect(await executor.execute('ui.current_context.command.invoke', { commandId }, { surface: 'agent' })).toMatchObject({ ok: true });
        });
        expect(push.mock.calls).toEqual([[expectedRoute], [expectedRoute]]);
        await screen.update(surface(false));
        expect(screen.findByTestId(control)).toBeNull();
        expect((await readCommands()).map(command => command.title)).toEqual(['Open page settings']);
        expect(await executor.execute('ui.current_context.command.invoke', { commandId }, { surface: 'agent' })).toMatchObject({ ok: false });
      } finally { await screen.unmount(); }
    } finally { standardCleanup(); await homes.reset(); push.mockClear(); }
  });
});
