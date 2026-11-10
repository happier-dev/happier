import { act, useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';

import * as PluginUi from '@happier-dev/plugin-ui/components';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import type { HappierLayoutChangeEvent } from '../presentation/portableTypes.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';

function mountWithPopoverHost(element: ReactElement) {
  const context = createSurfaceContext();
  const host = {
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderIcon: () => null,
    renderPopover: (
      input: Parameters<PluginUiPresentationHost['renderPopover']>[0],
    ) =>
      input.open
        ? input.content({
            requestClose: () => input.onRequestClose(),
            maxHeight: 400,
          })
        : null,
  } as unknown as PluginUiPresentationHost;
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PluginUiPresentationHostProviderInternal host={host}>
        {element}
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>,
  );
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('public PropertyList', () => {
  // A property's value is a short summary that opens its picker, so on a phone it stays beside its label (ui-craft:
  // only a switch, a short value or a chevron sits right of a label) instead of doubling every row's height.
  it('keeps the value beside its label on a phone and retains the open editor across a resize', async () => {
    const mount = mountWithPopoverHost(<PluginUi.PropertyList testID="props" items={[
      { id: 'assignee', label: 'Assignee', value: 'Ada Lovelace', editor: {
        kind: 'choice', value: 'member:1', choices: [{ id: 'member:1', label: 'Ada Lovelace' }], searchable: true, onCommit: () => {},
      } },
    ]} />);
    try {
      const box = mount.container.querySelector<HTMLElement>('[data-testid="props"]')!;
      // A list that measures its pane is given each width; one that does not has nothing to recompose.
      const onLayout = (box as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="props.assignee.value"]')!.click(); });
      const search = mount.container.querySelector<HTMLInputElement>('[data-testid="props.assignee.value.search"]')!;
      await act(async () => { typeInto(search, 'Ada'); });
      for (const width of [900, 390, 0, 900]) {
        act(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width, height: 200 } } }); });
        const row = mount.container.querySelector<HTMLElement>('[data-testid="props.assignee"]')!;
        expect(row.style.flexDirection).toBe('row');
        expect(mount.container.querySelector('[data-testid="props.assignee.value.search"]')).toBe(search);
        expect(search.value).toBe('Ada');
      }
    } finally { mount.unmount(); }
  });

  it.each(['choice', 'choices'] as const)('searches %s names and supporting identities without writing, then commits stable ids', async (kind) => {
    const commits: unknown[] = [];
    const onCommit = (next: unknown) => { commits.push(next); };
    const choices = [
      { id: 'member:1', label: 'Ada Lovelace', subtitle: 'Member' },
      { id: 'team:2', label: 'Platform', subtitle: 'Team · 6 people' },
      { id: 'member:3', label: 'Grace Hopper', subtitle: 'Member' },
    ];
    const editor: PluginUi.PropertyEditor = kind === 'choice'
      ? { kind, value: 'member:3', choices, searchable: true, onCommit }
      : { kind, value: ['member:3'], choices, searchable: true, onCommit };
    const mount = mountWithPopoverHost(<PluginUi.PropertyList testID="props" items={[
      { id: 'assignee', label: 'Assignee', value: 'Grace Hopper', clearLabel: 'Unassigned', editor },
    ]} />);
    try {
      const trigger = () => mount.container.querySelector<HTMLElement>('[data-testid="props.assignee.value"]')!;
      await act(async () => { trigger().click(); });
      const search = () => mount.container.querySelector<HTMLInputElement>('[data-testid="props.assignee.value.search"]');
      expect(search(), 'search belongs to the shared choice menu').not.toBeNull();
      await act(async () => { typeInto(search()!, 'aDA'); });
      const rows = () => Array.from(mount.container.querySelectorAll<HTMLElement>(`[role="${kind === 'choice' ? 'menuitemradio' : 'menuitemcheckbox'}"]`));
      expect(rows().map(row => row.textContent)).toEqual(['Ada LovelaceMember']);
      expect(commits).toEqual([]);
      await act(async () => { typeInto(search()!, 'Nobody matches'); });
      expect(rows()).toHaveLength(0);
      expect(mount.container.textContent).toContain('No matches');
      await act(async () => { typeInto(search()!, '6 people'); });
      expect(rows().map(row => row.textContent)).toEqual(['PlatformTeam · 6 people']);
      expect(commits).toEqual([]);
      await act(async () => { rows()[0]!.click(); });
      expect(commits).toEqual([kind === 'choice' ? 'team:2' : ['member:3', 'team:2']]);
      if (kind === 'choice') {
        await act(async () => { typeInto(search()!, ''); });
        const clear = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
          .find(row => row.textContent === 'Unassigned');
        expect(clear).toBeDefined();
        await act(async () => { clear!.click(); });
        expect(commits).toEqual(['team:2', null]);
      }
      const settledCommits = [...commits];
      await act(async () => { trigger().click(); });
      expect(search()).toBeNull();
      await act(async () => { trigger().click(); });
      expect(search()?.value).toBe('');
      expect(rows()).toHaveLength(3);
      expect(commits).toEqual(settledCommits);
    } finally { mount.unmount(); }
  });

  it('draws a person choice with their face, kept out of the name that is read and searched', async () => {
    const mount = mountWithPopoverHost(<PluginUi.PropertyList testID="props" items={[{
      id: 'assignee', label: 'Assignees', value: null, editor: { kind: 'choices', value: [], searchable: true, onCommit: () => {},
        choices: [{ id: 'ada', label: 'Ada Lovelace', person: 'Ada Lovelace' }, { id: 'bug', label: 'bug' }] },
    }]} />);
    try {
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="props.assignee.value"]')!.click(); });
      const rows = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'));
      expect(rows.map(row => row.querySelector('[data-testid="menu-item-face"]') !== null)).toEqual([true, false]);
      const name = rows[0]!.querySelector('[data-testid="menu-item-face"]')!.closest('[aria-hidden="true"]');
      expect(name, 'the row is already named by its label').not.toBeNull();
    } finally { mount.unmount(); }
  });

  it('reads a directory of choices when its picker opens, says while it reads, and offers one retry when it cannot', async () => {
    const opened: string[] = [];
    function Directory(): ReactElement {
      const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
      const choices = status === 'ready' ? [{ id: 'ada', label: 'Ada Lovelace', subtitle: '@ada', person: 'Ada Lovelace' }] : [];
      return <PluginUi.PropertyList testID="props" items={[{
        id: 'assignee', label: 'Assignees', value: null, editor: { kind: 'choices', value: [], searchable: true, onCommit: () => {}, choices,
          directory: { status: status === 'idle' ? 'loading' : status, onOpen: () => { opened.push('open'); setStatus('loading'); },
            ...(status === 'unavailable' ? { retry: () => { opened.push('retry'); setStatus('ready'); } } : {}) } },
      }]} />;
    }
    const mount = mountWithPopoverHost(<Directory />);
    try {
      expect(opened, 'nothing is read before the picker opens').toEqual([]);
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="props.assignee.value"]')!.click(); });
      expect(opened).toEqual(['open']);
      expect(mount.container.querySelector('input:not([type="search"])[aria-label="Assignees"]'), 'a person is picked, never typed').toBeNull();
      const rows = () => Array.from(mount.container.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
      expect(rows().map(row => row.textContent)).toEqual(['Loading…']);
      expect(rows()[0]!.getAttribute('aria-disabled')).toBe('true');
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="props.assignee.value"]')!.click(); });
      // The owner reports the read failed; reopening says so in one line and offers one retry.
      const failed = mountWithPopoverHost(<PluginUi.PropertyList testID="failed" items={[{
        id: 'assignee', label: 'Assignees', value: null, editor: { kind: 'choices', value: [], searchable: true, onCommit: () => {}, choices: [],
          directory: { status: 'unavailable', retry: () => { opened.push('retry'); } } },
      }]} />);
      try {
        await act(async () => { failed.container.querySelector<HTMLElement>('[data-testid="failed.assignee.value"]')!.click(); });
        const failedRows = Array.from(failed.container.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
        expect(failedRows.map(row => row.textContent)).toEqual(['This list couldn’t be loaded', 'Try again']);
        await act(async () => { failedRows[1]!.click(); });
        expect(opened).toEqual(['open', 'retry']);
      } finally { failed.unmount(); }
    } finally { mount.unmount(); }
  });

  it('retains a search through a pending source write and shows its refused settlement', async () => {
    let finish!: (result: unknown) => void;
    let commits = 0;
    function PendingAssignee() {
      const [busy, setBusy] = useState(false);
      return <PluginUi.PropertyList testID="props" items={[{
        id: 'assignee', label: 'Assignee', value: 'Grace Hopper', busy,
        editor: { kind: 'choice', value: 'member:3', searchable: true,
          choices: [{ id: 'member:1', label: 'Ada Lovelace' }, { id: 'member:3', label: 'Grace Hopper' }],
          onCommit: async () => {
            commits++;
            setBusy(true);
            const result = await new Promise(resolve => { finish = resolve; });
            setBusy(false);
            return result;
          } },
      }]} />;
    }
    const mount = mountWithPopoverHost(<PendingAssignee />);
    try {
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="props.assignee.value"]')!.click(); });
      await act(async () => { typeInto(mount.container.querySelector<HTMLInputElement>('[data-testid="props.assignee.value.search"]')!, 'Ada'); });
      await act(async () => { mount.container.querySelector<HTMLElement>('[role="menuitemradio"]')!.click(); });
      expect(mount.container.querySelector('[data-testid="props.assignee.value"]')?.getAttribute('aria-disabled')).toBe('true');
      await act(async () => { finish({ status: 'refused', reason: 'task_conflict' }); });
      expect(mount.container.querySelector<HTMLInputElement>('[data-testid="props.assignee.value.search"]')?.value).toBe('Ada');
      expect(mount.container.textContent).toContain('not applied');
      expect(commits).toBe(1);
    } finally { mount.unmount(); }
  });

  it.each(['choice', 'date'] as const)('shows a refused %s commit and preserves its recovery context', async (kind) => {
    let calls = 0;
    const onCommit = async () => { calls++; return { status: 'refused', reason: 'task_conflict' }; };
    const editor: PluginUi.PropertyEditor = kind === 'choice'
      ? { kind, value: null, choices: [{ id: 'next', label: 'Next' }], searchable: true, onCommit }
      : { kind, value: null, onCommit };
    const mount = mountWithPopoverHost(<PluginUi.PropertyList testID="props" items={[
      { id: 'field', label: 'Field', value: null, editor },
    ]} />);
    try {
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="props.field.value"]')!.click(); });
      if (kind === 'choice') {
        await act(async () => { mount.container.querySelector<HTMLElement>('[role="menuitemradio"]')!.click(); });
      } else {
        await act(async () => { typeInto(mount.container.querySelector<HTMLInputElement>('[data-testid="props.field.value.input"]')!, '2026-11-03'); });
        await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="props.field.value.save"]')!.click(); });
        expect(mount.container.querySelector('[data-testid="props.field.value.input"]')).not.toBeNull();
      }
      expect(mount.container.textContent).toContain('not applied');
      expect(mount.container.textContent).toContain('Refresh');
      expect(calls).toBe(1);
    } finally { mount.unmount(); }
  });

  it.each(['refused', 'uncertain', 'rejected', 'declined', 'denied', 'timed-out'] as const)('keeps a %s colour settlement visible without replaying it', async (status) => {
    let calls = 0;
    let finish!: (result: unknown) => void;
    const mount = mountWithPopoverHost(<PluginUi.PropertyList testID="props" items={[{
      id: 'labels', label: 'Labels', value: 'bug', editor: { kind: 'list', value: ['bug'], onCommit: () => {},
        tones: { valueOf: () => null, choices: [{ id: 'red', label: 'Red', tone: 'danger' }],
          onCommit: async () => {
            calls++;
            const result = await new Promise(resolve => { finish = resolve; });
            if (status === 'rejected') throw new Error('Transport lost');
            if (status === 'declined') throw new PluginError({ code: 'denied',
              diagnostics: [{ code: 'plugin_action_current_intent_rejected', severity: 'error' }] });
            if (status === 'denied') throw new PluginError({ code: 'denied' });
            if (status === 'timed-out') throw new PluginError({ code: 'timeout' });
            return result;
          } },
      },
    }]} />);
    try {
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="props.labels.value"]')!.click(); });
      const colour = () => mount.container.querySelector<HTMLElement>('[aria-label="Colour of bug, No colour"]')!;
      await act(async () => { colour().click(); });
      await act(async () => {
        Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).find(node => node.textContent === 'Red')!.click();
      });
      expect(colour().getAttribute('aria-disabled')).toBe('true');
      await act(async () => { finish({ status, reason: 'task_conflict' }); });
      expect(mount.container.textContent).toContain(status === 'refused' || status === 'declined' || status === 'denied'
        ? 'not applied' : 'not confirmed');
      expect(mount.container.textContent).toContain('Refresh');
      expect(calls).toBe(1);
      expect(colour().getAttribute('aria-disabled')).not.toBe('true');
    } finally { mount.unmount(); }
  });

  it('commits one typed property per deliberate change and keeps read-only values plain', async () => {
    const commits: unknown[] = [];
    const { PropertyList } = PluginUi as typeof PluginUi & {
      PropertyList?: typeof PluginUi.PropertyList;
    };
    expect(
      PropertyList,
      'authors render typed properties through the public entry point',
    ).toBeDefined();
    const mount = mountWithPopoverHost(
      <PropertyList
        testID="props"
        items={[
          {
            id: 'priority',
            label: 'Priority',
            value: 'High',
            editor: {
              kind: 'choice',
              value: 'high',
              choices: [
                { id: 'urgent', label: 'Urgent' },
                { id: 'high', label: 'High' },
              ],
              onCommit: (next) => {
                commits.push(['priority', next]);
              },
            },
          },
          {
            id: 'due',
            label: 'Due date',
            value: null,
            editor: {
              kind: 'date',
              value: null,
              onCommit: (next) => {
                commits.push(['due', next]);
              },
            },
          },
          {
            id: 'estimate',
            label: 'Estimate',
            value: '2',
            editor: {
              kind: 'number',
              value: 2,
              onCommit: (next) => {
                commits.push(['estimate', next]);
              },
            },
          },
          { id: 'created', label: 'Created', value: '2 days ago' },
        ]}
      />,
    );
    try {
      const value = (id: string) =>
        mount.container.querySelector<HTMLElement>(
          `[data-testid="props.${id}.value"]`,
        );
      // A read-only value is words, not a control; an unset value reads "None".
      expect(
        mount.container.querySelector(
          '[data-testid="props.created"] [role="button"]',
        ),
      ).toBeNull();
      expect(mount.container.textContent).toContain('2 days ago');
      expect(value('due')?.textContent).toContain('None');

      // A choice commits when picked, once, with the author's own id.
      await act(async () => {
        value('priority')!.click();
      });
      const urgent = Array.from(
        mount.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      ).find((row) => row.textContent?.includes('Urgent'));
      await act(async () => {
        urgent!.click();
      });
      expect(commits).toEqual([['priority', 'urgent']]);

      // A typed value commits only on Save, after validation; a malformed day never reaches the author.
      await act(async () => {
        value('due')!.click();
      });
      const due = mount.container.querySelector<HTMLInputElement>(
        '[data-testid="props.due.value.input"]',
      )!;
      await act(async () => {
        typeInto(due, '2026-02-30');
      });
      await act(async () => {
        mount.container
          .querySelector<HTMLElement>('[data-testid="props.due.value.save"]')!
          .click();
      });
      expect(commits).toEqual([['priority', 'urgent']]);
      expect(mount.container.textContent).toContain('YYYY-MM-DD');
      await act(async () => {
        typeInto(
          mount.container.querySelector<HTMLInputElement>(
            '[data-testid="props.due.value.input"]',
          )!,
          '2026-11-03',
        );
      });
      await act(async () => {
        mount.container
          .querySelector<HTMLElement>('[data-testid="props.due.value.save"]')!
          .click();
      });
      expect(commits).toEqual([
        ['priority', 'urgent'],
        ['due', '2026-11-03'],
      ]);
      expect(
        mount.container.querySelector('[data-testid="props.due.value.input"]'),
      ).toBeNull();

      // Clearing a number is "not set" (null), never zero.
      await act(async () => {
        value('estimate')!.click();
      });
      await act(async () => {
        typeInto(
          mount.container.querySelector<HTMLInputElement>(
            '[data-testid="props.estimate.value.input"]',
          )!,
          '',
        );
      });
      await act(async () => {
        mount.container
          .querySelector<HTMLElement>(
            '[data-testid="props.estimate.value.save"]',
          )!
          .click();
      });
      expect(commits.at(-1)).toEqual(['estimate', null]);
    } finally {
      mount.unmount();
    }
  });
});

describe('public PropertyList names', () => {
  it('draws a list of names as chips when asked, never joined words', () => {
    const mount = mountWithPopoverHost(<PluginUi.PropertyList testID="props" items={[{
      id: 'labels', label: 'Labels', value: 'bug, docs',
      editor: { kind: 'list', value: ['bug', 'docs'], chips: true, onCommit: () => undefined },
    }]} />);
    try {
      const value = mount.container.querySelector<HTMLElement>('[data-testid="props.labels.value"]')!;
      expect(value.textContent).not.toContain('bug, docs');
      expect(value.textContent).toContain('bug');
      expect(value.textContent).toContain('docs');
    } finally { mount.unmount(); }
  });
});

describe('public RelationList', () => {
  it('draws the add as a row of the sheet, not a filled control beneath it', () => {
    const mount = mountWithPopoverHost(
      <PluginUi.RelationList accessibilityLabel="Blocked by" testID="rel" entries={[]}
        add={{ label: 'Add a blocker', choices: [{ id: 'b', label: 'Fix totals' }], onAdd: () => undefined }} />,
    );
    try {
      const add = mount.container.querySelector<HTMLElement>('[data-testid="rel.add"]')!;
      expect(add.textContent).toContain('Add a blocker');
      expect(add.closest('[data-testid="rel.sheet"]')).not.toBeNull();
    } finally { mount.unmount(); }
  });
  it('lists read relations with their status, adds from the given choices and removes one row at a time', async () => {
    const changes: string[] = [];
    const { RelationList } = PluginUi as typeof PluginUi & {
      RelationList?: typeof PluginUi.RelationList;
    };
    expect(
      RelationList,
      'authors render relations through the public entry point',
    ).toBeDefined();
    const mount = mountWithPopoverHost(
      <RelationList
        testID="rel"
        title="Blocked by"
        summary="1 open"
        entries={[
          {
            id: 'a',
            title: 'Add Stripe webhook replay tool',
            designation: '#2470',
            status: 'started',
            onRemove: () => {
              changes.push('remove:a');
            },
          },
        ]}
        add={{
          label: 'Add a blocker',
          choices: [
            { id: 'b', label: 'Fix WebKit totals', subtitle: 'CHK-218' },
          ],
          onAdd: (id) => {
            changes.push(`add:${id}`);
          },
        }}
      />,
    );
    try {
      expect(mount.container.textContent).toContain('Blocked by');
      expect(mount.container.textContent).toContain('1 open');
      expect(mount.container.textContent).toContain('#2470');
      await act(async () => {
        mount.container
          .querySelector<HTMLElement>('[data-testid="rel.a.remove"]')!
          .click();
      });
      await act(async () => {
        mount.container
          .querySelector<HTMLElement>('[data-testid="rel.add"]')!
          .click();
      });
      const choice = Array.from(
        mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((row) => row.textContent?.includes('Fix WebKit totals'));
      expect(choice?.textContent).toContain('CHK-218');
      await act(async () => {
        choice!.click();
      });
      expect(changes).toEqual(['remove:a', 'add:b']);
    } finally {
      mount.unmount();
    }
  });

  it('stands untitled inside a chapter that names it: named by its label, with the add control after its rows', async () => {
    const changes: string[] = [];
    const mount = mountWithPopoverHost(
      <PluginUi.RelationList
        testID="rel"
        accessibilityLabel="Blocked by"
        summary="1 open"
        entries={[{ id: 'a', title: 'Add Stripe webhook replay tool', designation: '#2470', status: 'started' }]}
        add={{ label: 'Add a blocker', choices: [{ id: 'b', label: 'Fix WebKit totals' }], onAdd: (id) => { changes.push(`add:${id}`); } }}
      />,
    );
    try {
      // The enclosing chapter says the title and the summary; the list does not repeat them.
      expect(mount.container.textContent).not.toContain('1 open');
      expect(mount.container.querySelector('[aria-label="Blocked by"]')).not.toBeNull();
      await act(async () => {
        mount.container.querySelector<HTMLElement>('[data-testid="rel.add"]')!.click();
      });
      const choice = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((row) => row.textContent?.includes('Fix WebKit totals'));
      await act(async () => { choice!.click(); });
      expect(changes).toEqual(['add:b']);
    } finally {
      mount.unmount();
    }
  });
});
