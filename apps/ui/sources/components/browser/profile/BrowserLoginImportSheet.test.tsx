import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import {
  BrowserCookieApplyV1Schema,
  BrowserCookieSourceReadV1Schema,
} from '@happier-dev/protocol/browser/profile/v1';

import {
  createDeferred,
  flushHookEffects,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import type { CustomModalChromeConfig } from '@/modal/types';
import type { SelectionListFilter } from '@/components/ui/selectionList';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({ storage: 'real' });
// Metro's deferred module loader is the boundary; Action admission, the import owner and its runner stay real.
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
      >();
    const { createFrontDoorActionExecuteForVitest } =
      await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return {
      ...original,
      createFrontDoorActionExecute:
        createFrontDoorActionExecuteForVitest(original),
    };
  },
);
// The daemon is reached over the Machine RPC transport; that socket hop is the genuine boundary here.
type MachineCall = Readonly<{
  machineId: string;
  method: string;
  payload: unknown;
  signal?: AbortSignal;
}>;
const machine = vi.hoisted(() => ({
  calls: [] as MachineCall[],
  answer: (_call: MachineCall): Promise<unknown> => Promise.resolve(null),
}));
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')
    >()),
    machineRpcWithServerScope: async (call: MachineCall) => {
      machine.calls.push(call);
      return machine.answer(call);
    },
  }),
);

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
// Load the real app after its transport boundaries, before timed sheet interactions.
await loadSyncSingletonForTests();
const { BrowserLoginImportSheet } = await import('./BrowserLoginImportSheet');

afterEach(async () => {
  await standardCleanup();
  machine.calls.length = 0;
  await home.reset();
});

const sources = {
  sources: [
    { browser: 'chromium', profileId: 'Default', label: 'Chrome · Default' },
  ],
  unsupported: [],
};
const cookie = {
  name: 'session',
  value: 'disposable',
  domain: '.github.com',
  path: '/',
  secure: true,
  httpOnly: true,
};

async function mountSheet(options: Readonly<{
  machines?: readonly Machine[];
  setChrome?: (chrome: CustomModalChromeConfig | null) => void;
}> = {}) {
  await loadSyncSingletonForTests();
  installHomeGovernanceBoundaries(home);
  const serverId = await home.addHome({
    name: 'Import Home',
    serverUrl: 'https://login-import.test',
    serverIdentityId: 'srv_login_import',
    accountId: 'owner',
    currentAccount: true,
  });
  const { resolveServerProfileScopeIdForIdentifier } =
    await import('@/sync/domains/server/serverProfiles');
  const scopedServerId = resolveServerProfileScopeIdForIdentifier(serverId);
  if (options.machines)
    await publishMachineInventoryForTest(
      { serverId: scopedServerId, accountId: 'owner' },
      options.machines,
    );
  const onClose = vi.fn();
  const screen = await renderScreen(
    <BrowserLoginImportSheet
      onClose={onClose}
      {...(options.setChrome ? { setChrome: options.setChrome } : {})}
      destination={{
        serverId: scopedServerId,
        accountId: 'owner',
        machineId: 'machine-a',
        browserSessionId: 'session-a',
        viewId: 'view-a',
        profileId: 'profile-a',
        profileName: 'CREDUI3 profile',
      }}
    />,
  );
  await vi.waitFor(() =>
    expect(
      screen.findByTestId('browser-login-import:source:chromium:Default'),
    ).toBeTruthy(),
  );
  return { screen, onClose };
}

describe('BrowserLoginImportSheet', () => {
  it('chooses the source Machine from one chip that tells same-named Machines apart', async () => {
    machine.answer = async (call) => {
      if (call.method === RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES)
        return sources;
      throw new Error(`unexpected ${call.method}`);
    };
    const named = (id: string, host: string) =>
      createMachineFixture({
        id,
        activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, host },
      });
    const { screen } = await mountSheet({
      machines: [
        named('machine-a', 'studio'),
        named('machine-b0001', 'build-box'),
        named('machine-c0002', 'build-box'),
      ],
    });
    // One chooser in the From section, not one row per Machine.
    expect(screen.findByTestId('browser-login-import:machine:machine-b0001')).toBeFalsy();
    expect(screen.findByTestId('browser-login-import:source-machine')).toBeTruthy();
    // The chooser's popover is the shared chip's own (a window-bound Popover); this reads its choices.
    const { SelectionListFilterChip } = await import('@/components/ui/selectionList');
    const chip = screen.findByType(SelectionListFilterChip).props.filter as SelectionListFilter;
    const label = (id: string) => chip.options?.find((option) => option.id === id)?.label;
    expect(chip.options?.map((option) => option.id)).toEqual(['machine-a', 'machine-b0001', 'machine-c0002']);
    expect(label('machine-b0001')).not.toEqual(label('machine-c0002'));
    expect(chip.selectedId).toBe('machine-a');
    await act(async () => chip.onChange?.('machine-c0002'));
    await vi.waitFor(() =>
      expect(
        machine.calls.filter((call) => call.method === RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES)
          .map((call) => call.machineId),
      ).toEqual(['machine-a', 'machine-c0002']),
    );
  });

  it('puts its purpose in the subtitle and Cancel/Import in the card footer', async () => {
    machine.answer = async () => sources;
    const setChrome = vi.fn<(chrome: CustomModalChromeConfig | null) => void>();
    const { screen } = await mountSheet({ setChrome });
    const chrome = setChrome.mock.calls.at(-1)?.[0];
    expect(chrome).toMatchObject({ kind: 'card', subtitle: t('browserShell.loginImport.purpose') });
    // The body no longer carries the actions; the footer stays in view while the body scrolls.
    expect(screen.findByTestId('browser-login-import:import')).toBeFalsy();
    expect(screen.getTextContent()).not.toContain(t('browserShell.loginImport.purpose'));
    const footer = await renderScreen(<>{chrome && 'footer' in chrome ? chrome.footer : null}</>);
    expect(footer.findByTestId('browser-login-import:import')).toBeTruthy();
    expect(footer.findByTestId('browser-login-import:cancel')).toBeTruthy();
  });

  it('imports cookies for the listed sites from the chosen profile and shows each record', async () => {
    machine.answer = async (call) => {
      if (call.method === RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES)
        return sources;
      if (call.method === RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ)
        return {
          status: 'ready',
          cookies: [cookie],
          skipped: [
            {
              domain: 'example.org',
              name: 'tracker',
              status: 'skipped',
              code: 'partition_unsupported',
            },
          ],
        };
      if (call.method === RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY) {
        const apply = BrowserCookieApplyV1Schema.parse(call.payload);
        return {
          status: 'completed',
          records: apply.cookies.map((c) => ({
            domain: c.domain,
            name: c.name,
            status: 'imported',
          })),
        };
      }
      throw new Error(`unexpected ${call.method}`);
    };
    const { screen } = await mountSheet();
    // Nothing is read from the source until the person names sites and confirms.
    expect(machine.calls.map((call) => call.method)).toEqual([
      RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES,
    ]);
    expect(
      screen.findByTestId('browser-login-import:import')?.props.disabled,
    ).toBe(true);
    screen.changeTextByTestId('browser-login-import:sites.item.0', 'github.com');
    await flushHookEffects();
    await screen.pressByTestIdAsync('browser-login-import:import');

    await vi.waitFor(() =>
      expect(screen.findByTestId('browser-login-import:result')).toBeTruthy(),
    );
    const read = machine.calls.find(
      (call) =>
        call.method === RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ,
    )!;
    expect(BrowserCookieSourceReadV1Schema.parse(read.payload)).toEqual({
      source: { browser: 'chromium', profileId: 'Default' },
      sites: ['https://github.com'],
    });
    expect(read.machineId).toBe('machine-a');
    expect(screen.findByTestId('browser-login-import:record:0')).toBeTruthy();
    expect(screen.findByTestId('browser-login-import:record:1')).toBeTruthy();
    expect(screen.findByTestId('browser-login-import:record:2')).toBeFalsy();
    // A skipped cause's next step is said once, in the section description above the rows.
    const nextStep = t('browserShell.loginImport.nextSteps.partition_unsupported');
    expect(screen.getTextContent().split(nextStep).length - 1).toBe(1);
    // A completed import has nothing to retry.
    expect(screen.findByTestId('browser-login-import:back')).toBeFalsy();
  });

  it('cancels an import in flight without claiming success', async () => {
    const held = createDeferred<unknown>();
    machine.answer = async (call) => {
      if (call.method === RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES)
        return sources;
      if (call.method === RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY)
        return held.promise;
      throw new Error(`unexpected ${call.method}`);
    };
    const { screen, onClose } = await mountSheet();
    screen.changeTextByTestId('browser-login-import:sites.item.0', 'github.com');
    await flushHookEffects();
    await screen.pressByTestIdAsync('browser-login-import:import');
    await vi.waitFor(() =>
      expect(
        machine.calls.some(
          (call) =>
            call.method === RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY,
        ),
      ).toBe(true),
    );
    await screen.pressByTestIdAsync('browser-login-import:cancel');
    held.resolve({ status: 'completed', records: [] });

    await vi.waitFor(() =>
      expect(screen.findByTestId('browser-login-import:result')).toBeTruthy(),
    );
    expect(screen.findByTestId('browser-login-import:outcome')).toBeTruthy();
    expect(screen.findByTestId('browser-login-import:record:0')).toBeFalsy();
    // Cancel stops the import; it does not close the sheet or read the source.
    expect(onClose).not.toHaveBeenCalled();
    expect(
      machine.calls.some(
        (call) =>
          call.method === RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ,
      ),
    ).toBe(false);
  });
});
