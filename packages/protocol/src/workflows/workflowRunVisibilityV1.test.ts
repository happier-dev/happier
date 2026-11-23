import { describe, expect, it } from 'vitest';
import { resolveWorkflowRunVisibleTeamV1 } from './workflowRunVisibilityV1.js';

describe('Workflow Run audience selection', () => {
  it('keeps private sources private and freezes one granted Team without allowing a shared opt-out', () => {
    expect(resolveWorkflowRunVisibleTeamV1([])).toEqual({ ok: true, visibleTeamId: null });
    expect(resolveWorkflowRunVisibleTeamV1(['one'])).toEqual({ ok: true, visibleTeamId: 'one' });
    expect(resolveWorkflowRunVisibleTeamV1(['one', 'two'], 'two')).toEqual({ ok: true, visibleTeamId: 'two' });
    for (const [grants, selection] of [
      [[], 'foreign'], [['one'], null], [['one', 'two'], undefined], [['one', 'two'], 'foreign'],
    ] satisfies readonly (readonly [readonly string[], string | null | undefined])[]) {
      expect(resolveWorkflowRunVisibleTeamV1(grants, selection)).toEqual({ ok: false, code: 'visible_team_not_granted' });
    }
  });

  it('keeps a check Run under an actor consent row private even when Teams are granted or chosen', () => {
    const consentFor = { automationId: 'shared-automation', triggerId: 'shared-trigger' };
    for (const [grants, selection] of [
      [['one'], undefined], [['one', 'two'], undefined], [['one', 'two'], 'two'],
    ] satisfies readonly (readonly [readonly string[], string | undefined])[]) {
      expect(resolveWorkflowRunVisibleTeamV1(grants, selection, consentFor)).toEqual({ ok: true, visibleTeamId: null });
    }
  });
});
