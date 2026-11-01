import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      pathname: '/settings/agents/claude',
      params: { agentId: 'claude' },
    }).module,
);
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);

const daemon = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(daemon);
const account = createProviderSettingsAccountHarness();
const { AgentSessionDefaultsSection } = await import('./AgentSettingsScreen');
const { AgentIdleCompactionRows } =
  await import('./detail/AgentIdleCompactionRows');
const { resolveAgentCatalogProjection } =
  await import('@/agents/backendCatalog/agentCatalogProjection');
const { ModalProvider } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storage');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

const CLAUDE = 'agent:happier.agent.claude/claude';
const EXTERNAL = 'agent:acme.agent.relay/relay';
const SETTINGS_PATH = '/v2/account/settings';

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function settingsWrites(): number {
  return account.home.requests.filter(
    (request) => request.path === SETTINGS_PATH && request.method !== 'GET',
  ).length;
}
function stored() {
  const settings = storage.getState().settings;
  return {
    enabled: settings.sessionIdleCompactionEnabledByTargetKey,
    minimum: settings.sessionIdleCompactionMinContextTokensByTargetKey,
    window: settings.sessionIdleCompactionCacheWindowOverrideMsByTargetKey,
  };
}
async function commitField(screen: Screen, testID: string, text: string) {
  const input = screen.findByTestId(testID);
  if (!input) throw new Error(`No field ${testID}`);
  await act(async () => {
    input.props.onChangeText(text);
  });
  await act(async () => {
    screen.findByTestId(testID)?.props.onBlur();
  });
}
async function chooseWindow(screen: Screen, id: string) {
  const menu = screen.findAllByType(DropdownMenu)[0];
  if (!menu) throw new Error('No window menu');
  await act(async () => {
    menu.props.onSelect(id);
  });
}
function section(agentId: string) {
  return (
    <ModalProvider>
      <AgentSessionDefaultsSection
        projection={resolveAgentCatalogProjection(agentId, {
          enabledAgentIds: [agentId],
        })}
        compatibilityTargetKeys={[]}
        accountSettingsAvailable
        onOpenModels={null}
      />
    </ModalProvider>
  );
}
const hostAgentRows = (onRender?: React.ProfilerOnRenderCallback) => (
  <ModalProvider>
    <React.Profiler id="rows" onRender={onRender ?? (() => {})}>
      <AgentIdleCompactionRows
        agentTargetKey={EXTERNAL}
        compatibilityTargetKeys={[]}
        bundledAgentId={null}
        projectedCompaction={{
          events: true,
          idle: { mode: 'host', defaultEnabled: false },
        }}
        accountSettingsAvailable
      />
    </React.Profiler>
  </ModalProvider>
);

beforeEach(async () => {
  await account.restore({
    accountId: 'idle-compaction-owner',
    machines: [],
    waivedActions: ['settings.set'],
  });
});
afterEach(async () => {
  standardCleanup();
  daemon.reset();
  await account.reset();
});

describe('Session defaults · Compact while idle', () => {
  it('shows Claude on by default with its declared minimum, and writes the switch and size once each', async () => {
    const screen = await renderScreen(section('claude'));
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('settings.agents.detail.idleCompaction'),
      ).not.toBeNull(),
    );
    expect(
      screen.findByTestId('settings.agents.detail.idleCompaction.switch')?.props
        .value,
    ).toBe(true);
    expect(screen.getTextContent()).toContain('Over 200,000 tokens · Automatic');

    await screen.pressByTestIdAsync(
      'settings.agents.detail.idleCompaction.when.header',
    );
    const field = screen.findByTestId(
      'settings.agents.detail.idleCompaction.minContextTokens.input',
    );
    expect(field?.props.value).toBe('');
    expect(field?.props.placeholder).toBe('200,000');
    expect(field?.props.accessibilityLabel).toBe('Minimum conversation size, tokens');
    // Open, the values sit below; the header no longer repeats them.
    expect(screen.getTextContent()).not.toContain('Over 200,000 tokens');

    const before = settingsWrites();
    await act(async () => {
      field?.props.onChangeText('150000');
    });
    expect(settingsWrites()).toBe(before);
    await act(async () => {
      screen
        .findByTestId(
          'settings.agents.detail.idleCompaction.minContextTokens.input',
        )
        ?.props.onBlur();
    });
    await waitForHomeGovernance(() =>
      expect(stored().minimum[CLAUDE]).toBe(150_000),
    );
    expect(settingsWrites()).toBe(before + 1);

    // Clearing resets this Agent's field: the entry goes, nothing is stored as null.
    await commitField(
      screen,
      'settings.agents.detail.idleCompaction.minContextTokens.input',
      '',
    );
    await waitForHomeGovernance(() =>
      expect(Object.hasOwn(stored().minimum, CLAUDE)).toBe(false),
    );

    // A count it can't read is put back, with no write.
    const beforeInvalid = settingsWrites();
    await commitField(
      screen,
      'settings.agents.detail.idleCompaction.minContextTokens.input',
      'lots',
    );
    expect(settingsWrites()).toBe(beforeInvalid);

    await act(async () => {
      screen
        .findByTestId('settings.agents.detail.idleCompaction.switch')
        ?.props.onValueChange(false);
    });
    await waitForHomeGovernance(() =>
      expect(stored().enabled[CLAUDE]).toBe(false),
    );
    expect(
      screen.findByTestId('settings.agents.detail.idleCompaction.when'),
    ).toBeNull();
    expect(daemon.state.requests).toHaveLength(0);
  });

  it('offers nothing for an Agent that declares no idle compaction', async () => {
    const screen = await renderScreen(section('gemini'));
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain('Session defaults'),
    );
    expect(
      screen.findByTestId('settings.agents.detail.idleCompaction'),
    ).toBeNull();
  });

  it('lets a host-run Agent pick a documented, custom or Automatic window, each one write', async () => {
    const screen = await renderScreen(hostAgentRows());
    expect(
      screen.findByTestId('settings.agents.detail.idleCompaction.switch')?.props
        .value,
    ).toBe(false);
    expect(
      screen.findByTestId('settings.agents.detail.idleCompaction.when'),
    ).toBeNull();

    await act(async () => {
      screen
        .findByTestId('settings.agents.detail.idleCompaction.switch')
        ?.props.onValueChange(true);
    });
    await waitForHomeGovernance(() =>
      expect(stored().enabled[EXTERNAL]).toBe(true),
    );
    expect(screen.getTextContent()).toContain('Any size · Automatic');
    await screen.pressByTestIdAsync(
      'settings.agents.detail.idleCompaction.when.header',
    );
    expect(
      screen.findByTestId(
        'settings.agents.detail.idleCompaction.minContextTokens.input',
      )?.props.placeholder,
    ).toBe('No minimum');
    expect(screen.getTextContent()).not.toContain('No minimum tokens');

    const windowMenu = screen.findAllByType(DropdownMenu)[0];
    expect(windowMenu).toBeDefined();
    const presets = windowMenu!.props.items.filter(
      (item: { id: string }) => item.id !== 'automatic' && item.id !== 'custom',
    );
    expect(presets.length).toBeGreaterThan(0);
    for (const preset of presets) {
      const durationMs = Number(preset.id);
      expect(Number.isFinite(durationMs) && durationMs > 0).toBe(true);
    }

    const before = settingsWrites();
    await chooseWindow(screen, String(30 * 60_000));
    await waitForHomeGovernance(() =>
      expect(stored().window[EXTERNAL]).toBe(1_800_000),
    );
    expect(settingsWrites()).toBe(before + 1);

    await chooseWindow(screen, 'custom');
    expect(settingsWrites()).toBe(before + 1);
    await commitField(
      screen,
      'settings.agents.detail.idleCompaction.cacheWindow.minutes',
      '45',
    );
    await waitForHomeGovernance(() =>
      expect(stored().window[EXTERNAL]).toBe(2_700_000),
    );
    expect(settingsWrites()).toBe(before + 2);
    // The shared duration wording, and one string per thought: Automatic carries no subtitle.
    const menuItems = screen.findAllByType(DropdownMenu)[0]!.props.items as readonly { title: string; subtitle?: string }[];
    expect(menuItems.map((item) => item.title)).toEqual(['Automatic', '5 min', '30 min', '1 h', 'Custom…']);
    expect(menuItems.every((item) => item.subtitle === undefined)).toBe(true);
    await screen.pressByTestIdAsync('settings.agents.detail.idleCompaction.when.header');
    expect(screen.getTextContent()).toContain('Any size · 45 min');
    await screen.pressByTestIdAsync('settings.agents.detail.idleCompaction.when.header');

    await chooseWindow(screen, 'automatic');
    await waitForHomeGovernance(() =>
      expect(Object.hasOwn(stored().window, EXTERNAL)).toBe(false),
    );
    expect(settingsWrites()).toBe(before + 3);
    expect(stored().enabled[EXTERNAL]).toBe(true);
  });
  it('re-renders only for its own Account keys, and opening the disclosure writes and reads nothing', async () => {
    // Keep settings Action setup outside the profiler's measured interval.
    storage.getState().applySettingsLocal({ sessionIdleCompactionEnabledByTargetKey: { [EXTERNAL]: true } });
    let commits = 0;
    const screen = await renderScreen(hostAgentRows(() => { commits += 1; }));
    // The native switch mounts through Deferred; measure after that mount, not its timer.
    await waitForHomeGovernance(() =>
      expect(screen.findHostByTestId('settings.agents.detail.idleCompaction.switch')?.props.value).toBe(true),
    );
    expect(screen.findByTestId('settings.agents.detail.idleCompaction.when')).not.toBeNull();

    // Closed, so the count is the rows' own subscription and not the open body's height settling.
    commits = 0;
    await act(async () => {
      storage.getState().applySettingsLocal({ experiments: !storage.getState().settings.experiments });
    });
    expect(commits).toBe(0);
    await act(async () => {
      storage.getState().applySettingsLocal({
        sessionIdleCompactionMinContextTokensByTargetKey: { [EXTERNAL]: 90_000 },
      });
    });
    expect(commits).toBe(1);
    expect(screen.getTextContent()).toContain('Over 90,000 tokens');

    const writes = settingsWrites();
    await screen.pressByTestIdAsync('settings.agents.detail.idleCompaction.when.header');
    expect(screen.findByTestId('settings.agents.detail.idleCompaction.minContextTokens.input')).not.toBeNull();
    expect(settingsWrites()).toBe(writes);
    expect(daemon.state.requests).toHaveLength(0);
  });


});
