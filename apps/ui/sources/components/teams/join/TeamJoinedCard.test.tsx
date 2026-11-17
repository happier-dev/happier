import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import 'fake-indexeddb/auto';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  resetRuntimeFetch,
  setRuntimeFetch,
} from '@/utils/system/runtimeFetch';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
  createAccountFeaturesResponse,
  getRequestUrl,
  isFeaturesRequest,
} from '@/__tests__/routes/(app)/settings/account.testHelpers';
import { installAccountSettingsRouteModuleMocks } from '@/__tests__/routes/(app)/settings/accountSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock();
});
// The Account's real save path runs below this card: the Action front door, the
// scope lifetime and the profile store. Only the Home's HTTP answer is scripted.
installAccountSettingsRouteModuleMocks({
  storageModule: (importOriginal) => importOriginal(),
});
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
const { storage } = await import('@/sync/domains/state/storageStore');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { createSecretSettingsTestHarness } =
  await import('@/components/settings/secrets/secretSettingsTestHarness');
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock(
  '@more-tech/react-native-libsodium',
  () => import('libsodium-wrappers'),
);
vi.mock(
  '@/platform/cryptoRandom',
  () => import('@/platform/cryptoRandom.node'),
);
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
await loadSyncSingletonForTests();

const { TeamJoinedCard } = await import('./TeamJoinedCard');

let account:
  | Awaited<ReturnType<typeof createSecretSettingsTestHarness>>
  | undefined;
let restoreExecutor: (() => void) | undefined;
let replacement: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

type Home = { nameRequests: unknown[]; failName: boolean };
type Events = string[];

function installHome(home: Home, events: Events) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = getRequestUrl(input);
      const path = new URL(url).pathname;
      if (url.endsWith('/health') || url.endsWith('/v1/auth/ping'))
        return Response.json({});
      if (isFeaturesRequest(url))
        return Response.json(createAccountFeaturesResponse());
      if (path === '/v1/account/profile' && init?.method === 'POST') {
        const body: unknown = JSON.parse(String(init.body));
        home.nameRequests.push(body);
        events.push('save');
        if (home.failName)
          return Response.json({ error: 'unavailable' }, { status: 503 });
        const name =
          body && typeof body === 'object' ? Reflect.get(body, 'name') : null;
        return Response.json({
          name,
          firstName: name,
          lastName: null,
          timestamp: Date.now(),
        });
      }
      return account!.request(input, init);
    },
  );
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  setRuntimeFetch(fetchMock as unknown as typeof fetch);
}

async function renderJoined(
  params: Readonly<{
    outcome: 'joined' | 'already_member';
    name: string | null;
    username?: string | null;
    home: Home;
    askFirst?: boolean;
    setupContinuation?: Readonly<{ label: string; onContinue: () => Promise<void> | void }>;
  }>,
) {
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  account = await createSecretSettingsTestHarness({
    features: createAccountFeaturesResponse(),
    ...(params.askFirst ? { settings: settingsParse({ actionsSettingsV1: {
      v: 1, actions: { 'account.name.set': { approvalRequiredSurfaces: ['ui'] } },
    } }) } : {}),
  });
  restoreExecutor = await installRealActionExecutorModuleLoader();
  storage.setState({ isDataReady: true, profileScope: account.scope });
  storage.getState().applyProfile({
    ...profileDefaults,
    id: account.scope.accountId,
    linkedProviders: [],
    name: params.name,
    username: params.username ?? null,
  });
  const events: Events = [];
  installHome(params.home, events);
  const onOpenTeam = vi.fn(async () => {
    events.push('open');
  });
  const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
  const renderCard = (credentials: AuthCredentials) => (
    <InjectedAuthProvider credentials={credentials}>
      <TeamJoinedCard
        {...(params.setupContinuation ? { setupContinuation: params.setupContinuation } : {})}
        testID="joined"
        result={{ outcome: params.outcome, teamId: 'team-1' }}
        teamName="Product Reliability"
        accountScope={account!.scope}
        onOpenTeam={onOpenTeam}
      />
    </InjectedAuthProvider>
  );
  const screen = await renderScreen(renderCard(account.credentials));
  return { screen, onOpenTeam, events, renderCard };
}

describe('TeamJoinedCard', () => {
  afterEach(async () => {
    await standardCleanup();
    await replacement?.dispose();
    replacement = undefined;
    await account?.dispose();
    account = undefined;
    restoreExecutor?.();
    restoreExecutor = undefined;
    resetRuntimeFetch();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('asks an unnamed Account for its name, even with a username, and saves it before opening the Team', async () => {
    const home: Home = { nameRequests: [], failName: false };
    const { screen, onOpenTeam, events } = await renderJoined({
      outcome: 'joined',
      name: null,
      username: 'ada',
      home,
    });

    const field = screen.findByTestId('joined-name-field');
    expect(field).not.toBeNull();
    expect(screen.getTextContent()).toContain('teams.join.nameStepReason');
    await act(async () => {
      field!.props.onChangeText('  Ada Lovelace ');
    });
    await screen.pressByTestIdAsync('joined-action');

    await vi.waitFor(() => expect(onOpenTeam).toHaveBeenCalledOnce());
    expect(home.nameRequests).toEqual([{ name: 'Ada Lovelace' }]);
    expect(events).toEqual(['save', 'open']);
    expect(storage.getState().profile.name).toBe('Ada Lovelace');
    expect((await import('@/modal')).Modal.confirm).not.toHaveBeenCalled();
  }, 40_000);

  it('opens without saving when the field is left empty', async () => {
    const home: Home = { nameRequests: [], failName: false };
    const { screen, onOpenTeam } = await renderJoined({
      outcome: 'joined',
      name: null,
      home,
    });

    expect(screen.findByTestId('joined-name-field')).not.toBeNull();
    await screen.pressByTestIdAsync('joined-action');

    await vi.waitFor(() => expect(onOpenTeam).toHaveBeenCalledOnce());
    expect(home.nameRequests).toEqual([]);
  }, 40_000);

  it.each([['Account', 'ada'], ['Home', 'ada'], ['Account', null]] as const)('retains the admitted Account draft after another %s becomes active (username %s), without writing to the replacement', async (changed, username) => {
    const home: Home = { nameRequests: [], failName: false };
    const { screen, onOpenTeam, events, renderCard } = await renderJoined({ outcome: 'joined', name: null, username, home });
    await act(async () => { screen.findByTestId('joined-name-field')!.props.onChangeText('Ada'); });
    const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const server = getServerProfileById(account!.scope.serverId)!;
    const accountId = changed === 'Account' ? 'account-b' : account!.scope.accountId;
    await act(async () => {
      replacement = await restoreServerAccountForTest({
        serverUrl: changed === 'Home' ? 'https://replacement-home.example.test' : server.serverUrl,
        serverIdentityId: changed === 'Home' ? 'srv_replacement_home' : server.serverIdentityId ?? undefined,
        accountId, activation: 'switch',
        request: (input, init) => account!.request(input, init) });
      storage.setState({ isDataReady: true, profileScope: { serverId: replacement.serverId, accountId } });
      installHome(home, events);
    });
    await screen.update(renderCard(replacement!.credentials));
    // Activating another Home starts that Account's profile from defaults; its name is then the replacement's own.
    await act(async () => { storage.getState().applyProfile({ ...profileDefaults, id: accountId, name: 'Grace' }); });
    const { getCurrentAuth } = await import('@/auth/context/currentAuth');
    const { parseToken } = await import('@/utils/auth/parseToken');
    expect(parseToken(getCurrentAuth()!.credentials!.token)).toBe(accountId);
    await screen.pressByTestIdAsync('joined-action');
    await vi.waitFor(() => expect(screen.findByTestId('joined-name-field.error')).not.toBeNull());
    // The refusal says what happened and where to go back to (name, else username), not a retryable failure.
    expect(screen.getTextContent()).toContain(username ? 'teams.join.nameAccountSwitched(account=ada)' : 'teams.join.nameAccountSwitchedUnnamed');
    expect(screen.getTextContent()).not.toContain('settingsAccount.nameSaveFailed');
    expect(home.nameRequests).toEqual([]);
    expect(storage.getState().profile).toMatchObject({ id: accountId, name: 'Grace' });
    expect(screen.findByTestId('joined-name-field')?.props.value).toBe('Ada');
    expect(onOpenTeam).not.toHaveBeenCalled();
    await act(async () => { screen.findByTestId('joined-name-field')!.props.onChangeText(''); });
    await screen.pressByTestIdAsync('joined-action');
    await vi.waitFor(() => expect(onOpenTeam).toHaveBeenCalledOnce());
  }, 40_000);

  // docs/actions.md: saved Ask-on-UI uses the Action owner's native confirmation;
  // the person's own name save never creates an Inbox approval Artifact.
  it.each([
    [true, false], [false, false], [true, true], [false, true],
  ] as const)('keeps the name save pending for native confirmation (approved %s, setup %s)', async (approved, setup) => {
    const home: Home = { nameRequests: [], failName: false };
    const onSetup = vi.fn();
    const { screen, onOpenTeam, events } = await renderJoined({ outcome: 'joined', name: null, home, askFirst: true,
      ...(setup ? { setupContinuation: { label: 'Set up for Product Reliability', onContinue: onSetup } } : {}),
    });
    const { Modal } = await import('@/modal');
    let decide!: (approved: boolean) => void;
    vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise<boolean>(resolve => { decide = resolve; }));
    await act(async () => { screen.findByTestId('joined-name-field')!.props.onChangeText('Ada'); });
    await screen.pressByTestIdAsync('joined-action');
    await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledOnce());
    expect(screen.findByTestId('joined-name-field.error')).toBeNull();
    expect(home.nameRequests).toEqual([]);
    expect(onOpenTeam).not.toHaveBeenCalled();
    expect(onSetup).not.toHaveBeenCalled();
    expect(account!.artifacts.list()).toEqual([]);
    await act(async () => { decide(approved); });
    if (approved) {
      await vi.waitFor(() => expect(setup ? onSetup : onOpenTeam).toHaveBeenCalledOnce());
      expect(setup ? onOpenTeam : onSetup).not.toHaveBeenCalled();
      expect(home.nameRequests).toEqual([{ name: 'Ada' }]);
      expect(storage.getState().profile.name).toBe('Ada');
      expect(events).toEqual(setup ? ['save'] : ['save', 'open']);
    } else {
      await vi.waitFor(() => expect(screen.findByTestId('joined-name-field.error')).not.toBeNull());
      expect(home.nameRequests).toEqual([]);
      expect(onOpenTeam).not.toHaveBeenCalled();
      expect(onSetup).not.toHaveBeenCalled();
      expect(screen.findByTestId('joined-name-field')?.props.value).toBe('Ada');
      // Clearing the optional name skips its confirmation and keeps the same destination.
      await act(async () => { screen.findByTestId('joined-name-field')!.props.onChangeText(''); });
      await screen.pressByTestIdAsync('joined-action');
      await vi.waitFor(() => expect(setup ? onSetup : onOpenTeam).toHaveBeenCalledOnce());
      expect(home.nameRequests).toEqual([]);
      expect(Modal.confirm).toHaveBeenCalledOnce();
    }
    expect(account!.artifacts.list()).toEqual([]);
  }, 40_000);

  it('does not save or continue when the joined card retires during native confirmation', async () => {
    const home: Home = { nameRequests: [], failName: false };
    const { screen, onOpenTeam } = await renderJoined({ outcome: 'joined', name: null, home, askFirst: true });
    const { Modal } = await import('@/modal');
    let decide!: (approved: boolean) => void;
    vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise<boolean>(resolve => { decide = resolve; }));
    await act(async () => { screen.findByTestId('joined-name-field')!.props.onChangeText('Ada'); });
    await screen.pressByTestIdAsync('joined-action');
    await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledOnce());
    await screen.unmount();
    await act(async () => { decide(true); });
    expect(home.nameRequests).toEqual([]);
    expect(onOpenTeam).not.toHaveBeenCalled();
    expect(storage.getState().profile.name).toBeNull();
    expect(account!.artifacts.list()).toEqual([]);
  }, 40_000);

  it('stays on the card with the failure under the field, retries on the next press, and opens unsaved once cleared', async () => {
    const home: Home = { nameRequests: [], failName: true };
    const { screen, onOpenTeam } = await renderJoined({
      outcome: 'joined',
      name: null,
      home,
      askFirst: true,
    });

    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await act(async () => {
      screen.findByTestId('joined-name-field')!.props.onChangeText('Ada');
    });
    await screen.pressByTestIdAsync('joined-action');
    await vi.waitFor(() =>
      expect(screen.findByTestId('joined-name-field.error')).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain('settingsAccount.nameSaveFailed');
    expect(screen.findByTestId('joined-name-field')?.props.value).toBe('Ada');
    expect(onOpenTeam).not.toHaveBeenCalled();

    await screen.pressByTestIdAsync('joined-action');
    await vi.waitFor(() => expect(home.nameRequests).toHaveLength(2));
    expect(onOpenTeam).not.toHaveBeenCalled();

    await act(async () => {
      screen.findByTestId('joined-name-field')!.props.onChangeText('');
    });
    await screen.pressByTestIdAsync('joined-action');
    await vi.waitFor(() => expect(onOpenTeam).toHaveBeenCalledOnce());
    expect(home.nameRequests).toHaveLength(2);
  }, 40_000);

  it.each([
    ['an Account that already has a name', 'joined', 'Ada Lovelace'],
    ['an Account that was already a member', 'already_member', null],
  ] as const)(
    'never asks %s',
    async (_label, outcome, name) => {
      const home: Home = { nameRequests: [], failName: false };
      const { screen, onOpenTeam } = await renderJoined({
        outcome,
        name,
        home,
      });

      expect(screen.findByTestId('joined-name-field')).toBeNull();
      expect(screen.getTextContent()).not.toContain(
        'teams.join.nameStepReason',
      );
      await screen.pressByTestIdAsync('joined-action');
      await vi.waitFor(() => expect(onOpenTeam).toHaveBeenCalledOnce());
      expect(home.nameRequests).toEqual([]);
    },
    40_000,
  );
});
