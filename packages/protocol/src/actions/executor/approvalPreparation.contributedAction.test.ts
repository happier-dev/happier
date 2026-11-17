// Load the Action catalog first, as the other preparation tests do; the leaf module alone hits an import cycle.
import '../actionSettings.js';
import { describe, expect, it } from 'vitest';

import { ActionDefinitionSummaryV1Schema } from '../actionDefinitionV1.js';
import { prepareApprovalRequest } from './approvalPreparation.js';
import { describeApprovalActionFields } from '../actionApprovalPresentation.js';

const definition = ActionDefinitionSummaryV1Schema.parse({
  id: 'happier.triage/actions/work-items/transition-v1',
  title: 'Change task status',
  confirmVerb: 'Change status',
  description: 'Applies the selected status transition in its source.',
  safety: 'safe',
  placements: [],
  slash: null,
  bindings: null,
  examples: null,
  surfaces: { ui: true },
  inputHints: {
    fields: [
      { path: 'itemId', title: 'Task', widget: 'text' },
      { path: 'transitionId', title: 'New status', widget: 'text' },
    ],
  },
});

describe('approval preparation for a pressed contributed Action', () => {
  it('reviews the press by the contribution’s own declaration, not the generic host Action', async () => {
    const input = {
      action: {
        pluginId: 'happier.triage',
        localId: 'work-items/transition-v1',
      },
      input: { serverId: 'srv-1', itemId: 'LIN-482', transitionId: 'done' },
    };
    const prepared = await prepareApprovalRequest({
      actionId: 'action.invoke',
      input,
      actionArgs: input,
      context: { surface: 'ui' },
      deps: { listContributedActionDefinitions: () => [definition] },
    });

    expect(
      prepared && 'preview' in prepared ? prepared.preview : null,
    ).toMatchObject({
      contributedAction: {
        title: 'Change task status',
        confirmVerb: 'Change status',
        description: 'Applies the selected status transition in its source.',
        fields: [
          { path: 'itemId', title: 'Task' },
          { path: 'transitionId', title: 'New status' },
        ],
      },
    });
  });

  it('carries nothing extra when the receiver cannot read the contribution', async () => {
    const input = {
      action: {
        pluginId: 'happier.triage',
        localId: 'work-items/transition-v1',
      },
      input: {},
    };
    const prepared = await prepareApprovalRequest({
      actionId: 'action.invoke',
      input,
      actionArgs: input,
      context: { surface: 'ui' },
      deps: {},
    });

    expect(
      prepared && 'preview' in prepared ? prepared.preview : null,
    ).not.toHaveProperty('contributedAction');
  });
  it('names the declared input in words and keeps the ids and raw input under Technical details', async () => {
    const input = { action: { pluginId: 'happier.triage', localId: 'work-items/transition-v1' },
      input: { serverId: 'srv-1', itemId: 'LIN-482', transitionId: 'done' } };
    const prepared = await prepareApprovalRequest({ actionId: 'action.invoke', input, actionArgs: input,
      context: { surface: 'ui' }, deps: { listContributedActionDefinitions: () => [definition] } });
    const preview = prepared && 'preview' in prepared ? prepared.preview : null;

    const { rows } = describeApprovalActionFields({ actionId: 'action.invoke', actionArgs: input, preview });
    const shown = rows.flatMap(row => row.kind === 'value' && !row.technical ? [[row.title, row.value]] : []);
    const technical = rows.flatMap(row => row.kind === 'value' && row.technical ? [row.path] : []);
    expect(shown).toEqual([['Task', 'LIN-482'], ['New status', 'done']]);
    expect(technical).toEqual(expect.arrayContaining(['action.pluginId', 'action.localId']));
  });
});
