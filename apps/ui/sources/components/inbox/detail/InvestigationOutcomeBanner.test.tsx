import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { HealthNoticeInvestigationOutcome } from './healthNoticeInvestigation';

const { routerPush } = vi.hoisted(() => {
  // vitestSetup preloads runtimeFetch. Load one consistent graph with this
  // file's native HTTP adapter before importing the Account testkit and owner.
  vi.resetModules();
  return { routerPush: vi.fn() };
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
  .createExpoRouterMock({ router: { push: routerPush } }).module);

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
// The portable Account testkit uses the native HTTP host. Browser relay placement
// has its own composed coverage; keep this banner test at the physical fetch leaf.
vi.mock('@/utils/platform/tauri/transferFetch', () => ({
  resolveTauriRuntimeFetch: async () => (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } =
  await import('@/dev/testkit/harness/providerSettingsHarness');
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();

afterEach(async () => {
  standardCleanup();
  routerPush.mockClear();
  await account.reset();
});

const { InvestigationOutcomeBanner } =
  await import('./InvestigationOutcomeBanner');
const { PluginSurfaceDestinationNavigationBindingProvider } =
  await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
const { AccountNoticeInvestigationBoundary } = await import('@/hooks/inbox/AccountNoticeInvestigationProvider');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { normalizePluginUiDestinationBindingV1 } = await import('@happier-dev/protocol/plugins/ui');
const { definePlugin } = await import('@happier-dev/plugin-sdk');
const { defineProtocolObject, defineProtocolLiteral, defineProtocolString } =
  await import('@happier-dev/plugin-sdk/protocol');

function render(outcome: Extract<HealthNoticeInvestigationOutcome, { kind: 'unavailable' }>) {
  return renderScreen(
    <InvestigationOutcomeBanner
      outcome={outcome}
      serverId="home-a"
      onChoosePlacement={() => {}}
      pending={false}
    />,
  );
}

describe('Investigation outcome banner', () => {
  it('offers cloud acquisition in the notice Home when no Machine is available, without starting another investigation', async () => {
    const choose = vi.fn();
    const screen = await renderScreen(<InvestigationOutcomeBanner serverId="notice-home"
      outcome={{ kind: 'placement_choice_required', reason: 'controller_required', candidates: [], agents: [] }}
      onChoosePlacement={choose} pending={false} />);
    const create = screen.findByTestId('inbox.notice.investigate.placement.createMachine');
    expect(create).not.toBeNull();
    await act(async () => { create!.props.onPress(); });
    expect(routerPush).toHaveBeenCalledWith('/settings/machines/add?path=create&serverId=notice-home');
    expect(choose).not.toHaveBeenCalled();
  });
  it.each(['catalogUnavailable', 'configuredActionUnavailable'])('keeps %s unavailable without a configure recovery from the owner', async (code) => {
    const screen = await render({ kind: 'unavailable', code });
    expect(screen.getTextContent()).toContain(
      'inbox.work.healthNotice.unavailableTitle',
    );
    expect(screen.getTextContent()).not.toContain(
      'inbox.work.healthNotice.notSetUpTitle',
    );
  });

  it('keeps the set-up step for a catalog that answered with no investigation', async () => {
    const screen = await render({ kind: 'unavailable', code: 'configuredActionUnavailable', recovery: 'configure' });
    expect(screen.getTextContent()).toContain(
      'inbox.work.healthNotice.notSetUpTitle',
    );
  });

  // The Account owner dispatches the declared editor Action. Triage's renderer tests
  // cover that editor's page; this host test must also work for another contributor.
  it.each([
    ['the record pressed', 'deployments.set-up', { kind: 'edit', actionId: 'deployments.set-up' }],
    ['the actions list when no record answered', undefined, { kind: 'edit' }],
  ] as const)('leads the set-up step to the actions editor on %s', async (_case, configuredActionId, input) => {
    await account.restore({ machines: [] });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected the current Account');
    const { readRuntimeFetchHost } = await import('@/utils/system/runtimeFetch');
    expect(await readRuntimeFetchHost('https://provider-settings-account.test')).toBe('native');
    const opened: unknown[] = [];
    const editor = definePlugin({ id: 'acme.investigation', version: '1.0.0', displayName: 'Investigation',
      actions: { edit: { title: 'Edit investigation', surfaces: ['ui'],
        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
        inputSchema: defineProtocolObject({ kind: defineProtocolLiteral('edit'), actionId: defineProtocolString().optional() }, { policy: 'closed' }),
        run: async (command) => { opened.push(command); return { kind: 'edited' }; },
      } } });
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: editor.manifest,
      activate: api => editor.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activate' }), accountLifetime: lifetime });
    const binding = normalizePluginUiDestinationBindingV1({ pluginId: editor.manifest.id,
      destinationId: 'investigations', rendererId: 'editor', container: 'appPage', target: { kind: 'app' } });
    if (!binding) throw new Error('Expected the admitted editor page');
    const placement: PluginUiSurfacePlacementProjection = { id: 'investigations', pluginId: editor.manifest.id,
      contributionKind: 'surfacePlacement', descriptorId: 'investigations', binding, target: binding.target,
      renderer: { kind: 'reactNative', contributionId: 'editor' }, display: { developerFallback: 'Investigations' },
      availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [], failureActions: { action: 'edit' } };
    const unpublish = publishCommittedAppShellPluginUiProjection(() => ({ ...installed.projection,
      surfacePlacementsById: { investigations: placement } }));
    // Navigation is the host platform leaf. The banner delegates through the Account
    // owner rather than selecting a plugin page itself.
    const navigation = { targetKind: 'app' as const, registerOwner: () => () => {},
      openSurface: vi.fn(() => ({ ok: true as const })) };
    try {
      const screen = await renderScreen(
        <AccountNoticeInvestigationBoundary>
          <PluginSurfaceDestinationNavigationBindingProvider binding={navigation}>
            <InvestigationOutcomeBanner
              outcome={{ kind: 'unavailable', code: 'configuredActionUnavailable', recovery: 'configure',
                ...(configuredActionId === undefined ? {} : { configuredActionId }) }}
              serverId={lifetime.scope.serverId} onChoosePlacement={() => {}} pending={false} />
          </PluginSurfaceDestinationNavigationBindingProvider>
        </AccountNoticeInvestigationBoundary>,
      );
      const open = screen.findByTestId('inbox.notice.investigate.unavailable.action');
      expect(open).not.toBeNull();
      await act(async () => { open!.props.onPress(); await vi.dynamicImportSettled(); });
      await vi.waitFor(() => expect(opened).toEqual([input]));
      expect(navigation.openSurface).not.toHaveBeenCalled();
    } finally { unpublish(); await installed.dispose(); }
  });
});
