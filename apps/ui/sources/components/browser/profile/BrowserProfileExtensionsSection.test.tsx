import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  createDeferred,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  createMachineReadBatchResponseFixture,
  createPlainMachineRowFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { BrowserExtensionActionResultV1 } from '@happier-dev/protocol/actions';
import type { IModal } from '@/modal';

const dialogs = vi.hoisted(() => ({
  confirm: vi.fn<IModal['confirm']>(async () => true),
  prompt: vi.fn<IModal['prompt']>(async () => null),
  alert: vi.fn<IModal['alert']>(async () => {}),
}));
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      spies: dialogs,
    }).module,
);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } =
  await import('@/sync/ops/actions/actionAccountContext');
const { BrowserProfileExtensionsSection } =
  await import('./BrowserProfileExtensionsSection');

// The Home transport is installed per case, as the harness's other multi-case suites do.
beforeEach(async () => {
  await homes.reset();
  installHomeGovernanceBoundaries(homes);
  dialogs.confirm.mockClear();
  dialogs.prompt.mockClear();
  dialogs.alert.mockClear();
});
afterEach(async () => {
  standardCleanup();
  await homes.reset();
});

const machineId = 'machine-a';
const profileId = 'work';
const extensionId = 'a'.repeat(32);
const record = (enabled: boolean) => ({
  id: extensionId,
  name: 'Passwords',
  version: '1.4.2',
  enabled,
  source: { kind: 'webStore' as const, extensionId },
  directory: '/browser/extensions/passwords',
  permissions: ['storage'],
  hostPermissions: [],
});

type Handler = (
  input: Record<string, unknown>,
) => BrowserExtensionActionResultV1 | Promise<BrowserExtensionActionResultV1>;

async function setup(handlers: Record<string, Handler>) {
  const serverId = await homes.addHome({
    name: 'Browser profile',
    serverUrl: 'https://browser-profile.test',
    serverIdentityId: 'srv_browser_profile',
    accountId: 'alice',
    currentAccount: true,
  });
  const account = await captureLazyActionAccountContext(serverId);
  const machine = {
    ...createPlainMachineRowFixture({ id: machineId, accountId: 'alice' }),
    installationId: 'installation-a',
  };
  homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine } });
  homes.answer(serverId, 'POST /v1/machines/read-batch', {
    select: async (input) => ({
      body: await createMachineReadBatchResponseFixture(
        input,
        () => machine,
      ).json(),
    }),
  });
  const inputs: Array<
    Readonly<{ actionId: string; input: Record<string, unknown> }>
  > = [];
  for (const [actionId, handler] of Object.entries(handlers)) {
    homes.answer(serverId, `/v1/actions/${actionId}`, {
      select: async (body) => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        const input = envelope.input as Record<string, unknown>;
        inputs.push({ actionId, input });
        return {
          body: {
            v: 1,
            actionId,
            requestId: envelope.requestId,
            execution: { ok: true, result: await handler(input) },
          },
        };
      },
    });
  }
  const screen = await renderScreen(
    <BrowserProfileExtensionsSection
      scope={account.accountLifetime.scope}
      machineId={machineId}
      profileId={profileId}
      testID="profile.extensions"
    />,
  );
  return { screen, inputs, dispose: () => account.dispose() };
}

const switchValue = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
  screen.findHostByTestId('profile.extensions.row.' + extensionId + '.enabled')
    ?.props.value;

it('lists the profile, turns an extension off through the restart confirmation, and keeps the row while it refreshes', async () => {
  let enabled = true;
  const refetch = createDeferred<void>();
  let lists = 0;
  let disables = 0;
  const { screen, inputs, dispose } = await setup({
    'browser.extensions.list': async () => {
      lists += 1;
      if (lists > 1) await refetch.promise;
      return {
        status: 'ready',
        entries: [
          { profileId, restartRequired: false, extension: record(enabled) },
        ],
      };
    },
    'browser.extensions.disable': () => {
      disables += 1;
      if (disables === 1)
        return { status: 'needs_restart_confirmation', profileId };
      enabled = false;
      return {
        status: 'updated',
        restartRequired: true,
        entry: { profileId, restartRequired: true, extension: record(false) },
      };
    },
  });
  try {
    await waitForHomeGovernance(() => expect(switchValue(screen)).toBe(true));
    expect(inputs[0]).toEqual({
      actionId: 'browser.extensions.list',
      input: { machineId, profileId },
    });
    await act(async () => {
      screen
        .findHostByTestId('profile.extensions.row.' + extensionId + '.enabled')!
        .props.onValueChange(false);
    });
    await waitForHomeGovernance(() => expect(lists).toBe(2));
    // The restart is the browser owner's decision; the section asks once and repeats the same Action.
    expect(dialogs.confirm).toHaveBeenCalledTimes(1);
    expect(
      inputs
        .filter((entry) => entry.actionId === 'browser.extensions.disable')
        .map((entry) => entry.input),
    ).toEqual([
      { machineId, profileId, extensionId },
      { machineId, profileId, extensionId, restartConfirmed: true },
    ]);
    // Refreshing keeps the last list on screen rather than flashing empty.
    expect(
      screen.findHostByTestId('profile.extensions.row.' + extensionId),
    ).toBeTruthy();
    await act(async () => refetch.resolve());
    await waitForHomeGovernance(() => expect(switchValue(screen)).toBe(false));
  } finally {
    await screen.unmount();
    dispose();
  }
});

it('removes an extension from a running profile with one confirmation that covers its restart', async () => {
  let installed = true;
  const { screen, inputs, dispose } = await setup({
    'browser.extensions.list': () => ({
      status: 'ready',
      entries: installed
        ? [{ profileId, restartRequired: false, extension: record(true) }]
        : [],
    }),
    'browser.extensions.remove': (input: Readonly<Record<string, unknown>>) => {
      if (input.restartConfirmed !== true)
        return { status: 'needs_restart_confirmation', profileId };
      installed = false;
      return {
        status: 'removed',
        profileId,
        extensionId,
        restartRequired: true,
      };
    },
  });
  try {
    await waitForHomeGovernance(() =>
      expect(
        screen.findHostByTestId('profile.extensions.row.' + extensionId),
      ).toBeTruthy(),
    );
    await screen.pressByTestIdAsync(
      'profile.extensions.row.' + extensionId + '.more',
    );
    await screen.pressByTestIdAsync('remove');
    await waitForHomeGovernance(() =>
      expect(
        screen.findHostByTestId('profile.extensions.row.' + extensionId),
      ).toBeFalsy(),
    );
    expect(dialogs.confirm).toHaveBeenCalledTimes(1);
    expect(
      inputs.find((entry) => entry.actionId === 'browser.extensions.remove')
        ?.input,
    ).toEqual({ machineId, profileId, extensionId, restartConfirmed: true });
    expect(screen.findHostByTestId('profile.extensions.empty')).toBeTruthy();
  } finally {
    await screen.unmount();
    dispose();
  }
});

it('installs from a pasted Chrome Web Store link through the permission review, and refuses text that names no extension', async () => {
  let installed = false;
  const review = {
    version: '1.4.2',
    permissions: ['storage'],
    hostPermissions: [],
  };
  const { screen, inputs, dispose } = await setup({
    'browser.extensions.list': () => ({
      status: 'ready',
      entries: installed
        ? [{ profileId, restartRequired: false, extension: record(true) }]
        : [],
    }),
    'browser.extensions.install': (input) => {
      if (!input.reviewedPermissions) return { status: 'needs_review', review };
      installed = true;
      return {
        status: 'updated',
        restartRequired: true,
        entry: { profileId, restartRequired: true, extension: record(true) },
      };
    },
  });
  try {
    await waitForHomeGovernance(() =>
      expect(screen.findHostByTestId('profile.extensions.empty')).toBeTruthy(),
    );
    dialogs.prompt.mockResolvedValueOnce('not a link');
    await screen.pressByTestIdAsync('profile.extensions.addLink');
    await waitForHomeGovernance(() =>
      expect(dialogs.alert).toHaveBeenCalledTimes(1),
    );
    expect(
      inputs.some((entry) => entry.actionId === 'browser.extensions.install'),
    ).toBe(false);
    dialogs.prompt.mockResolvedValueOnce(
      ` https://chromewebstore.google.com/detail/passwords/${extensionId}?hl=en `,
    );
    await screen.pressByTestIdAsync('profile.extensions.addLink');
    await waitForHomeGovernance(() =>
      expect(
        screen.findHostByTestId('profile.extensions.row.' + extensionId),
      ).toBeTruthy(),
    );
    expect(
      inputs
        .filter((entry) => entry.actionId === 'browser.extensions.install')
        .map((entry) => entry.input),
    ).toEqual([
      { machineId, profileId, source: { kind: 'webStore', extensionId } },
      {
        machineId,
        profileId,
        source: { kind: 'webStore', extensionId },
        reviewedPermissions: review,
      },
    ]);
  } finally {
    await screen.unmount();
    dispose();
  }
});

it('says why a temporary profile has no extensions instead of offering controls that cannot work', async () => {
  const { screen, dispose } = await setup({
    'browser.extensions.list': () => ({
      status: 'unavailable',
      code: 'persistent_profile_required',
    }),
  });
  try {
    await waitForHomeGovernance(() =>
      expect(
        screen.findHostByTestId('profile.extensions.unavailable'),
      ).toBeTruthy(),
    );
    expect(screen.findHostByTestId('profile.extensions.addLink')).toBeFalsy();
  } finally {
    await screen.unmount();
    dispose();
  }
});

it('opens from a Store Installed extension row onto the same Machine and profile', async () => {
    const { presentInventoryRow } = await import('@/components/store/inventory/inventoryRows');
    const { readStoreBrowserProfileRoute, readStoreMachineRoute } = await import('@/components/settings/plugins/model/pluginsSurfaceRoutes');
    const scope = { serverId: 'server-a', accountId: 'alice' } as const;
    const presentation = presentInventoryRow({ kind: 'browserExtension', subject: 'extension', key: 'k', scope, machineId,
        native: { profileId, restartRequired: false, extension: record(true) } }, { scope, machine: null, projectKey: null });
    const href = presentation.home.href;
    if (typeof href !== 'string') throw new Error('Expected a Store route');
    const url = new URL(href, 'https://happier.test');
    expect(url.pathname).toBe('/plugins/browser-profile');
    const params = Object.fromEntries(url.searchParams);
    expect(readStoreMachineRoute(params)).toEqual({ serverId: 'server-a', machineId });
    expect(readStoreBrowserProfileRoute(params)).toBe(profileId);
});

it('treats a named profile that does not exist yet as empty, so its first install can create it', async () => {
  const { screen, dispose } = await setup({
    'browser.extensions.list': () => ({ status: 'unavailable', code: 'profile_not_found' }),
  });
  try {
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('profile.extensions.empty')).toBeTruthy());
    expect(screen.findHostByTestId('profile.extensions.addLink')).toBeTruthy();
    expect(screen.findHostByTestId('profile.extensions.unavailable')).toBeFalsy();
  } finally {
    await screen.unmount();
    dispose();
  }
});
