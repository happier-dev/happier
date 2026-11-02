import { describe, expect, it } from 'vitest';

import { getActionSpec, listActionSpecs, PUBLIC_ACTION_INPUT_SCHEMAS, PUBLIC_ACTION_OUTPUT_SCHEMAS } from './actionSpecs.js';
import { isAgentInitiatedApprovalRequiredByDefault } from './actionApprovalPolicy.js';

describe('browser annotation Actions', () => {
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
