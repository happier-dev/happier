import { describe, expect, it, vi } from 'vitest';

import { createClaudeGoalRuntimeControls, type ClaudeGoalCommandDelivery } from './claudeGoalRuntimeControl';

const SENT: ClaudeGoalCommandDelivery = { kind: 'sent-to-terminal' };
const QUEUED: ClaudeGoalCommandDelivery = { kind: 'queued' };

describe('createClaudeGoalRuntimeControls', () => {
  it('injects `/goal <objective>` when an active session sets a goal', async () => {
    const injectGoalCommand = vi.fn(async () => SENT);
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand });

    const result = await controls.setGoal('finish the goal feature');

    expect(injectGoalCommand).toHaveBeenCalledTimes(1);
    expect(injectGoalCommand).toHaveBeenCalledWith('/goal finish the goal feature');
    // No error result => the live RPC handler reports success and never falls back to metadata.
    expect(result).toBeUndefined();
  });

  it('records a SET epoch once the set inject reaches the terminal (before any provider goal_status)', async () => {
    const injectGoalCommand = vi.fn(async () => SENT);
    const recordGoalSetIntent = vi.fn();
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand, recordGoalSetIntent });

    await controls.setGoal('ship it');

    expect(recordGoalSetIntent).toHaveBeenCalledTimes(1);
  });

  it('does NOT record a set epoch (and reports failure) when the set delivery stays below the threshold', async () => {
    const injectGoalCommand = vi.fn(async () => QUEUED);
    const recordGoalSetIntent = vi.fn();
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand, recordGoalSetIntent });

    const result = await controls.setGoal('ship it');

    expect(recordGoalSetIntent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_inject_failed' });
  });

  // G-1: Claude `/goal` cannot enforce a status transition. Rather than SILENTLY
  // dropping those options while returning success (the original bug — non-UI callers lose data with
  // no signal), the runtime control fails LOUDLY with a typed, NON-fallback error. UI callers never
  // send these for Claude (capability gate), so this is contract hardening for other callers.
  it('rejects a setGoal that requests a status transition (unsupported on Claude) without injecting', async () => {
    const injectGoalCommand = vi.fn(async () => SENT);
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand });

    const result = await controls.setGoal('ship it', { status: 'paused' });

    expect(injectGoalCommand).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
  });

  it('still injects a plain objective-only set when options carry no budget/status', async () => {
    const injectGoalCommand = vi.fn(async () => SENT);
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand });

    const result = await controls.setGoal('ship it', {});

    expect(injectGoalCommand).toHaveBeenCalledWith('/goal ship it');
    expect(result).toBeUndefined();
  });

  it('injects `/goal clear` when an active session clears its goal', async () => {
    const injectGoalCommand = vi.fn(async () => SENT);
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand });

    await controls.clearGoal();

    expect(injectGoalCommand).toHaveBeenCalledWith('/goal clear');
  });

  it('removes the goal work-state after the clear inject reaches the terminal (Claude emits no clear goal_status)', async () => {
    const injectGoalCommand = vi.fn(async () => SENT);
    const clearGoalWorkState = vi.fn();
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand, clearGoalWorkState });

    const result = await controls.clearGoal();

    expect(injectGoalCommand).toHaveBeenCalledWith('/goal clear');
    expect(clearGoalWorkState).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it('does NOT remove the goal work-state when the clear delivery stays below the threshold', async () => {
    const injectGoalCommand = vi.fn(async () => QUEUED);
    const clearGoalWorkState = vi.fn();
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand, clearGoalWorkState });

    const result = await controls.clearGoal();

    expect(clearGoalWorkState).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_inject_failed' });
  });

  it('does NOT remove the goal work-state when the clear inject fails (goal may still be pursued)', async () => {
    const injectGoalCommand = vi.fn(async () => {
      throw new Error('arbiter dead');
    });
    const clearGoalWorkState = vi.fn();
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand, clearGoalWorkState });

    const result = await controls.clearGoal();

    expect(clearGoalWorkState).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_inject_failed' });
  });

  it('treats a work-state removal failure as non-fatal (the clear inject already happened)', async () => {
    const injectGoalCommand = vi.fn(async () => SENT);
    const clearGoalWorkState = vi.fn(() => {
      throw new Error('publish failed');
    });
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand, clearGoalWorkState });

    const result = await controls.clearGoal();

    expect(clearGoalWorkState).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it('does not inject and returns an error result when no objective is available', async () => {
    const injectGoalCommand = vi.fn(async () => SENT);
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand });

    const result = await controls.setGoal(undefined);

    expect(injectGoalCommand).not.toHaveBeenCalled();
    expect((result as { ok?: boolean }).ok).toBe(false);
  });

  // H4-CLI: a failed `/goal` injection must surface as a TYPED non-fallback error
  // (never a raw throw that the goal router would treat as a fallback trigger and
  // then seed a decorative metadata goal the running session never actually pursued).
  it('returns a typed inject-failure error (not a throw) when setGoal injection fails', async () => {
    const injectGoalCommand = vi.fn(async () => {
      throw new Error('arbiter dead');
    });
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand });

    const result = await controls.setGoal('finish the goal feature');

    expect(injectGoalCommand).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_inject_failed' });
  });

  it('returns a typed inject-failure error (not a throw) when clearGoal injection fails', async () => {
    const injectGoalCommand = vi.fn(async () => {
      throw new Error('arbiter dead');
    });
    const controls = createClaudeGoalRuntimeControls({ injectGoalCommand });

    const result = await controls.clearGoal();

    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_inject_failed' });
  });
});
