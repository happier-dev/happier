import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { buildTriggerDefinition, type TriggerWhenValue } from './sessionTriggerForm';
import { formatSessionLifecycleScope } from './formatTriggerSummary';

vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
    { maxHeight: 640, maxWidth: 600, placement: 'bottom' },
  ),
);
vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
    { maxHeight: 640, maxWidth: 600, placement: 'bottom' },
  ),
);

const { WorkflowFieldPair } = await import('../editor/WorkflowStepDataEditor');
const { WorkflowSentenceRowsContext } = await import('../sentence/WorkflowSentenceChip');
const { WorkflowTriggerSentenceLines } = await import('./WorkflowTriggerSentenceLines');
const { WorkflowTriggerBlock } = await import('./WorkflowTriggerBlock');
const { TriggerPluginEventRows } = await import('./TriggerPluginEventRows');
const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');

afterEach(standardCleanup);

describe('editing a sentence trigger filter', () => {
  it.each([false, true])('keeps its open editor and unfinished clause through completion changes (rows: %s)', async (rows) => {
    let current: TriggerWhenValue = {
      kind: 'turnEnds', subject: { kind: 'project', serverId: 'portable-home', projectKey: 'project-one' },
    };
    function Habit() {
      const [when, setWhen] = React.useState<TriggerWhenValue>(current);
      current = when;
      const incomplete = buildTriggerDefinition({ when, enabled: true, sessionId: null }) === null;
      const scope = formatSessionLifecycleScope(when.kind === 'turnEnds' ? when.subject : undefined);
      return (
        <WorkflowSentenceRowsContext.Provider value={rows}>
          <WorkflowTriggerSentenceLines testIDPrefix="p" startOptions={[]} onAdd={() => {}}
            onStartsOpenChange={() => {}} editable={false}
            lines={[{ key: 'habit', startId: null, startTitle: 'A session finishes a turn',
              detail: scope.title, detailWord: scope.word, enabled: true, incomplete,
              onSelectStart: () => {}, onRemove: () => {},
              renderRows: () => <WorkflowTriggerBlock testID="habit" title="A session finishes a turn"
                when={when} enabled incomplete={incomplete} startOptions={[]} onSelectStart={() => {}}
                onChangeWhen={setWhen} onRemove={() => {}} machineId={null} serverId={null} />,
            }]} />
        </WorkflowSentenceRowsContext.Provider>
      );
    }
    const screen = await renderScreen(<Habit />);
    try {
      expect(buildTriggerDefinition({ when: current, enabled: true, sessionId: null })).not.toBeNull();
      await screen.pressByTestIdAsync('p-sentence-trigger:habit-detail');
      await screen.pressByTestIdAsync('automation-event-filter-add-clause');
      expect(current).toMatchObject({ filterInvalid: true });
      expect(screen.findByTestId('habit')).not.toBeNull();
      const valueID = 'automation-event-filter-clause-draft-0-value';
      expect(screen.findByTestId(valueID)).not.toBeNull();
      await screen.pressByTestIdAsync('automation-event-filter-clause-draft-0-field-picker');
      await screen.pressByTestIdAsync('automation-event-filter-clause-draft-0-field-option-/changedFiles');
      await act(async () => screen.findByTestId(valueID)!.props.onChangeText('true'));
      expect(buildTriggerDefinition({ when: current, enabled: true, sessionId: null })).toMatchObject({
        filter: { v: 1, all: [{ field: '/changedFiles', op: 'eq', value: true }] },
      });
      expect(screen.findByTestId('habit')).not.toBeNull();
      expect(screen.findByTestId(valueID)?.props.value).toBe('true');
      // Becoming incomplete again must keep the same editable operand, rather than recreating the editor.
      await act(async () => screen.findByTestId(valueID)!.props.onChangeText(''));
      expect(current).toMatchObject({ filterInvalid: true });
      expect(screen.findByTestId('habit')).not.toBeNull();
      expect(screen.findByTestId(valueID)?.props.value).toBe('');
    } finally { await screen.unmount(); }
  });
});

describe('the sentence When clause as labelled rows (phone builder sheet)', () => {
  it('puts a workflow with no trigger on the When row, with its add chip in that row', async () => {
    const screen = await renderScreen(
      <WorkflowSentenceRowsContext.Provider value>
        <WorkflowTriggerSentenceLines
          testIDPrefix="p"
          lines={[]}
          startOptions={[]}
          onAdd={() => {}}
          onStartsOpenChange={() => {}}
          editable
        />
      </WorkflowSentenceRowsContext.Provider>,
    );
    const whenRows = screen
      .findAllByType(WorkflowFieldPair)
      .filter((pair) => pair.props.label === t('workflows.sentence.rows.when'));
    expect(whenRows).toHaveLength(1);
    expect(
      whenRows[0]!.findAll(
        (node) => node.props.testID === 'p-sentence-add-trigger',
      ).length,
    ).toBeGreaterThan(0);
  });

  // NF-29: after "When" the start reads in sentence case ("When a session finishes a turn"); a name keeps its capitals.
  it('lowers a leading article after When but keeps an acronym', async () => {
    const line = (key: string, startTitle: string) => ({ key, startId: null, startTitle, detail: null, enabled: true,
      incomplete: false, onSelectStart: () => {}, onRemove: () => {}, renderRows: () => null });
    const screen = await renderScreen(
      <WorkflowTriggerSentenceLines
        testIDPrefix="p"
        lines={[line('a', 'A session finishes a turn'), line('b', 'CI fails')]}
        startOptions={[]}
        onAdd={() => {}}
        onStartsOpenChange={() => {}}
        editable={false}
      />,
    );
    const label = (key: string) => screen.findAll((node) => node.props.testID === `p-sentence-trigger:${key}-start`)[0]?.props.label;
    expect(label('a')).toBe('a session finishes a turn');
    expect(label('b')).toBe('CI fails');
  });

  // MF-4: an Event's setup opened from the detail chip is the popover's own step, as in the Link sheet, never a
  // card nested under the trigger's When (which would repeat the Event it sets up).
  it('sets up an Event as the chip popover\'s own step and comes back on Cancel', async () => {
    const eventRef = { pluginId: 'acme.deploy', localId: 'released' };
    const block = (
      <WorkflowTriggerBlock testID="b" title="Released" when={{ kind: 'pluginEvent', value: null, eventRef }}
        enabled incomplete startOptions={[]} onSelectStart={() => {}} onChangeWhen={() => {}} onRemove={() => {}}
        machineId={null} serverId={null} />
    );
    const screen = await renderScreen(
      <WorkflowTriggerSentenceLines
        testIDPrefix="p"
        lines={[{ key: 'e', startId: null, startTitle: 'Released', detail: null, enabled: true, incomplete: true,
          onSelectStart: () => {}, onRemove: () => {}, renderRows: () => block }]}
        startOptions={[]}
        onAdd={() => {}}
        onStartsOpenChange={() => {}}
        editable={false}
      />,
    );
    try {
      await screen.pressByTestIdAsync('p-sentence-trigger:e-detail');
      expect(screen.findByTestId('b-title')).not.toBeNull();
      await screen.pressByTestIdAsync('b-configure-event');
      const rows = screen.findAllByType(TriggerPluginEventRows)[0]!;
      expect(rows.props.editing).toBe(true);
      // The step replaces the trigger's rows: no title, no When above it, and no floating card around its own.
      expect(screen.findByTestId('b-title')).toBeNull();
      expect(screen.findAllByType(FloatingOverlay).filter((overlay) => overlay.findAllByType(TriggerPluginEventRows).length > 0
        && overlay.findAllByType(FloatingOverlay).length > 1)).toHaveLength(0);
      await act(async () => rows.props.onEditingChange(false));
      expect(screen.findByTestId('b-title')).not.toBeNull();
    } finally { await screen.unmount(); }
  });
});

describe('an Event trigger set up in flow (Steps card)', () => {
  it('replaces the trigger\'s rows with the setup step, drawn flat in the card, and comes back on Cancel', async () => {
    const eventRef = { pluginId: 'acme.deploy', localId: 'released' };
    const screen = await renderScreen(
      <WorkflowTriggerBlock testID="b" title="Released" when={{ kind: 'pluginEvent', value: null, eventRef }}
        enabled incomplete startOptions={[]} onSelectStart={() => {}} onChangeWhen={() => {}} onRemove={() => {}}
        machineId={null} serverId={null} />,
    );
    try {
      await screen.pressByTestIdAsync('b-configure-event');
      expect(screen.findAllByType(TriggerPluginEventRows)[0]!.props.editing).toBe(true);
      // One step: no trigger title or When above it, and no floating surface inside the in-flow card.
      expect(screen.findByTestId('b')).not.toBeNull();
      expect(screen.findByTestId('b-title')).toBeNull();
      expect(screen.findByTestId('b-starts')).toBeNull();
      expect(screen.findAllByType(FloatingOverlay)).toHaveLength(0);
      await screen.pressByTestIdAsync('automation-plugin-event-cancel');
      expect(screen.findByTestId('b-title')).not.toBeNull();
      expect(screen.findAllByType(TriggerPluginEventRows)[0]!.props.editing).toBe(false);
    } finally { await screen.unmount(); }
  });
});
