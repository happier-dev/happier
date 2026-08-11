import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { EnhancedMode } from '../loop';
import {
  createBlockedApplyStarvationTracker,
  createClaudeUnifiedRuntimeControlBridge,
  DEFAULT_BLOCKED_APPLY_STARVATION_THRESHOLD,
  mapEnhancedModeToDesiredRuntimeConfig,
  resolveBlockedApplyRetryMs,
  type ClaudeUnifiedRuntimeConfigOutcomeEvent,
} from './runtimeControlIntegration';
import { createClaudeUnifiedTuiControlController } from './tuiControls/controller';
import { createFakeControlPort, type FakeControlPort } from './tuiControls/fakeControlPort';
import { createClaudeSettingsGuard, type SettingsGuard } from './tuiControls/settingsGuard';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './tuiControls/types';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const IDLE = ['╭─────╮', '│ >   │', '╰─────╯', '  ? for shortcuts'].join('\n');
const ACCEPT = ['╭─────╮', '│ >   │', '╰─────╯', '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
const MODEL_OK = ['Set model to Sonnet 4.6 and saved as your default', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
const PLAN = ['╭─╮', '│ >│', '╰─╯', '  ⏸ plan mode on (shift+tab to cycle)'].join('\n');
const GENERATING = ['● working', '✶ Forging… (10s · esc to interrupt)'].join('\n');
const USER_DRAFT = ['╭─────╮', '│ > unsent terminal draft', '╰─────╯'].join('\n');

async function makeGuard(): Promise<SettingsGuard> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-runtime-bridge-'));
  tempRoots.push(dir);
  await writeFile(join(dir, 'settings.json'), '{}', 'utf8');
  return createClaudeSettingsGuard({ configDir: dir });
}

async function makeController(port: FakeControlPort, featureEnabled = true) {
  return createClaudeUnifiedTuiControlController({
    port,
    featureEnabled,
    settingsGuard: await makeGuard(),
    wait: async () => undefined,
    timings: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS,
    nowMs: () => 1000,
  });
}

function mode(overrides: Partial<EnhancedMode>): EnhancedMode {
  return { permissionMode: 'default', ...overrides };
}

describe('mapEnhancedModeToDesiredRuntimeConfig', () => {
  it('maps the generic runtime-control fields off the queued message mode', () => {
    const desired = mapEnhancedModeToDesiredRuntimeConfig(
      mode({ model: 'opus', reasoningEffort: 'high', permissionMode: 'acceptEdits', agentModeId: 'plan', claudeRemoteMaxThinkingTokens: 4096 }),
    );
    expect(desired).toEqual({
      model: 'opus',
      reasoningEffort: 'high',
      permissionMode: 'acceptEdits',
      agentModeId: 'plan',
      maxThinkingTokens: 4096,
    });
  });

  it('omits blank model/effort strings', () => {
    const desired = mapEnhancedModeToDesiredRuntimeConfig(mode({ model: '   ', reasoningEffort: '' }));
    expect(desired.model).toBeUndefined();
    expect(desired.reasoningEffort).toBeUndefined();
  });

  it('clamps a discovered model effort to the highest evidenced supported tier', () => {
    const desired = mapEnhancedModeToDesiredRuntimeConfig(mode({
      model: 'claude-opus-9',
      reasoningEffort: 'max',
      modelEffortLevels: ['low', 'medium'],
      modelEffortLevelsModelId: 'claude-opus-9',
    }));

    expect(desired.reasoningEffort).toBe('medium');
  });

  it('maps ultracode gated by xhigh capability of the mode model', () => {
    expect(mapEnhancedModeToDesiredRuntimeConfig(mode({ model: 'claude-fable-5', ultracode: true })).ultracode).toBe(true);
    // Requested but not honorable on this model → resolved off.
    expect(mapEnhancedModeToDesiredRuntimeConfig(mode({ model: 'claude-sonnet-4-6', ultracode: true })).ultracode).toBe(false);
    expect(mapEnhancedModeToDesiredRuntimeConfig(mode({ model: 'claude-fable-5', ultracode: false })).ultracode).toBe(false);
    // No opinion → undefined (no control attempted).
    expect(mapEnhancedModeToDesiredRuntimeConfig(mode({ model: 'claude-fable-5' })).ultracode).toBeUndefined();
  });
});

describe('resolveBlockedApplyRetryMs (L5(a) bounded backoff)', () => {
  it('grows exponentially from the base and saturates at the cap', () => {
    expect(resolveBlockedApplyRetryMs(1, 250)).toBe(250);
    expect(resolveBlockedApplyRetryMs(2, 250)).toBe(500);
    expect(resolveBlockedApplyRetryMs(3, 250)).toBe(1_000);
    expect(resolveBlockedApplyRetryMs(7, 250)).toBe(15_000);
    expect(resolveBlockedApplyRetryMs(50, 250)).toBe(15_000);
  });

  it('never returns less than the base and respects a custom cap', () => {
    expect(resolveBlockedApplyRetryMs(0, 250)).toBe(250);
    expect(resolveBlockedApplyRetryMs(4, 100, 300)).toBe(300);
  });
});

describe('createBlockedApplyStarvationTracker (F2 stuck-unsafe-window honesty)', () => {
  it('fires ONCE per starvation episode after the bounded threshold of consecutive blocked applies', () => {
    const calls: Array<Readonly<{ consecutiveBlockedApplies: number; blockedReason: string | null }>> = [];
    const tracker = createBlockedApplyStarvationTracker({
      threshold: 3,
      onStarvation: (info) => calls.push({
        consecutiveBlockedApplies: info.consecutiveBlockedApplies,
        blockedReason: info.blockedReason ?? null,
      }),
    });
    expect(tracker.recordBlocked('user_draft')).toBe(1);
    expect(tracker.recordBlocked('user_draft')).toBe(2);
    expect(calls).toEqual([]);
    expect(tracker.recordBlocked('user_draft')).toBe(3);
    expect(calls).toEqual([{ consecutiveBlockedApplies: 3, blockedReason: 'user_draft' }]);
    // Continued starvation never re-fires within the same episode (no notice loop).
    tracker.recordBlocked('user_draft');
    tracker.recordBlocked('user_draft');
    expect(calls).toEqual([{ consecutiveBlockedApplies: 3, blockedReason: 'user_draft' }]);
  });

  it('resets the episode on a successful apply so a NEW starvation episode escalates again', () => {
    const calls: number[] = [];
    const tracker = createBlockedApplyStarvationTracker({
      threshold: 2,
      onStarvation: (info) => calls.push(info.consecutiveBlockedApplies),
    });
    tracker.recordBlocked();
    tracker.recordBlocked();
    expect(calls).toEqual([2]);
    tracker.reset();
    expect(tracker.recordBlocked()).toBe(1);
    expect(calls).toEqual([2]);
    tracker.recordBlocked();
    expect(calls).toEqual([2, 2]);
  });

  it('defaults to a threshold that aligns with the bounded backoff (≈15s of starvation)', () => {
    const calls: number[] = [];
    const tracker = createBlockedApplyStarvationTracker({
      onStarvation: (info) => calls.push(info.consecutiveBlockedApplies),
    });
    for (let i = 0; i < DEFAULT_BLOCKED_APPLY_STARVATION_THRESHOLD - 1; i += 1) tracker.recordBlocked();
    expect(calls).toEqual([]);
    tracker.recordBlocked();
    expect(calls).toEqual([DEFAULT_BLOCKED_APPLY_STARVATION_THRESHOLD]);
  });
});

describe('createClaudeUnifiedRuntimeControlBridge', () => {
  it('applies an ultracode change before the prompt and emits a launchOption outcome', async () => {
    const ULTRACODE_OK = ['Set effort level to ultracode', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, IDLE, ULTRACODE_OK] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'claude-fable-5' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ model: 'claude-fable-5', ultracode: true }));

    expect(result.promptMayProceed).toBe(true);
    expect(port.sentLiteral).toContain('/effort ultracode');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'applied',
      changes: [expect.objectContaining({ key: 'launchOption', requested: true, effective: 'ultracode' })],
    });
  });

  it('does not re-apply or emit when the desired config equals the launch-baked startup config', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet', permissionMode: 'default' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ model: 'sonnet', permissionMode: 'default' }));

    expect(result).toEqual({ promptMayProceed: true, attempted: false });
    expect(events).toHaveLength(0);
    // No control bytes typed because nothing changed versus the spawn config.
    expect(port.sentLiteral).toHaveLength(0);
  });

  it('verifies a non-default startup-claimed permission mode on-screen instead of silently trusting the launch flag (F5)', async () => {
    // Live incident (QA-B session cmqakh8mb): the spawn baked `--permission-mode auto` (safe-yolo)
    // but claude silently ignored it and ran in `default`; the old startup-committed baseline then
    // skipped every later safe-yolo request, so the session diverged silently and forever.
    const port = createFakeControlPort({ captures: [IDLE, ACCEPT] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ permissionMode: 'safe-yolo' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ permissionMode: 'safe-yolo' }));

    expect(result).toEqual({ promptMayProceed: true, attempted: true });
    // The screen showed `default`: the launch claim was repaired via verified ShiftTab cycling
    // and the divergence repair is reported honestly.
    expect(port.sentKeys).toEqual(['ShiftTab']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'applied',
      changes: [expect.objectContaining({ key: 'permissionMode', requested: 'safe-yolo', effective: 'acceptEdits' })],
    });
  });

  it('confirms a startup-claimed mode silently when the screen already shows it (F5, zero keystrokes, no event)', async () => {
    const AUTO_SCREEN = ['╭─────╮', '│ >   │', '╰─────╯', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');
    const port = createFakeControlPort({ captures: [AUTO_SCREEN] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ permissionMode: 'safe-yolo' }),
    });

    const first = await bridge.applyBeforePrompt(mode({ permissionMode: 'safe-yolo' }));
    expect(first.promptMayProceed).toBe(true);
    // The claim IS verified (one screen capture), just confirmed without typing.
    expect(port.captureCount()).toBe(1);
    expect(port.sentKeys).toHaveLength(0);
    expect(port.sentLiteral).toHaveLength(0);
    // Confirmation of the launch claim is NOT user feedback — no transcript event.
    expect(events).toHaveLength(0);

    // Once verified, the claim is committed: the next identical prompt mode is a no-op.
    const captureCountAfterFirst = port.captureCount();
    const second = await bridge.applyBeforePrompt(mode({ permissionMode: 'safe-yolo' }));
    expect(second).toEqual({ promptMayProceed: true, attempted: false });
    expect(port.captureCount()).toBe(captureCountAfterFirst);
  });

  it('keeps the legacy zero-capture fast path when the startup claim is the default mode (F5 scope guard)', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet', permissionMode: 'default' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ model: 'sonnet', permissionMode: 'default' }));

    expect(result).toEqual({ promptMayProceed: true, attempted: false });
    expect(events).toHaveLength(0);
    expect(port.captureCount()).toBe(0);
  });

  it('does not type /effort when the launch-baked startup mode already carries the persisted effort (incident cmq7pyqkj, U2 baseline)', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet', reasoningEffort: 'medium' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));

    expect(result).toEqual({ promptMayProceed: true, attempted: false });
    expect(events).toHaveLength(0);
    expect(port.sentLiteral).toHaveLength(0);
    expect(port.captureCount()).toBe(0);
  });

  it('skips a resume re-apply with zero TUI bytes when the screen already shows the persisted effort (incident cmq7pyqkj, U2)', async () => {
    // Resume spawn that failed to carry the persisted effort (the launch-arg half is owned by the
    // spawn path): the screen still re-renders this conversation's effort confirmation, which must
    // satisfy the control without typing a redundant `/effort medium`.
    const RESUMED = [
      '❯ /effort medium',
      '  ⎿  Set effort level to medium (saved as your default for new sessions)',
      '╭─────╮',
      '│ >   │',
      '╰─────╯',
    ].join('\n');
    const port = createFakeControlPort({ captures: [RESUMED] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));

    expect(result).toEqual({ promptMayProceed: true, attempted: true });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
    expect(events[0]).toMatchObject({
      status: 'applied',
      timing: 'skipped_already_effective',
      changes: [expect.objectContaining({ key: 'reasoningEffort', requested: 'medium', effective: 'medium' })],
    });
  });

  it('applies a model change before the prompt and emits an applied runtime-config-outcome', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, MODEL_OK] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ model: 'opus' }));

    expect(result.promptMayProceed).toBe(true);
    expect(port.sentLiteral).toContain('/model opus');
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('applied');
    expect(events[0].changes.map((c) => c.key)).toEqual(['model']);
  });

  it('downgrades the sessionMode change key to permissionMode when emission is gated off (default)', async () => {
    const port = createFakeControlPort({ captures: [PLAN] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ permissionMode: 'default' }),
    });

    await bridge.applyBeforePrompt(mode({ agentModeId: 'plan', permissionMode: 'default' }));

    expect(events).toHaveLength(1);
    // Old clients reject the widened `sessionMode` change-key enum, so plan-mode outcomes ride permissionMode.
    expect(events[0].changes.map((c) => c.key)).toEqual(['permissionMode']);
  });

  it('emits the sessionMode change key when emission is explicitly enabled', async () => {
    const port = createFakeControlPort({ captures: [PLAN] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      sessionModeEmissionEnabled: true,
      startupMode: mode({ permissionMode: 'default' }),
    });

    await bridge.applyBeforePrompt(mode({ agentModeId: 'plan', permissionMode: 'default' }));

    expect(events).toHaveLength(1);
    expect(events[0].changes.map((c) => c.key)).toEqual(['sessionMode']);
  });

  it('reports a max-thinking change as an unsupported outcome without blocking the prompt', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({}),
    });

    const result = await bridge.applyBeforePrompt(mode({ claudeRemoteMaxThinkingTokens: 4096 }));

    expect(result.promptMayProceed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('unsupported');
    expect(events[0].changes.map((c) => c.key)).toEqual(['maxThinkingTokens']);
  });

  it('does not block the prompt when an ambient model change is deferred to next idle', async () => {
    // First attempt: TUI is generating → model slash command is scheduled for next idle, but model is
    // an ambient next-turn default and must not hold the user's current message hostage.
    // Second attempt: TUI is idle → model applies and the prompt may proceed.
    const port = createFakeControlPort({ captures: [GENERATING, IDLE, IDLE, MODEL_OK] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet' }),
    });

    const blocked = await bridge.applyBeforePrompt(mode({ model: 'opus' }));
    expect(blocked.promptMayProceed).toBe(true);
    expect(blocked.attempted).toBe(true);
    expect(blocked).not.toHaveProperty('blockedReason');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'applied',
      timing: 'next_idle',
      changes: [expect.objectContaining({ key: 'model', requested: 'opus', reason: 'generating' })],
    });

    // Baseline must NOT have committed, so the same ambient change is re-attempted at the next idle.
    const retried = await bridge.applyBeforePrompt(mode({ model: 'opus' }));
    expect(retried.promptMayProceed).toBe(true);
    expect(port.sentLiteral).toContain('/model opus');
  });

  it('does not block the prompt when an ambient effort change is deferred during a busy turn', async () => {
    const EFFORT_OK = ['Set effort level to medium', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
    const port = createFakeControlPort({ captures: [GENERATING, IDLE, IDLE, EFFORT_OK] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet', reasoningEffort: 'high' }),
    });

    const deferred = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));
    expect(deferred).toEqual({ promptMayProceed: true, attempted: true });
    expect(port.sentLiteral).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'applied',
      timing: 'next_idle',
      changes: [expect.objectContaining({ key: 'reasoningEffort', requested: 'medium', reason: 'generating' })],
    });

    const retried = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));
    expect(retried.promptMayProceed).toBe(true);
    expect(port.sentLiteral).toContain('/effort medium');
  });

  it('does not block the prompt when an ambient effort change was delivered but not verified', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, IDLE] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet', reasoningEffort: 'high' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));

    expect(result).toEqual({
      promptMayProceed: true,
      attempted: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'applied',
      timing: 'queued_until_safe_window',
      changes: [expect.objectContaining({ key: 'reasoningEffort', requested: 'medium', reason: 'delivered_unverified' })],
    });
  });

  it('reports requires_interactive_control and blocks the prompt when a mode is not cycle-reachable', async () => {
    // default → (acceptEdits) → back to default (already visited) before reaching bypassPermissions → unreachable.
    const port = createFakeControlPort({ captures: [IDLE, ACCEPT, IDLE] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ permissionMode: 'default' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ permissionMode: 'bypassPermissions' }));

    expect(result.promptMayProceed).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('requires_interactive_control');
    expect(events[0].changes.map((c) => c.key)).toEqual(['permissionMode']);
  });

  it('preserves the user-draft blocker reason when a before-prompt mode change cannot apply', async () => {
    const port = createFakeControlPort({ captures: [USER_DRAFT] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ permissionMode: 'default' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ permissionMode: 'acceptEdits' }));

    expect(result).toEqual({
      promptMayProceed: false,
      attempted: true,
      blockedReason: 'user_draft',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'applied',
      timing: 'queued_until_safe_window',
      changes: [expect.objectContaining({ key: 'permissionMode', reason: 'user_draft' })],
    });
  });

  it('still blocks the prompt when a dependent permission-mode delta is deferred by a user draft', async () => {
    const port = createFakeControlPort({ captures: [USER_DRAFT] });
    const controller = await makeController(port);
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: () => undefined,
      startupMode: mode({ permissionMode: 'default', reasoningEffort: 'high' }),
    });

    const result = await bridge.applyBeforePrompt(mode({
      permissionMode: 'acceptEdits',
      reasoningEffort: 'medium',
    }));

    expect(result).toEqual({
      promptMayProceed: false,
      attempted: true,
      blockedReason: 'user_draft',
    });
  });

  it('keeps a previously deferred ambient effort out of a later dependent permission gate', async () => {
    const port = createFakeControlPort({ captures: [GENERATING, USER_DRAFT] });
    const controller = await makeController(port);
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: () => undefined,
      startupMode: mode({ model: 'sonnet', permissionMode: 'default', reasoningEffort: 'high' }),
    });

    const deferredAmbient = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));
    expect(deferredAmbient).toEqual({ promptMayProceed: true, attempted: true });

    const dependent = await bridge.applyBeforePrompt(mode({
      permissionMode: 'acceptEdits',
      model: 'sonnet',
      reasoningEffort: 'medium',
    }));

    expect(dependent).toEqual({
      promptMayProceed: false,
      attempted: true,
      blockedReason: 'user_draft',
    });
    expect(port.sentLiteral).toHaveLength(0);
  });

  it('preserves the root user-draft blocker reason after stuck unsafe-window escalation', async () => {
    const port = createFakeControlPort({ captures: [USER_DRAFT, USER_DRAFT, USER_DRAFT, USER_DRAFT] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ permissionMode: 'default' }),
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await bridge.applyBeforePrompt(mode({ permissionMode: 'acceptEdits' }));
      expect(result).toMatchObject({ promptMayProceed: false, blockedReason: 'user_draft' });
    }

    const escalated = await bridge.applyBeforePrompt(mode({ permissionMode: 'acceptEdits' }));

    expect(escalated).toEqual({
      promptMayProceed: false,
      attempted: true,
      blockedReason: 'user_draft',
    });
    expect(events.at(-1)).toMatchObject({
      status: 'requires_interactive_control',
      changes: [expect.objectContaining({ key: 'permissionMode', reason: 'stuck_unsafe_window:user_draft' })],
    });
  });

  it('falls back to restart-only outcomes when the feature gate is disabled', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await makeController(port, false);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet' }),
    });

    const result = await bridge.applyBeforePrompt(mode({ model: 'opus' }));

    // Gate off → no live control, existing restart-notice path still proceeds with the prompt.
    expect(result.promptMayProceed).toBe(true);
    expect(port.sentLiteral).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('requires_restart');
  });

  it('applies metadata-only permission mode changes out of band and commits the runtime baseline', async () => {
    const port = createFakeControlPort({ captures: [IDLE, ACCEPT] });
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller: await makeController(port),
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ permissionMode: 'default' }),
    });

    const result = await bridge.applyOutOfBand(mode({ permissionMode: 'acceptEdits' }));

    expect(result).toEqual({ promptMayProceed: true, attempted: true });
    expect(port.sentKeys).toEqual(['ShiftTab']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'applied',
      changes: [expect.objectContaining({ key: 'permissionMode', requested: 'acceptEdits' })],
    });

    const beforePrompt = await bridge.applyBeforePrompt(mode({ permissionMode: 'acceptEdits' }));
    expect(beforePrompt).toEqual({ promptMayProceed: true, attempted: false });
  });

  it('applies metadata-only permission mode changes during generation with the mode-cycle window', async () => {
    const GENERATING_ACCEPT = ['● working', '✶ Forging… (12s · esc to interrupt)', '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
    const port = createFakeControlPort({ captures: [GENERATING, GENERATING_ACCEPT] });
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller: await makeController(port),
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ permissionMode: 'default' }),
    });

    const result = await bridge.applyOutOfBand(mode({ permissionMode: 'acceptEdits' }));

    expect(result).toEqual({ promptMayProceed: true, attempted: true });
    expect(port.sentKeys).toEqual(['ShiftTab']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'applied',
      changes: [expect.objectContaining({
        key: 'permissionMode',
        requested: 'acceptEdits',
        effective: 'acceptEdits',
      })],
    });
    expect((events[0]?.changes[0] as { timing?: unknown } | undefined)?.timing ?? null).toBeNull();

    const beforePrompt = await bridge.applyBeforePrompt(mode({ permissionMode: 'acceptEdits' }));
    expect(beforePrompt).toEqual({ promptMayProceed: true, attempted: false });
  });

  it('surfaces structured restart outcomes for metadata-only changes when the runtime-control gate is disabled', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller: await makeController(port, false),
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ permissionMode: 'default' }),
    });

    const result = await bridge.applyOutOfBand(mode({ permissionMode: 'acceptEdits' }));

    expect(result).toEqual({ promptMayProceed: true, attempted: true });
    expect(port.sentKeys).toHaveLength(0);
    expect(port.sentLiteral).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'requires_restart',
      changes: [expect.objectContaining({
        key: 'permissionMode',
        requested: 'acceptEdits',
        reason: 'tui_runtime_control_disabled',
      })],
    });
  });

  // L5(b) (incident cmq8y3nlx hot loop): a re-attempted blocked apply with the SAME per-change
  // outcome must not flood the transcript — at most one event per (key,status,timing,reason)
  // until the change outcome transitions.
  it('dedupes repeated identical outcome events until the change outcome transitions', async () => {
    const USER_DRAFT = ['╭───────────────╮', '│ > user draft  │', '╰───────────────╯'].join('\n');
    const EFFORT_OK = ['Set effort level to medium', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
    // Three blocked attempts (same outcome), then a clean window where the control applies.
    const port = createFakeControlPort({
      captures: [USER_DRAFT, USER_DRAFT, USER_DRAFT, IDLE, IDLE, EFFORT_OK],
    });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet', reasoningEffort: 'high' }),
    });

    const first = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));
    expect(first.promptMayProceed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'applied', timing: 'queued_until_safe_window' });

    // Identical blocked outcomes: no new transcript events.
    await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));
    await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));
    expect(events).toHaveLength(1);

    // Transition (applied in the current window) emits exactly one new event.
    const resolved = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));
    expect(resolved.promptMayProceed).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      status: 'applied',
      changes: [expect.objectContaining({ key: 'reasoningEffort', requested: 'medium', effective: 'medium' })],
    });
  });

  // L5(d): once the verified config equals the desired config, re-attempts must stop —
  // the controller reports already-set without touching the TUI and the prompt proceeds.
  it('converges without typing controls when the verified config already matches the desired config', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ model: 'sonnet', reasoningEffort: 'high' }),
    });

    // Later evidence (UserPromptSubmit metadata) proves the desired effort is already active.
    bridge.reconcileFromPromptSubmitMetadata({ reasoningEffort: 'medium' });

    const result = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));
    expect(result.promptMayProceed).toBe(true);
    expect(port.sentLiteral).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'applied',
      timing: 'skipped_already_effective',
      changes: [expect.objectContaining({ key: 'reasoningEffort', effective: 'medium' })],
    });

    // Converged: the next prompt attempts nothing and emits nothing.
    const again = await bridge.applyBeforePrompt(mode({ model: 'sonnet', reasoningEffort: 'medium' }));
    expect(again).toEqual({ promptMayProceed: true, attempted: false });
    expect(events).toHaveLength(1);
  });

  it('forwards provider prompt-submit metadata to the controller for verified reconciliation', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await makeController(port);
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: () => undefined,
    });

    bridge.reconcileFromPromptSubmitMetadata({ model: 'claude-opus', permissionMode: 'acceptEdits' });

    const verified = controller.getLastVerifiedRuntimeConfig();
    expect(verified.model).toBe('claude-opus');
    expect(verified.modeMarker).toBe('acceptEdits');
  });
});

describe('applyPermissionModeForInFlightSteer (lane Q)', () => {
  const GEN_ACCEPT = ['● working', '✶ Forging… (12s · esc to interrupt)', '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');

  it('applies a mode-only delta mid-generation, emits the outcome event, and commits the baseline', async () => {
    const port = createFakeControlPort({ captures: [GENERATING, GEN_ACCEPT] });
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller: await makeController(port),
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({ permissionMode: 'default' }),
    });

    const outcome = await bridge.applyPermissionModeForInFlightSteer(mode({ permissionMode: 'acceptEdits' }));

    expect(outcome).toEqual({ status: 'applied' });
    expect(port.sentKeys).toEqual(['ShiftTab']);
    expect(events.some((event) => event.status === 'applied' && event.changes.some((c) => c.key === 'permissionMode'))).toBe(true);

    // Baseline committed: the turn-end before-prompt apply must not re-cycle the mode.
    const apply = await bridge.applyBeforePrompt(mode({ permissionMode: 'acceptEdits' }));
    expect(apply).toEqual({ promptMayProceed: true, attempted: false });
    expect(port.sentKeys).toEqual(['ShiftTab']);
  });

  it('reports unsupported for deltas that also change next-idle controls (model/effort)', async () => {
    const port = createFakeControlPort({ captures: [GENERATING] });
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller: await makeController(port),
      emitRuntimeConfigOutcome: () => undefined,
      startupMode: mode({ permissionMode: 'default' }),
    });

    const outcome = await bridge.applyPermissionModeForInFlightSteer(
      mode({ permissionMode: 'acceptEdits', model: 'opus' }),
    );

    expect(outcome.status).toBe('unsupported');
    expect(port.sentKeys).toHaveLength(0);
    expect(port.sentLiteral).toHaveLength(0);
  });

  it('reports applied without touching the TUI when the mode already matches the committed baseline', async () => {
    // F5: a startup-claimed mode is only committed once verified — confirm it on-screen first
    // (zero keystrokes), then the identical steer-time mode is a pure no-op.
    const port = createFakeControlPort({ captures: [ACCEPT, GENERATING] });
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller: await makeController(port),
      emitRuntimeConfigOutcome: () => undefined,
      startupMode: mode({ permissionMode: 'acceptEdits' }),
    });
    const verified = await bridge.applyBeforePrompt(mode({ permissionMode: 'acceptEdits' }));
    expect(verified.promptMayProceed).toBe(true);

    const outcome = await bridge.applyPermissionModeForInFlightSteer(mode({ permissionMode: 'acceptEdits' }));

    expect(outcome).toEqual({ status: 'applied' });
    expect(port.sentKeys).toHaveLength(0);
  });

  it('reports failed (and does not commit) when the steer-safe window is blocked', async () => {
    const TRUST_PROMPT = [
      '✶ Forging… (10s · esc to interrupt)',
      'Do you trust the files in this folder?',
      '1. Yes',
    ].join('\n');
    const port = createFakeControlPort({ captures: [TRUST_PROMPT] });
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller: await makeController(port),
      emitRuntimeConfigOutcome: () => undefined,
      startupMode: mode({ permissionMode: 'default' }),
    });

    const outcome = await bridge.applyPermissionModeForInFlightSteer(mode({ permissionMode: 'acceptEdits' }));

    expect(outcome.status).toBe('failed');
    expect(port.sentKeys).toHaveLength(0);
  });
});

describe('createClaudeUnifiedRuntimeControlBridge — statusline reconcile (lane Y)', () => {
  it('feeds statusline effective truth into the controller so a matching desired change converges with zero TUI bytes', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await makeController(port);
    const events: ClaudeUnifiedRuntimeConfigOutcomeEvent[] = [];
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: (event) => events.push(event),
      startupMode: mode({}),
    });

    // Statusline reports the runtime already runs the desired model/effort.
    bridge.reconcileFromStatusline({ model: 'claude-fable-5', reasoningEffort: 'high' });

    const result = await bridge.applyBeforePrompt(
      mode({ model: 'claude-fable-5', reasoningEffort: 'high' }),
    );

    expect(result.promptMayProceed).toBe(true);
    expect(controller.getLastVerifiedRuntimeConfig()).toMatchObject({
      model: 'claude-fable-5',
      reasoningEffort: 'high',
    });
    // Convergence: pending applies resolve skipped_already_effective — no TUI bytes.
    expect(port.sentLiteral).toHaveLength(0);
    expect(port.sentKeys).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'applied',
      timing: 'skipped_already_effective',
    });
  });
});
