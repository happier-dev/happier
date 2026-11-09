import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { ActionIdSchema } from './actionIds.js';

describe('Automation occurrence Actions', () => {
  it.each(['automation.run.reply_handoff.retry', 'automation.run.result.redeliver'])('%s is an Account mutation available to every ordinary caller', id => {
    const spec = getActionSpec(ActionIdSchema.parse(id));
    expect(spec.executionPlacement).toBe('account');
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
    expect(spec.inputSchema.safeParse({ runId: 'run-1', ...(id.endsWith('redeliver') ? { expectedRevision: 7 } : {}) }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ runId: 'run-1', unexpectedAuthority: true }).success).toBe(false);
    expect(spec.cli?.commands?.length).toBeGreaterThan(0);
  });

  it('exposes one revision-fenced Run cancel Action for queued and started Runs', () => {
    expect(ActionIdSchema.safeParse('automation.run.cancel').success).toBe(false);
    const spec = getActionSpec('workflow.run.cancel');
    expect(spec.inputSchema.safeParse({ runId: 'run-1', expectedRevision: 7 }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ runId: 'run-1' }).success).toBe(false);
  });
});
