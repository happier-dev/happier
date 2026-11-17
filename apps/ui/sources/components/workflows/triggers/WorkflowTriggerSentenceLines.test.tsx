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
});
