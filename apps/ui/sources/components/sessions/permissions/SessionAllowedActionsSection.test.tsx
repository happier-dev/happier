import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { SessionApprovalConsentModeChangeV1 } from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { SessionApprovalConsentsState } from '@/hooks/approvals/useSessionApprovalConsents';

// Portal positioning is a browser boundary; the menu and its catalog stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);

const { SessionAllowedActionsGroup } =
  await import('./SessionAllowedActionsSection');

const deploy = 'deployments.deploy';
const deployKey = JSON.stringify([deploy, null, null]);
const machineKey = JSON.stringify([deploy, 'machine', 'machine-7']);

/** The consent owner's writer is the Action-execution boundary; record what it is asked to save. */
function recordingWriter() {
  const writes: SessionApprovalConsentModeChangeV1[] = [];
  return {
    writes,
    write: async (change: SessionApprovalConsentModeChangeV1) => {
      writes.push(change);
      return { ok: true };
    },
  };
}

const publish = 'acme.publisher/actions/releases/publish';
const publishKey = JSON.stringify([publish, null, null]);
/** The Session Machine's contributed Actions, as Settings › Actions reads them from its daemon projection. */
const CATALOG = {
  actions: [{ pluginId: 'acme.publisher', localId: 'releases/publish', title: 'Publish release notes',
    description: 'Posts the notes to the release page.', icon: null, surfaces: ['agent', 'ui'] }],
  pluginTitles: new Map([['acme.publisher', 'Acme Publisher']]),
} as const;

function group(
  state: SessionApprovalConsentsState,
  write = recordingWriter().write,
  catalog: typeof CATALOG | null = null,
) {
  // A page section: its header (title, description, Add an Action) is drawn on a page list.
  return (
    <ItemList>
      <SessionAllowedActionsGroup
        serverId="home-1"
        state={state}
        setRow={write}
        ready
        catalog={catalog}
      />
    </ItemList>
  );
}

describe('Session › Allowed › Actions', () => {
  afterEach(async () => {
    await standardCleanup();
  });

  it.each([
    ['loading', { status: 'loading' }, 'session-allowed-actions-loading'],
    [
      'unavailable',
      { status: 'unavailable' },
      'session-allowed-actions-unavailable',
    ],
    ['empty', { status: 'ready', rows: [] }, 'session-allowed-actions-empty'],
  ] as const)(
    'keeps the section in place while %s',
    async (_label, state, testID) => {
      const screen = await renderScreen(group(state));
      expect(screen.getTextContent()).toContain('Actions');
      expect(screen.findByTestId(testID)).not.toBeNull();
      expect(
        screen.findByTestId('session-allowed-actions:add:trigger'),
      ).not.toBeNull();
    },
  );

  it('lists each override with where it applies and its answer', async () => {
    const screen = await renderScreen(
      group({
        status: 'ready',
        rows: [
          { actionId: deploy, audience: 'agent', mode: 'allowed' },
          {
            actionId: deploy,
            audience: 'agent',
            scope: { kind: 'machine', machineId: 'machine-7' },
            mode: 'ask_first',
          },
        ],
      }),
    );
    const text = screen.getTextContent();
    expect(text).toContain(getActionSpec(deploy).title);
    expect(text).toContain('Anywhere');
    expect(text).toContain('On machine-7');
    expect(
      screen.findByTestId(`session-allowed-action:${deployKey}:mode:allowed`)
        ?.props.accessibilityState.checked,
    ).toBe(true);
    expect(
      screen.findByTestId(`session-allowed-action:${machineKey}:mode:ask_first`)
        ?.props.accessibilityState.checked,
    ).toBe(true);
  });

  it('changes and removes a row with one write each, keeping a removed row in place for this visit', async () => {
    const { writes, write } = recordingWriter();
    const stored = {
      status: 'ready',
      rows: [{ actionId: deploy, audience: 'agent', mode: 'allowed' }],
    } as const;
    const screen = await renderScreen(group(stored, write));
    await screen.pressByTestIdAsync(
      `session-allowed-action:${deployKey}:mode:ask_first`,
    );
    await screen.pressByTestIdAsync(
      `session-allowed-action:${deployKey}:mode:default`,
    );
    expect(writes).toEqual([
      { actionId: deploy, audience: 'agent', mode: 'ask_first' },
      { actionId: deploy, audience: 'agent', mode: 'default' },
    ]);
    // The record no longer has the row; the person still sees it, at Default.
    await screen.update(group({ status: 'ready', rows: [] }, write));
    expect(screen.findByTestId('session-allowed-actions-empty')).toBeNull();
    expect(
      screen.findByTestId(`session-allowed-action:${deployKey}:mode:default`)
        ?.props.accessibilityState.checked,
    ).toBe(true);
  });

  it('adds an Action from the Account catalog as Allowed, and never offers approval-rule changes', async () => {
    const { writes, write } = recordingWriter();
    const screen = await renderScreen(
      group({ status: 'ready', rows: [] }, write),
    );
    const prefix = 'session-allowed-actions:add:';
    await screen.pressByTestIdAsync(`${prefix}trigger`);
    // Each offered Action is one menu row; its frame is `<row id>:scroll-frame`.
    const frame = ':scroll-frame';
    const readOffered = () => [...new Set(screen.findAll((node) => typeof node.props.testID === 'string'
      && node.props.testID.startsWith(prefix) && node.props.testID.endsWith(frame))
      .map((node) => String(node.props.testID).slice(prefix.length, -frame.length)))];
    // The menu lays its rows out after it opens.
    await vi.waitFor(() => expect(readOffered().length).toBeGreaterThan(0));
    const offered = readOffered();
    expect(offered).not.toContain('actions.policy.set');
    await screen.pressByTestIdAsync(`${prefix}${offered[0]}`);
    // The menu closes first, then hands the choice on.
    await vi.waitFor(() => expect(writes).toEqual([{ actionId: offered[0], audience: 'agent', mode: 'allowed' }]));
  });

  it('titles a plugin row by its contributed Action, never by its id', async () => {
    const rows = { status: 'ready', rows: [{ actionId: publish, audience: 'agent', mode: 'allowed' }] } as const;
    const loaded = await renderScreen(group(rows, undefined, CATALOG));
    expect(loaded.getTextContent()).toContain('Publish release notes');
    await standardCleanup();
    // The plugin is not loaded here: a neutral line stands in for its title.
    const unloaded = await renderScreen(group(rows));
    expect(unloaded.findByTestId(`session-allowed-action:${publishKey}`)).not.toBeNull();
    expect(unloaded.getTextContent()).not.toContain('releases/publish');
    expect(unloaded.getTextContent()).not.toContain('acme.publisher');
  });

  it('offers the Session Machine\'s contributed Actions in Add an Action, as Settings › Actions does', async () => {
    const { writes, write } = recordingWriter();
    const screen = await renderScreen(group({ status: 'ready', rows: [] }, write, CATALOG));
    await screen.pressByTestIdAsync('session-allowed-actions:add:trigger');
    // The catalog is long; narrow it the way a person does, through the menu's search.
    await vi.waitFor(() => expect(screen.findAll((node) => typeof node.props.onChangeText === 'function').length).toBeGreaterThan(0));
    await act(async () => { screen.findAll((node) => typeof node.props.onChangeText === 'function')[0]?.props.onChangeText('Publish release'); });
    await vi.waitFor(() => expect(screen.findByTestId(`session-allowed-actions:add:${publish}:scroll-frame`)).not.toBeNull());
    await screen.pressByTestIdAsync(`session-allowed-actions:add:${publish}`);
    await vi.waitFor(() => expect(writes).toEqual([{ actionId: publish, audience: 'agent', mode: 'allowed' }]));
  });

  it('groups Add an Action as Settings › Actions does, each Action with what it does', async () => {
    const screen = await renderScreen(group({ status: 'ready', rows: [] }, undefined, CATALOG));
    await screen.pressByTestIdAsync('session-allowed-actions:add:trigger');
    await vi.waitFor(() => expect(screen.findAll((node) => typeof node.props.onChangeText === 'function').length).toBeGreaterThan(0));
    await act(async () => { screen.findAll((node) => typeof node.props.onChangeText === 'function')[0]?.props.onChangeText('Publish release'); });
    await vi.waitFor(() => expect(screen.findByTestId(`session-allowed-actions:add:${publish}:scroll-frame`)).not.toBeNull());
    // The contributing plugin titles its group; the row says what the Action does.
    expect(screen.getTextContent()).toContain('Acme Publisher');
    expect(screen.getTextContent()).toContain('Posts the notes to the release page.');
  });
});
