import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, standardCleanup } from '@/dev/testkit';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createHydratedPlainMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  configureConnectedServerSocketBoundary,
  installDisconnectedServerSocketBoundary,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { NewAppCodeSources } = await import('./NewAppCodeSources');
const { storage } = await import('@/sync/domains/state/storage');
afterEach(async () => {
  await standardCleanup();
  await homes.reset();
});

// The step owns the one search (NewAppScreen); this host holds it the same way.
function SearchHost(props: Omit<React.ComponentProps<typeof NewAppCodeSources>, 'query' | 'onQueryChange'>) {
  const [query, setQuery] = React.useState('');
  return <NewAppCodeSources {...props} query={query} onQueryChange={setQuery} />;
}

const github = {
  id: 'happier.scm.forge.github/github',
  kind: 'github' as const,
  displayName: 'GitHub',
  baseUrl: 'https://github.com',
};
const selectorFor = (nameWithOwner: string) => ({
  provider: github,
  repository: { nameWithOwner },
  protocol: 'https' as const,
});

// Deploy an app → Your code (owner ruling 20:50Z): paste a link, read by a Machine's hosting owner, or search the
// Account's repository Projects. A link to a Project already here picks it; any other repository is offered to open.
it.each([
  ['https://github.com/acme/invoices', 'picks'],
  ['https://github.com/acme/ops-tools', 'offers'],
] as const)('a pasted link %s %s', async (address, outcome) => {
  const serverId = await homes.addHome({
    name: 'Deploy',
    serverUrl: 'https://deploy-your-code-link.test',
    serverIdentityId: `srv_${'e'.repeat(32)}`,
    accountId: 'account-owner',
    currentAccount: true,
  });
  homes.answer(serverId, 'GET /v1/projects/sources', {
    body: {
      ok: true,
      sources: [
        {
          id: 'source-invoices',
          revision: 2,
          name: 'invoices',
          defaultRef: 'main',
          audience: [],
          createdByAccountId: 'account-owner',
          repository: {
            ...selectorFor('acme/invoices'),
            repository: {
              nameWithOwner: 'acme/invoices',
              cloneUrl: 'https://github.com/acme/invoices.git',
            },
          },
        },
      ],
      coverage: { complete: true, nextCursor: null },
    },
  });
  // One online Machine, and the Home's Machine list read has completed, so the address owner can ask it.
  // The Action root discovers the Machine's custody before it uses the own-Machine RPC path.
  const { createPlainMachineRowFixture } = await import('@/dev/testkit');
  const machineRow = createPlainMachineRowFixture({ id: 'reader', accountId: 'account-owner' });
  homes.answer(serverId, '/v1/machines', { body: [machineRow] });
  homes.answer(serverId, 'GET /v1/machines/reader', { body: { machine: machineRow } });
  storage
    .getState()
    .applyMachines(
      [createHydratedPlainMachineFixture({ id: 'reader', accountId: 'account-owner', machine: { active: true, activeAt: Date.now() } })],
      true,
      { sourceServerId: serverId },
    );
  storage.getState().markMachineListSettled(serverId);
  const asked: unknown[] = [];
  installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(
      async (event: string, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL)
          return { v: 1, ok: true, admittedSessionIds: [] };
        const call = payload as { method: string; params: { address: string } };
        asked.push(call.params);
        expect(call.method).toBe('reader:scm.hostingRepository.resolveAddress');
        return {
          ok: true,
          result: {
            success: true,
            kind: 'resolved',
            selector: selectorFor(
              call.params.address.replace('https://github.com/', ''),
            ),
          },
        };
      },
    );
  });
  const onChange = vi.fn();
  const onChooseRepository = vi.fn();
  const scope = { serverId, accountId: 'account-owner' };
  const screen = await renderAccountScreen(
    <SearchHost
      scope={scope}
      value={null}
      onChange={onChange}
      onChooseRepository={onChooseRepository}
      chosenRepository={null}
      columns={2}
      insetStyle={null}
    />,
  );
  try {
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('newApp.code:source-invoices')).toBeTruthy(),
    );
    const field = () =>
      screen.root.findAll(
        (node) =>
          node.props.testID === 'newApp.code.address' &&
          typeof node.props.onChangeText === 'function',
      )[0]!;
    await act(async () => {
      field().props.onChangeText(address);
    });
    await act(async () => {
      field().props.onSubmitEditing();
    });
    await waitForHomeGovernance(() =>
      expect(
        onChange.mock.calls.length + onChooseRepository.mock.calls.length,
        `${screen.getTextContent()} | asked ${JSON.stringify(asked)} | error ${String(field().props.error)} | inventory ${JSON.stringify(storage.getState().machineListStatusByServerId)}`,
      ).toBe(1),
    );
    if (outcome === 'picks')
      expect(onChange).toHaveBeenCalledWith('source-invoices');
    else
      expect(onChooseRepository).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: { nameWithOwner: 'acme/ops-tools' },
        }),
      );
  } finally {
    await screen.unmount();
  }
});

it('narrows Your code to the repositories a search names, without asking any Machine', async () => {
  const serverId = await homes.addHome({
    name: 'Deploy',
    serverUrl: 'https://deploy-your-code-search.test',
    serverIdentityId: `srv_${'f'.repeat(32)}`,
    accountId: 'account-owner',
    currentAccount: true,
  });
  homes.answer(serverId, 'GET /v1/projects/sources', {
    body: {
      ok: true,
      sources: ['invoices', 'billing-api', 'docs'].map((name) => ({
        id: `source-${name}`,
        revision: 1,
        name,
        defaultRef: 'main',
        audience: [],
        createdByAccountId: 'account-owner',
        repository: {
          ...selectorFor(`acme/${name}`),
          repository: {
            nameWithOwner: `acme/${name}`,
            cloneUrl: `https://github.com/acme/${name}.git`,
          },
        },
      })),
      coverage: { complete: true, nextCursor: null },
    },
  });
  const scope = { serverId, accountId: 'account-owner' };
  const screen = await renderAccountScreen(
    <SearchHost
      scope={scope}
      value={null}
      onChange={vi.fn()}
      onChooseRepository={vi.fn()}
      chosenRepository={null}
      columns={2}
      insetStyle={null}
    />,
  );
  try {
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('newApp.code:source-docs')).toBeTruthy(),
    );
    const field = screen.root.findAll(
      (node) =>
        node.props.testID === 'newApp.code.address' &&
        typeof node.props.onChangeText === 'function',
    )[0]!;
    await act(async () => {
      field.props.onChangeText('bill');
    });
    expect(screen.findByTestId('newApp.code:source-billing-api')).toBeTruthy();
    expect(screen.findByTestId('newApp.code:source-invoices')).toBeNull();
    expect(screen.findByTestId('newApp.code:source-docs')).toBeNull();
  } finally {
    await screen.unmount();
  }
});
