import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { Modal } from '@/modal';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

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

describe('useManagedMachineSelectionOffers', () => {
  it('keeps the offers identity across a machine list change that leaves the controller name alone', async () => {
    const { useManagedMachineSelectionOffers } = await import('./ManagedMachineSelectionOffers');
    const accountBinding = binding();
    const preset = {
      id: 'preset-a', homeId: 'home-a', revision: 1, name: 'Build box',
      launch: { provider: { pluginId: 'acme', localId: 'acme' }, schemaVersion: 1, name: 'Guest', choices: {} },
      controller: { machineId: 'machine-a', installationId: 'installation-a' },
    } as unknown as import('@happier-dev/protocol/machines/managed/managedMachinePresetV1').ManagedMachinePresetV1;
    const presets = [preset];
    const configure = vi.fn();
    const machine = (activeAt: number, displayName = 'Mac Studio') =>
      ({ id: 'machine-a', activeAt, metadata: { displayName, host: 'mac' } });
    const hook = await renderHook(
      (props: Readonly<{ machines: readonly unknown[] }>) => useManagedMachineSelectionOffers({
        homeId: 'home-a', binding: accountBinding, serverId: 'server-a', presets,
        machines: props.machines as never, configure,
      }),
      { initialProps: { machines: [machine(1)] } },
    );
    const before = hook.getCurrent();
    expect(before.map(offer => offer.subtitle)).toContain('Mac Studio');
    await hook.rerender({ machines: [machine(2)] });
    // A presence tick changes the list's identity, not what an offer shows.
    expect(hook.getCurrent()).toBe(before);
    await hook.rerender({ machines: [machine(3, 'Renamed Mac')] });
    const renamed = hook.getCurrent();
    expect(renamed).not.toBe(before);
    expect(renamed.map(offer => offer.subtitle)).toContain('Renamed Mac');
  });
});
