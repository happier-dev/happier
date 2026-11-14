import { describe, expect, it } from 'vitest';

import { getActionSpec, listActionSpecs, PUBLIC_ACTION_INPUT_SCHEMAS, PUBLIC_ACTION_OUTPUT_SCHEMAS } from './actionSpecs.js';
import { isAgentInitiatedApprovalRequiredByDefault } from './actionApprovalPolicy.js';

describe('browser annotation Actions', () => {
  it('validates a supplied picker result while preserving daemon selected-element capture', () => {
    const input = { browserSessionId: 'browser_1', viewId: 'view_1' };
    const schema = PUBLIC_ACTION_INPUT_SCHEMAS['browser.context.captureSelectedElement'];
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, pickerResult: { status: 'selected' } }).success).toBe(false);
  });

  it('places supplied-picker capture at the client and ordinary capture at the Machine', () => {
    const spec = getActionSpec('browser.context.captureSelectedElement');
    const input = { browserSessionId: 'browser_1', viewId: 'view_1' };
    const placement = (value: unknown) => spec.executionPlacementForInput?.(value, undefined, 'ui') ?? spec.executionPlacement;
    expect(placement(input)).toBe('machine');
    expect(placement({ ...input, pickerResult: {
      v: 1, pickerRequestId: 'picker_1', viewId: 'view_1', navigationGeneration: 1,
      tier: 'injectedPage', status: 'selected', audited: true, selectorPath: '#submit',
    } })).toBe('client');
  });

  it('accepts composer paragraph comments beyond the retired metadata comment cap', () => {
    const comment = 'x'.repeat(2049);
    const input = { browserSessionId: 'browser_1', viewId: 'view_1', navigationGeneration: 1, comment };
    expect(PUBLIC_ACTION_INPUT_SCHEMAS['browser.context.annotation.setDraftComment'].parse(input).comment).toBe(comment);
  });

  it('keeps host lifecycle and comment Actions while drawing uses media.annotation.apply', () => {
    expect(listActionSpecs().filter(spec => spec.id.startsWith('browser.context.annotation.')).map(spec => spec.id).sort()).toEqual([
      'browser.context.annotation.attachDraft',
      'browser.context.annotation.cancel',
      'browser.context.annotation.setDraftComment',
      'browser.context.annotation.start',
    ]);
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.annotation.attachDraft')).toBe(true);
    expect(isAgentInitiatedApprovalRequiredByDefault('browser.context.annotation.setDraftComment')).toBe(false);
  });

  it('settles a comment edit without returning the retired drawing handles', () => {
    expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['browser.context.annotation.setDraftComment'].safeParse({
      v: 1,
      actionId: 'browser.context.annotation.setDraftComment',
      status: 'draftUpdated',
    }).success).toBe(true);
  });

  it('routes annotation lifecycle and comment edits to the mounted client owner', () => {
    for (const actionId of [
      'browser.context.annotation.start',
      'browser.context.annotation.cancel',
      'browser.context.annotation.setDraftComment',
      'browser.context.annotation.attachDraft',
    ] as const) {
      expect(getActionSpec(actionId).executionPlacement).toBe('client');
    }
  });
});
