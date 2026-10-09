import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Action front door is this screen's boundary: Source reads and writes are Actions whose host
 * (membership, revision CAS, storage) lives outside the page. The fake records each call and answers
 * the catalog; the screen, its controller, the address parser and the editor below it are real.
 */
const shared = vi.hoisted(() => ({
  calls: [] as Array<{ actionId: string; input: any }>,
  sources: [] as unknown[],
  routes: { params: {} as Record<string, string> },
  navigation: [] as unknown[],
  createOutcomes: [] as Array<'unknown'>,
  artifacts: {} as Record<string, unknown>,
}));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
  createFrontDoorActionExecute: () => async (actionId: string, input: any) => {
    shared.calls.push({ actionId, input });
    if (actionId === 'projects.sources.list')
      return {
        ok: true,
        result: {
          ok: true,
          sources: shared.sources,
          coverage: { complete: true, nextCursor: null },
        },
      };
    if (actionId === 'projects.sources.read') {
      const source = shared.sources.find(
        (row: any) => row.id === input.sourceId,
      );
      return {
        ok: true,
        result: source
          ? { ok: true, source, canManage: true }
          : { ok: false, error: 'source_unavailable' },
      };
    }
    if (actionId === 'scm.hostingRepository.resolveAddress')
      return {
        ok: true,
        result: {
          success: true,
          kind: 'resolved',
          selector: {
            provider: {
              id: 'happier.scm.forge.github/github',
              kind: 'github',
              displayName: 'GitHub',
              baseUrl: 'https://github.com',
            },
            repository: { nameWithOwner: 'acme/billing' },
            protocol: 'https',
          },
        },
      };
    if (actionId === 'projects.sources.create' && shared.createOutcomes.shift() === 'unknown')
      return { ok: false, errorCode: 'outcome_unknown' };
    if (actionId === 'projects.sources.create') {
      // The real create answers the canonical Source row, never the request's idempotency key.
      const { serverId: _serverId, requestKey: _requestKey, ...fields } = input;
      const source = {
        id: 'created',
        revision: 1,
        audience: [],
        createdByAccountId: 'account-1',
        ...fields,
      };
      shared.sources = [...shared.sources, source];
      return { ok: true, result: { ok: true, source, canManage: true } };
    }
    return { ok: true, result: {} };
  },
}));

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    params: () => shared.routes.params,
    router: {
      push: (value: unknown) => {
        shared.navigation.push(value);
      },
      replace: (value: unknown) => {
        shared.navigation.push(value);
      },
    },
  }).module;
});

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({}).module;
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

const { ProjectSourcesScreen } = await import('./ProjectSourcesScreen');
const { storage } = await import('@/sync/domains/state/storageStore');
const previous = storage.getState();

afterEach(() => {
  standardCleanup();
  storage.setState(previous);
  shared.calls = [];
  shared.sources = [];
  shared.navigation = [];
  shared.routes.params = {};
  shared.createOutcomes = [];
});

function signIn() {
  storage.setState({
    profileScope: { serverId: 'server-1', accountId: 'account-1' },
    // A Machine on this Home answers the address check (the resolver runs where Git runs); the inventory
    // is this Home's settled list, never another Home's.
    machineListByServerId: {
      'server-1': [{ id: 'm1', active: true, activeAt: Date.now(), createdAt: 1, metadata: { host: 'devbox', displayName: 'devbox' } }],
    } as never,
    machineListStatusByServerId: { 'server-1': 'idle' },
  });
}

describe('Projects › Sources', () => {
  it('invites the first Source when the authenticated catalog is empty, and Add opens the draft', async () => {
    signIn();
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.empty')).toBeTruthy(),
    );
    await act(async () => {
      screen.pressByTestId('projects.sources.empty.add');
    });
    expect(shared.navigation).toContainEqual('/projects/sources?source=new');
  });

  it('saves a new Source from a typed address through the one create Action and selects it', async () => {
    signIn();
    shared.sources = [
      {
        id: 'existing',
        revision: 1,
        name: 'website',
        audience: [],
        createdByAccountId: 'account-1',
        repository: {
          provider: {
            id: 'happier.scm.forge.github/github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
          },
          repository: { nameWithOwner: 'happier-dev/website' },
          protocol: 'https',
        },
      },
    ];
    shared.routes.params = { source: 'new' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('projects.sources.detail.address.field'),
      ).toBeTruthy(),
    );
    const field = screen.findByTestId('projects.sources.detail.address.field')!;
    await act(async () => {
      field.props.onChangeText?.('github.com/acme/billing');
    });
    await act(async () => {
      field.props.onBlur?.();
      field.props.onSubmitEditing?.();
    });
    await vi.waitFor(() =>
      expect(
        shared.calls.some((call) => call.actionId === 'scm.hostingRepository.resolveAddress'),
      ).toBe(true),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.save');
    });
    const create = shared.calls.find(
      (call) => call.actionId === 'projects.sources.create',
    );
    expect(create?.input).toMatchObject({
      serverId: 'server-1',
      name: 'billing',
      audience: [],
      repository: {
        repository: { nameWithOwner: 'acme/billing' },
        protocol: 'https',
      },
    });
    expect(shared.navigation).toContainEqual(
      '/projects/sources?source=created',
    );
  });

  it('recovers an unconfirmed create only after a complete inspection, retrying the same request', async () => {
    signIn();
    shared.createOutcomes = ['unknown'];
    shared.routes.params = { source: 'new' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.detail.address.field')).toBeTruthy(),
    );
    const field = screen.findByTestId('projects.sources.detail.address.field')!;
    await act(async () => {
      field.props.onChangeText?.('github.com/acme/billing');
    });
    await act(async () => {
      field.props.onBlur?.();
      field.props.onSubmitEditing?.();
    });
    await vi.waitFor(() =>
      expect(shared.calls.some((call) => call.actionId === 'scm.hostingRepository.resolveAddress')).toBe(true),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.save');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.detail.outcomeUnknown')).toBeTruthy(),
    );
    // Save cannot repeat it yet; the banner's only way forward is to check every Source.
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.outcomeUnknown.action');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.detail.outcomeUnknown.action')).toBeTruthy(),
    );
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.outcomeUnknown.action');
    });
    await vi.waitFor(() => expect(shared.calls.filter((call) => call.actionId === 'projects.sources.create')).toHaveLength(2));
    const [first, second] = shared.calls.filter((call) => call.actionId === 'projects.sources.create');
    expect(second!.input.requestKey).toBe(first!.input.requestKey);
    expect(shared.navigation).toContainEqual('/projects/sources?source=created');
  });

  it('never shows a same-id local document for a dashboard attached on another Home', async () => {
    signIn();
    storage.setState({
      artifacts: {
        dash: { id: 'dash', title: 'Local release', isDecrypted: true, access: 'edit' },
      } as never,
    });
    shared.sources = [
      {
        id: 'source-1',
        revision: 1,
        name: 'happier',
        audience: [],
        createdByAccountId: 'account-1',
        repository: {
          provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'happier-dev/happier' },
          protocol: 'https',
        },
        attachments: [
          { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dash' } },
          { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dash', serverId: 'server-2' } },
        ],
      },
    ];
    shared.routes.params = { source: 'source-1' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.dashboard.server-2:dash')).toBeTruthy(),
    );
    // The outermost match is the row itself (its title/subtitle props); findByTestId prefers the pressable host.
    const local = screen.findAllByTestId('projects.sources.dashboard.server-1:dash')[0]!;
    const foreign = screen.findAllByTestId('projects.sources.dashboard.server-2:dash')[0]!;
    expect(local.props.title).toBe('Local release');
    expect(foreign.props.title).not.toBe('Local release');
    expect(foreign.props.subtitle).toBe('projects.sources.dashboardOtherHome');
  });
  it('edits the default branch through a field select whose Other entry asks for any ref', async () => {
    signIn();
    shared.sources = [
      {
        id: 'source-1',
        revision: 1,
        name: 'happier',
        audience: [],
        createdByAccountId: 'account-1',
        repository: {
          provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'happier-dev/happier' },
          protocol: 'https',
        },
        defaultRef: 'v0.3',
      },
    ];
    shared.routes.params = { source: 'source-1' };
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { Modal } = await import('@/modal');
    const screen = await renderScreen(<ProjectSourcesScreen />);
    const select = () => screen.findAllByType(DropdownMenu).find((node) => node.props.testID === 'projects.sources.detail.defaultRef');
    await vi.waitFor(() => expect(select()).toBeDefined());
    // The stored ref is the selection; the repository default and Other stay one step away (T1-F8).
    expect(select()!.props.items.map((item: { id: string }) => item.id)).toEqual(['ref:@default', 'ref:v0.3', 'ref:@other']);
    expect(select()!.props.selectedId).toBe('ref:v0.3');
    expect(screen.findByTestId('projects.sources.detail.save')).toBeFalsy();
    vi.mocked(Modal.prompt).mockResolvedValueOnce('develop');
    await act(async () => {
      select()!.props.onSelect('ref:@other');
    });
    await vi.waitFor(() => expect(select()!.props.selectedId).toBe('ref:develop'));
    expect(screen.findByTestId('projects.sources.detail.save')).toBeTruthy();
  });
});
