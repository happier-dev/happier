import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

// The desktop shell is a platform boundary: it decides whether this client can open SSH itself.
const host = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform/desktopHost')>()),
  isDesktopHost: () => host.desktop,
}));

installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await import('./MachineAddForm');
beforeEach(async () => {
  await harness.reset();
  host.desktop = false;
});
afterEach(async () => {
  const { discardMachineAdd } = await import('./useMachineAddFlow');
  await act(async () => discardMachineAdd());
  vi.restoreAllMocks();
  standardCleanup();
});

const PANE = 'form.pane';
const byId = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) =>
  screen.tree.findAll((node) => node.props.testID === id);

async function renderSsh() {
  await harness.addHome({
    name: 'Build',
    serverUrl: 'https://ssh-pane.example',
    serverIdentityId: 'srv_ssh_pane',
    accountId: 'owner',
  });
  const { MachineAddForm } = await import('./MachineAddForm');
  const screen = await renderScreen(
    <MachineAddForm
      layout="page"
      initialPath="ssh"
      testID="form"
      onClose={() => {}}
      onStartSession={() => {}}
    />,
  );
  await waitForHomeGovernance(() =>
    expect(
      byId(screen, `${PANE}.ssh-sshHostInput`).length +
        byId(screen, `${PANE}.facts`).length,
    ).toBeGreaterThan(0),
  );
  return screen;
}

async function typeHost(name: string) {
  const { updateMachineAddFlowDraft } = await import('./machineAddFlowStore');
  await act(async () =>
    updateMachineAddFlowDraft((draft) => ({
      ...draft,
      sshDraft: { ...draft.sshDraft, host: name, username: 'deploy' },
    })),
  );
  await flushHookEffects({ cycles: 5 });
}

describe('Over SSH', () => {
  it.each(['thisComputer', 'ssh', 'anotherComputer'] as const)('names the Home payload refusal in Details for browser %s', async initialPath => {
    const serverId = await harness.addHome({ name: 'Source Home', serverUrl: 'https://source-home.example.test',
      serverIdentityId: 'srv_source_home', accountId: 'owner' });
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    await upsertServerProfile({ serverUrl: 'https://source-home.example.test', name: 'Source Home', source: 'stack-env' });
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const features = createRootLayoutFeaturesResponse({ capabilities: { guestCli: { source: 'home-payload', line: '0.3', channel: 'publicdev' } } });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    harness.answer(serverId, '/v1/features', { body: features });
    harness.answer(serverId, '/v1/features/authenticated', { body: features });
    const { MachineAddForm } = await import('./MachineAddForm');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <MachineAddForm layout="page" initialPath={initialPath} testID="form"
        onClose={() => {}} onStartSession={() => {}} />
    </InjectedAuthProvider>);
    if (initialPath === 'anotherComputer') {
      await waitForHomeGovernance(() => expect(byId(screen, `${PANE}.terminal`).length).toBeGreaterThan(0));
      await act(async () => screen.pressByTestId(`${PANE}.terminal`));
    }
    await waitForHomeGovernance(() => expect(byId(screen, `${PANE}.homeUnavailable`)[0]?.props.details).toEqual(['guest_payload_missing']));
    expect(byId(screen, `${PANE}.command`)).toHaveLength(0);
    await screen.unmount();
  });
  it.each(['anotherComputer', 'ssh'] as const)('explains a controller-only Home before offering the %s journey', async initialPath => {
    await harness.addHome({ name: 'Local Home', serverUrl: 'http://happier-agent-qa-unified-work-dev.localhost:3009',
      serverIdentityId: 'srv_local_home', accountId: 'owner' });
    const { MachineAddForm } = await import('./MachineAddForm');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <MachineAddForm layout="page" initialPath={initialPath} testID="form"
        onClose={() => {}} onStartSession={() => {}} />
    </InjectedAuthProvider>);
    await waitForHomeGovernance(() => expect(byId(screen, `${PANE}.homeUnavailable`).length).toBeGreaterThan(0));
    expect(byId(screen, `${PANE}.command`)).toHaveLength(0);
    expect(byId(screen, `${PANE}.start`)).toHaveLength(0);
    expect(byId(screen, `${PANE}.pairing-steps`)).toHaveLength(0);
    await screen.unmount();
  });
  it.each(['anotherComputer', 'ssh'] as const)('explains the missing remote archive route in the %s journey', async initialPath => {
    const serverUrl = 'http://source-home.localhost:3039';
    const serverIdentityId = 'srv_source_home';
    const serverId = await harness.addHome({ name: 'Source Home', serverUrl, serverIdentityId, accountId: 'owner' });
    const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
    await adoptHomeProfile({ source: 'manual', descriptor: { v: 1, homeServerIdentityId: serverIdentityId, canonicalServerUrl: serverUrl,
      revision: 1, endpoints: [{ kind: 'https', url: serverUrl }, { kind: 'iroh', endpointId: 'a'.repeat(64) }] } });
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const features = createRootLayoutFeaturesResponse({ capabilities: { guestCli: { source: 'home-payload', line: '0.3', channel: 'publicdev',
      payloads: [{ target: { os: 'linux', arch: 'x64' }, sha256: '4b'.repeat(32), url: '/v1/runtime/guest-cli/payloads/linux/x64' }] } } });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    harness.answer(serverId, '/v1/features', { body: features });
    harness.answer(serverId, '/v1/features/authenticated', { body: features });
    const { MachineAddForm } = await import('./MachineAddForm');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <MachineAddForm layout="page" initialPath={initialPath} testID="form" onClose={() => {}} onStartSession={() => {}} />
    </InjectedAuthProvider>);
    if (initialPath === 'anotherComputer') {
      await waitForHomeGovernance(() => expect(byId(screen, `${PANE}.terminal`).length).toBeGreaterThan(0));
      expect(byId(screen, `${PANE}.pairing-steps`).length).toBeGreaterThan(0);
      await act(async () => screen.pressByTestId(`${PANE}.terminal`));
    }
    await waitForHomeGovernance(() => expect(byId(screen, `${PANE}.homeUnavailable`)[0]?.props.title)
      .toBe('This Home serves its CLI only over an HTTPS address other machines can reach. Add one to this Home, or install this machine over SSH from a connected controller.'));
    expect(byId(screen, `${PANE}.homeUnavailable`)[0]?.props.details).toEqual(['guest_payload_missing']);
    expect(byId(screen, `${PANE}.command`)).toHaveLength(0);
    await screen.unmount();
  });
  it('in the app, connects and installs directly, names where it connects from and what runs on the server, and keeps the command as a fallback', async () => {
    host.desktop = true;
    const screen = await renderSsh();
    // The client runs SSH itself: the direct path leads, the command is not on screen yet.
    expect(byId(screen, `${PANE}.start`).length).toBeGreaterThan(0);
    expect(byId(screen, `${PANE}.command`)).toHaveLength(0);
    // An empty address says why Connect and install can't run.
    expect(byId(screen, `${PANE}.startReason`).length).toBeGreaterThan(0);
    expect(byId(screen, `${PANE}.facts.connectFrom`).length).toBeGreaterThan(0);
    expect(byId(screen, `${PANE}.facts.runsAs`).length).toBeGreaterThan(0);
    expect(byId(screen, `${PANE}.facts.separateUsers`).length).toBeGreaterThan(
      0,
    );
    await typeHost('build-box');
    expect(byId(screen, `${PANE}.startReason`)).toHaveLength(0);
    // Run it yourself reveals the same Action's command, without leaving the direct path.
    await act(async () => screen.pressByTestId(`${PANE}.runYourself`));
    await flushHookEffects({ cycles: 5 });
    expect(byId(screen, `${PANE}.command`).length).toBeGreaterThan(0);
    expect(byId(screen, `${PANE}.start`).length).toBeGreaterThan(0);
    await screen.unmount();
  });

  it('in a browser, the command is the path: no Connect from and no direct connect', async () => {
    const screen = await renderSsh();
    expect(byId(screen, `${PANE}.start`)).toHaveLength(0);
    expect(byId(screen, `${PANE}.runYourself`)).toHaveLength(0);
    expect(byId(screen, `${PANE}.facts.connectFrom`)).toHaveLength(0);
    expect(byId(screen, `${PANE}.facts.runsAs`).length).toBeGreaterThan(0);
    await typeHost('build-box');
    expect(byId(screen, `${PANE}.command`).length).toBeGreaterThan(0);
    await screen.unmount();
  });
});

describe('Add a machine on a phone', () => {
  it('lists the ways in and pushes the chosen one; the pushed page shows only that way', async () => {
    vi.spyOn((await import('react-native')).Dimensions, 'get').mockReturnValue({
      width: 390,
      height: 844,
      scale: 1,
      fontScale: 1,
    });
    await harness.addHome({
      name: 'Build',
      serverUrl: 'https://build-phone.example',
      serverIdentityId: 'srv_build_phone',
      accountId: 'owner',
    });
    const { MachineAddForm } = await import('./MachineAddForm');
    const { readMachineAddFlowDraft } = await import('./machineAddFlowStore');
    const opened: string[] = [];
    const list = await renderScreen(
      <MachineAddForm
        layout="page"
        canCreate
        testID="form"
        onOpenWay={(way) => opened.push(way)}
        onClose={() => {}}
        onStartSession={() => {}}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(byId(list, 'form.way.create').length).toBeGreaterThan(0),
    );
    // Lab and spec order: the connection ways first, Create one last.
    const wayIds = list.tree.findAll((node) => typeof node.props.testID === 'string' && /^form\.way\.[A-Za-z]+$/.test(node.props.testID))
      .map((node) => node.props.testID as string).filter((id, index, all) => all.indexOf(id) === index);
    expect(wayIds.at(-1)).toBe('form.way.create');
    // The list carries no pane under it: nothing is stacked.
    expect(byId(list, 'managed-picker')).toHaveLength(0);
    expect(byId(list, `${PANE}.ssh-sshHostInput`)).toHaveLength(0);
    await act(async () => list.pressByTestId('form.way.create'));
    expect(opened).toEqual(['create']);
    expect(readMachineAddFlowDraft().creating).toBe(true);
    await act(async () => list.pressByTestId('form.way.ssh'));
    expect(opened).toEqual(['create', 'ssh']);
    expect(readMachineAddFlowDraft().path).toBe('ssh');
    expect(readMachineAddFlowDraft().creating).toBe(false);
    await list.unmount();

    const pushed = await renderScreen(
      <MachineAddForm
        layout="page"
        canCreate
        openedWay="ssh"
        testID="form"
        onOpenWay={() => {}}
        onClose={() => {}}
        onStartSession={() => {}}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(byId(pushed, `${PANE}.facts`).length).toBeGreaterThan(0),
    );
    const { t } = await import('@/text');
    expect(pushed.tree.findAll((node) => node.props.accessibilityRole === 'header' && node.props.children === t('addFlows.pathSshTitle'))).toHaveLength(0);
    expect(byId(pushed, 'form.way.create')).toHaveLength(0);
    expect(byId(pushed, 'managed-picker')).toHaveLength(0);
    await pushed.unmount();
  });
});
