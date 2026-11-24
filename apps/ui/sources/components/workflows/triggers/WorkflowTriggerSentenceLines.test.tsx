import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

import { WorkflowFieldPair } from '../editor/WorkflowStepDataEditor';
import { WorkflowSentenceRowsContext } from '../sentence/WorkflowSentenceChip';
import { WorkflowTriggerSentenceLines } from './WorkflowTriggerSentenceLines';

afterEach(standardCleanup);

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
});
