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
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';

function ApprovalCommandPublication() {
  const commands = useCurrentUiContextComposedCommands();
  const enrichment = React.useMemo(() => ({ commands }), [commands]);
  usePublishCurrentUiContext(enrichment);
  return null;
}
function ApprovalCommandPage({ children }: React.PropsWithChildren) {
  return <CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
    <ApprovalCommandPublication />{children}
  </CurrentUiContextCommandsProvider>;
}

// The desktop shell is a platform boundary: it decides whether this client can open SSH itself.
const host = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform/desktopHost')>()),
  isDesktopHost: () => host.desktop,
}));

// Navigation is the app shell's boundary: the banner's way out is observed as the route it opens.
const routerPush = vi.hoisted(() => vi.fn());
installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
  },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Install configurable platform boundaries before these modules capture them.
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
const { usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
await import('./MachineAddForm');
beforeEach(async () => {
  await harness.reset();
  host.desktop = false;
  routerPush.mockClear();
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
  it('publishes the existing SSH approval opener only while the SSH pane shows it', async () => {
    host.desktop = true;
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner', session: 'terminal-test' })).toString('base64url')}.test`;
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://ssh-approval.example',
      serverIdentityId: 'srv_ssh_approval', accountId: 'owner', credentials: { token } });
    const { storage } = await import('@/sync/domains/state/storage');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scopeServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    storage.setState({ profileScope: { serverId: scopeServerId, accountId: 'owner' }, settingsScope: { serverId: scopeServerId, accountId: 'owner' } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    await harness.requireUiApproval(serverId, 'machines.add.ssh.start');
    const { MachineAddForm, MachineAddFormWithFlow } = await import('./MachineAddForm');
    const { t } = await import('@/text');
    const screen = await renderMountedCurrentUiContext(<ApprovalCommandPage><MachineAddForm layout="page" initialPath="ssh"
      testID="form" onClose={() => {}} onStartSession={() => {}} /></ApprovalCommandPage>);
    await waitForHomeGovernance(() => expect(screen.findByTestId(`${PANE}.facts`)).not.toBeNull());
    await typeHost('build-box');
    await waitForHomeGovernance(() => expect(screen.findByTestId(`${PANE}.start`)?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync(`${PANE}.start`);
    await waitForHomeGovernance(() => expect(screen.findByTestId(`${PANE}.approval`)).not.toBeNull());
    const executor = createDefaultActionExecutor();
    const readCommands = async () => {
      const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
      if (!read.ok) throw new Error('Expected SSH approval context');
      return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
    };
    const inventory = await readCommands();
    expect(inventory.map(command => command.title)).toEqual([t('approvals.details')]);
    await act(async () => { expect(await executor.execute('ui.current_context.command.invoke',
      { commandId: inventory[0]!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
    const [approval] = harness.artifacts(serverId).list();
    if (!approval) throw new Error('Expected the SSH start Ask');
    const expectedRoute = `/inbox/approvals/${encodeURIComponent(approval.id)}?serverId=${encodeURIComponent(scopeServerId)}`;
    expect(routerPush).toHaveBeenLastCalledWith(expectedRoute);
    await act(async () => screen.tree.findAllByType(AttentionBanner)
      .find(node => node.props.testID === `${PANE}.approval`)!.props.action.onPress());
    expect(routerPush).toHaveBeenLastCalledWith(expectedRoute);
    await act(async () => screen.findByType(MachineAddFormWithFlow).props.flow.choosePath('anotherComputer'));
    expect(screen.findByTestId(`${PANE}.approval`)).toBeNull();
    expect(await readCommands()).toEqual([]);
    expect(await executor.execute('ui.current_context.command.invoke', { commandId: inventory[0]!.id }, { surface: 'agent' }))
      .toMatchObject({ ok: false });
    await screen.unmount();
  });
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
    const { t } = await import('@/text');
    await waitForHomeGovernance(() => expect(byId(screen, `${PANE}.homeUnavailable`)[0]?.props.title)
      .toBe(t('addFlows.homeNeedsHttpsTitle')));
    const banner = byId(screen, `${PANE}.homeUnavailable`)[0]!.props;
    expect(banner.details).toEqual(['guest_payload_missing']);
    expect(byId(screen, `${PANE}.command`)).toHaveLength(0);
    // The notice leads to its remedy: the Home's address, and (over SSH) pairing as Another machine.
    await act(async () => banner.action.onPress());
    // The adopted descriptor keys this Home by its identity: the reach page opens for that Home.
    expect(routerPush).toHaveBeenCalledWith(`/settings/home/${serverIdentityId}/reach`);
    if (initialPath === 'ssh') {
      await act(async () => banner.secondaryAction.onPress());
      await waitForHomeGovernance(() => expect(byId(screen, `${PANE}.pairing-steps`).length).toBeGreaterThan(0));
    } else expect(banner.secondaryAction ?? null).toBeNull();
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

    // The page header names the pushed way and shows the lead its pane decides (p5-pair: title, then lead).
    const published: Array<string | null> = [];
    const pageLead = { publish: (lead: string | null) => { published.push(lead); } };
    const pushed = await renderScreen(
      <MachineAddForm
        layout="page"
        canCreate
        openedWay="ssh"
        pageLead={pageLead}
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
    const lead = published.at(-1);
    expect([t('addFlows.sshLeadCommand', { home: 'Build' }), t('addFlows.sshLeadTask', { home: 'Build' })]).toContain(lead);
    expect(pushed.tree.findAll((node) => node.props.children === lead)).toHaveLength(0);
    expect(byId(pushed, 'form.way.create')).toHaveLength(0);
    expect(byId(pushed, 'managed-picker')).toHaveLength(0);
    await pushed.unmount();
    // Leaving the way clears the header's description.
    expect(published.at(-1)).toBeNull();
  });
});
