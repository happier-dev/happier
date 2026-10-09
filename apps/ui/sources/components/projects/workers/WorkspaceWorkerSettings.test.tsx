import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceExecutionSettingsV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    View: 'View',
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
  });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
  }),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

type Row = Readonly<{
  revision: number;
  value: WorkspaceExecutionSettingsV1;
}> | null;

/**
 * The Home's real workspace execution-config HTTP routes (Plain Account): one in-memory row with the
 * route's own revision compare-and-set. Everything above it — Action policy, the semantic client,
 * compare/rebase and the settings surface — is the production path.
 */
function createExecutionConfigHome() {
  let row: Row = null;
  const writes: WorkspaceExecutionSettingsV1[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  return {
    read: () => row,
    writes,
    replace(next: Row) {
      row = next;
    },
    handle: async (
      path: string,
      init?: RequestInit,
    ): Promise<Response | null> => {
      if (path === '/v1/projects/execution/config/read') {
        return json(
          row
            ? {
                status: 'present',
                revision: row.revision,
                content: { t: 'plain', v: row.value },
              }
            : { status: 'absent' },
        );
      }
      if (path === '/v1/projects/execution/config/mutate') {
        const request = JSON.parse(String(init?.body)) as {
          expectedRevision: number | 'absent';
          content: { t: 'plain'; v: WorkspaceExecutionSettingsV1 } | null;
        };
        const current = row ? row.revision : 'absent';
        if (request.expectedRevision !== current)
          return json(
            { status: 'conflict', revision: row ? row.revision : -1 },
            409,
          );
        const revision = (row?.revision ?? 0) + 1;
        if (request.content) {
          writes.push(request.content.v);
          row = { revision, value: request.content.v };
        }
        return json({ status: 'updated', revision, cursor: revision });
      }
      return null;
    },
  };
}

let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
  vi.restoreAllMocks();
});

const base: WorkspaceExecutionSettingsV1 = {
  enabled: false,
  unavailable: 'ask',
  allowAdHoc: false,
  scriptOverrides: {},
  services: {},
};

async function setup(
  options: Readonly<{ askFirst?: boolean; row?: Row }> = {},
) {
  const home = createExecutionConfigHome();
  home.replace(options.row ?? null);
  fixture = await createPlainArtifactHomeFixture(
    'https://worker-settings.test',
    { handleRequest: home.handle },
  );
  if (options.askFirst !== true) {
    // Ask first is the Action default; these cases waive it in the Account's canonical settings.
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const settingsScope = storage.getState().settingsScope;
    if (!settingsScope) throw new Error('expected_settings_scope');
    storage.getState().applySettingsForScope(settingsScope, settingsParse({ ...storage.getState().settings,
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.worker.preferences.set': ['ui'], 'projects.worker.preferences.reset': ['ui'] } },
    }), (storage.getState().settingsVersion ?? 0) + 1);
  }
  const workspace = {
    serverId: fixture.home.id,
    workspaceId: 'checkout',
    machineId: 'devbox',
    rootPath: '/src/happier',
  };
  const { WorkspaceWorkerSettings } = await import('./WorkspaceWorkerSettings');
  const screen = await renderScreen(
    <WorkspaceWorkerSettings
      testID="workers"
      workspace={workspace}
      scripts={[
        { name: 'test', portable: true },
        { name: 'lint', portable: false },
      ]}
      onBack={() => {}}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.findByTestId('workers.adHoc.switch')).toBeTruthy(),
  );
  return { home, screen };
}

describe('Workspace worker settings through the preference Actions', () => {
  it('saves the next preference against the observed absent row and shows it only once applied', async () => {
    const { home, screen } = await setup();
    expect(screen.findAllByTestId('workers.adHoc.switch')[0]?.props.value).toBe(
      false,
    );
    await act(async () => {
      screen.findAllByTestId('workers.adHoc.switch')[0]?.props.onValueChange(true);
    });
    await vi.waitFor(() =>
      expect(screen.findAllByTestId('workers.adHoc.switch')[0]?.props.value).toBe(
        true,
      ),
    );
    expect(home.writes, JSON.stringify(fixture?.requests)).toEqual([{ ...base, allowAdHoc: true }]);
  });

  it('keeps the current value and asks for review when the same setting changed elsewhere', async () => {
    const { home, screen } = await setup({ row: { revision: 3, value: base } });
    // Another device saves a different value for the same finite entry after this screen read revision 3.
    home.replace({
      revision: 4,
      value: { ...base, allowAdHoc: true, unavailable: 'fail' },
    });
    await act(async () => {
      screen.findAllByTestId('workers.adHoc.switch')[0]?.props.onValueChange(true);
    });
    await vi.waitFor(() =>
      expect(screen.findAllByTestId('workers.notice')[0]?.props.title).toBe(
        'projectWorkers.changed',
      ),
    );
    expect(home.read()).toEqual({
      revision: 4,
      value: { ...base, allowAdHoc: true, unavailable: 'fail' },
    });
    expect(home.writes).toEqual([]);
  });

  it('offers primary-only scripts no worker choice and resets a script to Default without touching others', async () => {
    const { home, screen } = await setup({
      row: {
        revision: 1,
        value: {
          ...base,
          scriptOverrides: { test: 'workers', release: 'primary' },
        },
      },
    });
    expect(screen.findAllByTestId('workers.script:lint:workers')).toHaveLength(
      0,
    );
    expect(screen.findByTestId('workers.script:lint')).toBeTruthy();
    await screen.pressByTestIdAsync('workers.script:test:default');
    await vi.waitFor(() => expect(home.writes, JSON.stringify(fixture?.requests)).toHaveLength(1));
    expect(home.writes[0]?.scriptOverrides).toEqual({ release: 'primary' });
  });

  it('waits for Ask-first approval without painting the attempted value as saved', async () => {
    const { home, screen } = await setup({ askFirst: true });
    await act(async () => {
      screen.findAllByTestId('workers.adHoc.switch')[0]?.props.onValueChange(true);
    });
    await vi.waitFor(() =>
      expect(screen.findAllByTestId('workers.notice')[0]?.props.title).toBe(
        'projectWorkers.approvalPending',
      ),
    );
    expect(screen.findAllByTestId('workers.adHoc.switch')[0]?.props.value).toBe(
      false,
    );
    expect(home.writes).toEqual([]);
  });
});
