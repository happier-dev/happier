import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeUnifiedTuiControlController } from './controller.js';
import { createFakeControlPort, type FakeControlPort } from './fakeControlPort.js';
import { createClaudeSettingsGuard, type SettingsGuard } from './settingsGuard.js';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS, type ClaudeTuiControlControllerDeps } from './types.js';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeGuard(): Promise<SettingsGuard> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-controller-'));
  tempRoots.push(dir);
  await writeFile(join(dir, 'settings.json'), '{}', 'utf8');
  return createClaudeSettingsGuard({ configDir: dir });
}

async function controllerFor(port: FakeControlPort, overrides?: Partial<ClaudeTuiControlControllerDeps>) {
  const deps: ClaudeTuiControlControllerDeps = {
    port,
    featureEnabled: true,
    settingsGuard: await makeGuard(),
    wait: async () => undefined,
    timings: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS,
    nowMs: () => 1000,
    ...overrides,
  };
  return createClaudeUnifiedTuiControlController(deps);
}

const IDLE = ['╭─────╮', '│ >   │', '╰─────╯', '  ? for shortcuts'].join('\n');
const ACCEPT = ['╭─────╮', '│ >   │', '╰─────╯', '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
const MODEL_OK = ['Set model to Sonnet 4.6 and saved as your default', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
const EFFORT_OK = ['Set reasoning effort to high', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
const GENERATING = ['● working', '✶ Forging… (10s · esc to interrupt)'].join('\n');

describe('createClaudeUnifiedTuiControlController — ordering and aggregation', () => {
  it('applies model → effort → permission mode in order and lets the prompt proceed', async () => {
    const port = createFakeControlPort({
      captures: [
        IDLE, IDLE, MODEL_OK, // model
        IDLE, IDLE, EFFORT_OK, // effort
        IDLE, ACCEPT, // mode cycle default → acceptEdits
      ],
    });
    const controller = await controllerFor(port);

    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: { model: 'sonnet', reasoningEffort: 'high', permissionMode: 'acceptEdits' },
      reason: 'before_prompt',
    });

    expect(outcome.status).toBe('applied');
    expect(outcome.promptMayProceed).toBe(true);
    expect(outcome.changes.map((c) => c.key)).toEqual(['model', 'reasoningEffort', 'permissionMode']);

    const modelIdx = port.sentLiteral.indexOf('/model sonnet');
    const effortIdx = port.sentLiteral.indexOf('/effort high');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(effortIdx).toBeGreaterThan(modelIdx);
    expect(port.sentKeys).toContain('ShiftTab');
    // Never uses /permissions as a mode setter.
    expect(port.sentLiteral.some((t) => t.startsWith('/permissions'))).toBe(false);
  });

  it('maps plan mode onto the sessionMode change key', async () => {
    const port = createFakeControlPort({ captures: [['╭─╮', '│ >│', '╰─╯', '  ⏸ plan mode on (shift+tab to cycle)'].join('\n')] });
    const controller = await controllerFor(port);
    const outcome = await controller.applyDesiredRuntimeConfig({ desired: { agentModeId: 'plan', permissionMode: 'default' }, reason: 'out_of_band' });
    expect(outcome.changes[0]?.key).toBe('sessionMode');
    expect(outcome.changes[0]?.status).toBe('applied');
  });

  it('applies metadata-only mode changes through the generating-safe mode-cycle window', async () => {
    const GEN_ACCEPT = ['● working', '✶ Forging… (12s · esc to interrupt)', '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
    const port = createFakeControlPort({ captures: [GENERATING, GEN_ACCEPT] });
    const controller = await controllerFor(port);

    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: { permissionMode: 'acceptEdits' },
      reason: 'out_of_band',
    });

    expect(outcome.status).toBe('applied');
    expect(outcome.promptMayProceed).toBe(true);
    expect(outcome.changes[0]).toMatchObject({
      key: 'permissionMode',
      status: 'applied',
      timing: 'current_window',
    });
    expect(port.sentKeys).toEqual(['ShiftTab']);
  });

  it('reports maxThinkingTokens as unsupported without blocking the prompt', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await controllerFor(port);
    const outcome = await controller.applyDesiredRuntimeConfig({ desired: { maxThinkingTokens: 4096 } });
    expect(outcome.changes[0]).toMatchObject({ key: 'maxThinkingTokens', status: 'unsupported' });
    expect(outcome.promptMayProceed).toBe(true);
  });
});

describe('createClaudeUnifiedTuiControlController — ultracode (session-only setting)', () => {
  const ULTRACODE_OK = ['Set effort level to ultracode', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');

  it('applies ultracode via /effort ultracode under the launchOption change key', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, ULTRACODE_OK] });
    const controller = await controllerFor(port);

    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: { ultracode: true },
      reason: 'before_prompt',
    });

    expect(port.sentLiteral).toContain('/effort ultracode');
    expect(outcome.status).toBe('applied');
    expect(outcome.promptMayProceed).toBe(true);
    expect(outcome.changes[0]).toMatchObject({
      key: 'launchOption',
      requested: true,
      status: 'applied',
      effective: 'ultracode',
    });
  });

  it('orders ultracode after the effort control and skips the off-path when effort was just set', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, EFFORT_OK] });
    const controller = await controllerFor(port);

    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: { reasoningEffort: 'high', ultracode: false },
      reason: 'before_prompt',
    });

    // A single /effort command: setting an effort level already clears ultracode.
    expect(port.sentLiteral).toEqual(['/effort high']);
    expect(outcome.status).toBe('applied');
    expect(outcome.changes.map((c) => c.key)).toEqual(['reasoningEffort', 'launchOption']);
    expect(outcome.changes[1]).toMatchObject({
      key: 'launchOption',
      requested: false,
      status: 'applied',
      timing: 'skipped_already_effective',
    });
  });

  it('turns ultracode off by re-selecting an effort level (model default fallback)', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, EFFORT_OK] });
    const controller = await controllerFor(port);

    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: { ultracode: false },
      reason: 'before_prompt',
    });

    expect(port.sentLiteral).toEqual(['/effort high']);
    expect(outcome.status).toBe('applied');
    expect(outcome.changes[0]).toMatchObject({ key: 'launchOption', requested: false, status: 'applied' });
  });

  it('uses the model default effort as the ultracode-off fallback when known', async () => {
    const port = createFakeControlPort({
      captures: [
        IDLE, IDLE, MODEL_OK, // model
        IDLE, IDLE, ['Set effort level to xhigh', '╭─────╮', '│ >   │', '╰─────╯'].join('\n'),
      ],
    });
    const controller = await controllerFor(port);

    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: { model: 'claude-opus-4-7', ultracode: false },
      reason: 'before_prompt',
    });

    expect(port.sentLiteral).toEqual(['/model claude-opus-4-7', '/effort xhigh']);
    expect(outcome.status).toBe('applied');
  });

  // D15c (session cmq7pyqkj, 2026-06-12): an effort apply that fails mid-batch (e.g. TOCTOU drift)
  // must not drag the dependent ultracode-off change into the FAILED group — the "Could not apply:
  // Launch option" row was misleading. The dependent change defers to the next prompt instead.
  it('defers ultracode-off (launchOption) instead of failing it when the in-batch effort apply fails', async () => {
    // Effort control: idle pre-state, then the recapture after typing shows a turn started (TOCTOU)
    // so the effort change fails with toctou_drift_before_submit.
    const port = createFakeControlPort({ captures: [IDLE, GENERATING] });
    const controller = await controllerFor(port);

    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: { reasoningEffort: 'low', ultracode: false },
      reason: 'before_prompt',
    });

    expect(outcome.changes[0]).toMatchObject({ key: 'reasoningEffort', status: 'failed' });
    expect(outcome.changes[1]).toMatchObject({
      key: 'launchOption',
      requested: false,
      status: 'applied',
      timing: 'scheduled_for_next_prompt',
      reason: 'effort_control_not_applied',
    });
    // The batch still blocks the prompt (effort failed), but launchOption itself is not a failure.
    expect(outcome.promptMayProceed).toBe(false);
  });
});

describe('createClaudeUnifiedTuiControlController — prompt gating', () => {
  it('blocks the prompt when a required control fails (B7, C7)', async () => {
    // The command never leaves the slash picker (genuinely not delivered). A clean composer with a
    // missing confirmation is no longer a definitive failure (L2: delivered-but-unverified).
    const STUCK = ['\u256d\u2500\u2500\u256e', '\u2502 > /model son \u2502', '\u2570\u2500\u2500\u256f', '  /model \u2014 switch the active model'].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, IDLE, STUCK] });
    const controller = await controllerFor(port);
    const outcome = await controller.applyDesiredRuntimeConfig({ desired: { model: 'sonnet' } });
    expect(outcome.status).toBe('failed');
    expect(outcome.promptMayProceed).toBe(false);
  });

  it('converts a thrown control (e.g. settings lock timeout) into a failed change, not a rejected promise', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, MODEL_OK] });
    const throwingGuard: SettingsGuard = {
      async acquire() {
        throw new Error('timed out acquiring Claude settings lock');
      },
    };
    const controller = await controllerFor(port, { settingsGuard: throwingGuard });

    const outcome = await controller.applyDesiredRuntimeConfig({ desired: { model: 'sonnet' } });
    expect(outcome.status).toBe('failed');
    expect(outcome.promptMayProceed).toBe(false);
  });

  it('schedules model for next idle on a busy turn and blocks the prompt (B6)', async () => {
    const port = createFakeControlPort({ captures: [GENERATING] });
    const controller = await controllerFor(port);

    const busy = await controller.applyDesiredRuntimeConfig({ desired: { model: 'sonnet' } });
    expect(busy.changes[0]).toMatchObject({ status: 'applied', timing: 'next_idle' });
    expect(busy.promptMayProceed).toBe(false);
    expect(port.sentLiteral).toHaveLength(0);
  });

  it('re-applies a scheduled control on the next apply when the window is safe', async () => {
    const port = createFakeControlPort({ captures: [GENERATING, IDLE, IDLE, MODEL_OK] });
    const controller = await controllerFor(port);

    await controller.applyDesiredRuntimeConfig({ desired: { model: 'sonnet' } }); // busy → scheduled
    const retry = await controller.applyDesiredRuntimeConfig({ desired: {} }); // pulls pending model, now idle

    expect(retry.status).toBe('applied');
    expect(retry.promptMayProceed).toBe(true);
    expect(port.sentLiteral).toContain('/model sonnet');
  });
});

describe('createClaudeUnifiedTuiControlController — feature gate (B15)', () => {
  it('returns restart/unsupported fallbacks and never touches the terminal when disabled', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await controllerFor(port, { featureEnabled: false });

    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: { model: 'sonnet', maxThinkingTokens: 4096 },
    });

    expect(outcome.changes.find((c) => c.key === 'model')?.status).toBe('requires_restart');
    expect(outcome.changes.find((c) => c.key === 'maxThinkingTokens')?.status).toBe('unsupported');
    expect(outcome.promptMayProceed).toBe(true);
    expect(port.captureCount()).toBe(0);
    expect(port.sentLiteral).toHaveLength(0);
  });
});

describe('createClaudeUnifiedTuiControlController — lock, reconcile, dispose', () => {
  it('serializes concurrent control ops behind the terminal lock', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, MODEL_OK, IDLE, IDLE, EFFORT_OK] });
    const controller = await controllerFor(port);

    const first = controller.applyDesiredRuntimeConfig({ desired: { model: 'sonnet' } });
    expect(controller.isControlInFlight()).toBe(true);
    const second = controller.applyDesiredRuntimeConfig({ desired: { reasoningEffort: 'high' } });

    await Promise.all([first, second]);
    expect(controller.isControlInFlight()).toBe(false);
    // Serialized: model command fully precedes effort command (no interleave).
    expect(port.sentLiteral).toEqual(['/model sonnet', '/effort high']);
  });

  it('updates last-verified config from provider prompt-submit metadata', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await controllerFor(port);

    controller.reconcileAfterProviderPromptSubmit({ model: 'claude-sonnet-4-6', permissionMode: 'acceptEdits', reasoningEffort: 'high' });

    expect(controller.getLastVerifiedRuntimeConfig()).toMatchObject({
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'high',
      modeMarker: 'acceptEdits',
      verifiedAtMs: 1000,
    });
  });

  it('disposes cleanly and fails closed afterward', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await controllerFor(port);

    await controller.dispose();
    expect(controller.isControlInFlight()).toBe(false);

    const outcome = await controller.applyDesiredRuntimeConfig({ desired: { model: 'sonnet' } });
    expect(outcome.status).toBe('failed');
    expect(outcome.promptMayProceed).toBe(false);
  });
});

describe('createClaudeUnifiedTuiControlController — stuck-overlay escalation and verified skip (L5)', () => {
  const USER_DRAFT = ['╭───────────────╮', '│ > user draft  │', '╰───────────────╯'].join('\n');

  it('escalates to requires_interactive_control after bounded consecutive unsafe-overlay deferrals', async () => {
    const port = createFakeControlPort({ captures: [USER_DRAFT] });
    const controller = await controllerFor(port);

    const statuses: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const outcome = await controller.applyDesiredRuntimeConfig({
        desired: { reasoningEffort: 'medium' },
        reason: 'before_prompt',
      });
      statuses.push(`${outcome.changes[0].status}:${outcome.changes[0].timing ?? ''}`);
    }

    // Three bounded deferrals, then a single escalation that stops the blind retry loop.
    expect(statuses.slice(0, 3)).toEqual([
      'applied:queued_until_safe_window',
      'applied:queued_until_safe_window',
      'applied:queued_until_safe_window',
    ]);
    expect(statuses[3]).toBe('requires_interactive_control:');
    expect(port.sentLiteral).toHaveLength(0);
  });

  it('resets the escalation counter once a safe window resolves the control', async () => {
    const EFFORT_MEDIUM = ['Set effort level to medium', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
    const port = createFakeControlPort({ captures: [USER_DRAFT, USER_DRAFT, IDLE, IDLE, EFFORT_MEDIUM] });
    const controller = await controllerFor(port);

    await controller.applyDesiredRuntimeConfig({ desired: { reasoningEffort: 'medium' } });
    await controller.applyDesiredRuntimeConfig({ desired: { reasoningEffort: 'medium' } });
    const resolved = await controller.applyDesiredRuntimeConfig({ desired: { reasoningEffort: 'medium' } });

    expect(resolved.status).toBe('applied');
    expect(resolved.changes[0].effective).toBe('medium');
  });

  it('skips a control whose requested value already matches the verified config (no TUI bytes)', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await controllerFor(port);
    controller.reconcileAfterProviderPromptSubmit({ reasoningEffort: 'medium', permissionMode: 'acceptEdits' });

    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: { reasoningEffort: 'medium', permissionMode: 'acceptEdits' },
      reason: 'before_prompt',
    });

    expect(outcome.status).toBe('applied');
    expect(outcome.promptMayProceed).toBe(true);
    expect(outcome.changes.map((c) => `${c.key}:${c.timing}`)).toEqual([
      'reasoningEffort:skipped_already_effective',
      'permissionMode:skipped_already_effective',
    ]);
    expect(port.sentLiteral).toHaveLength(0);
    expect(port.sentKeys).toHaveLength(0);
    expect(port.captureCount()).toBe(0);
  });
});

describe('createClaudeUnifiedTuiControlController — effort dialog declined/confirmed (incident cmq8y3nlx, L6)', () => {
  const EFFORT_DIALOG = [
    '❯ /effort high',
    '   Change effort level?',
    '   This conversation is cached for the current effort level. Switching to high means the full history gets',
    '   re-read on your next message.',
    '   ❯ 1. Yes, switch to high',
    '     2. No, go back',
  ].join('\n');
  const EFFORT_KEPT = ['❯ /effort high', '  ⎿  Kept effort level as low', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
  const EFFORT_SET_HIGH = ['❯ /effort high', '  ⎿  Set effort level to high (saved as your default for new sessions): Comprehensive', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');

  it('escalates repeated dialog-declined failures once to requires_interactive_control (L5 composition)', async () => {
    const attempt = [IDLE, IDLE, EFFORT_DIALOG, EFFORT_KEPT];
    const port = createFakeControlPort({ captures: [...attempt, ...attempt, ...attempt, ...attempt] });
    const controller = await controllerFor(port);

    const statuses: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const outcome = await controller.applyDesiredRuntimeConfig({
        desired: { reasoningEffort: 'high' },
        reason: 'before_prompt',
      });
      statuses.push(`${outcome.changes[0].status}:${outcome.changes[0].reason ?? ''}`);
      expect(outcome.promptMayProceed).toBe(false);
    }

    expect(statuses.slice(0, 3)).toEqual([
      'failed:effort_change_declined_by_dialog_default',
      'failed:effort_change_declined_by_dialog_default',
      'failed:effort_change_declined_by_dialog_default',
    ]);
    expect(statuses[3]).toBe('requires_interactive_control:stuck_dialog_decline:effort_change_declined_by_dialog_default');
  });

  it('updates lastVerified after a dialog-confirmed switch so the next apply converges without TUI bytes (L5d)', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, EFFORT_DIALOG, EFFORT_SET_HIGH] });
    const controller = await controllerFor(port);

    const first = await controller.applyDesiredRuntimeConfig({ desired: { reasoningEffort: 'high' }, reason: 'before_prompt' });
    expect(first.changes[0]).toMatchObject({ status: 'applied', effective: 'high' });

    const capturesAfterFirst = port.captureCount();
    const second = await controller.applyDesiredRuntimeConfig({ desired: { reasoningEffort: 'high' }, reason: 'before_prompt' });
    expect(second.changes[0]?.timing).toBe('skipped_already_effective');
    expect(port.captureCount()).toBe(capturesAfterFirst);
  });
});

describe('createClaudeUnifiedTuiControlController — control-command echo registration (L3)', () => {
  it('reports submitted slash commands through onControlCommandTyped', async () => {
    const typed: string[] = [];
    const port = createFakeControlPort({ captures: [IDLE, IDLE, MODEL_OK, IDLE, IDLE, EFFORT_OK] });
    const controller = await controllerFor(port, {
      onControlCommandTyped: (commandText) => {
        typed.push(commandText);
      },
    });

    await controller.applyDesiredRuntimeConfig({ desired: { model: 'sonnet', reasoningEffort: 'high' } });

    expect(typed).toEqual(['/model sonnet', '/effort high']);
  });

  it('does not report a command that was never submitted (busy window)', async () => {
    const typed: string[] = [];
    const port = createFakeControlPort({ captures: [GENERATING] });
    const controller = await controllerFor(port, {
      onControlCommandTyped: (commandText) => {
        typed.push(commandText);
      },
    });

    await controller.applyDesiredRuntimeConfig({ desired: { model: 'sonnet' } });

    expect(typed).toEqual([]);
  });
});

describe('createClaudeUnifiedTuiControlController — type-time own-text registration (ported S-7)', () => {
  it('reports typed command text through onControlCommandTextEntered even when never submitted', async () => {
    const entered: string[] = [];
    const submitted: string[] = [];
    // IDLE safe window, then a user draft appears between typing and submit (TOCTOU abort).
    const USER_DRAFT = ['\u256d\u2500\u2500\u2500\u256e', '\u2502 > my own text \u2502', '\u2570\u2500\u2500\u2500\u256f'].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, USER_DRAFT] });
    const controller = await controllerFor(port, {
      onControlCommandTextEntered: (commandText) => {
        entered.push(commandText);
      },
      onControlCommandTyped: (commandText) => {
        submitted.push(commandText);
      },
    });

    await controller.applyDesiredRuntimeConfig({ desired: { model: 'sonnet' } });

    expect(entered).toEqual(['/model sonnet']);
    expect(submitted).toEqual([]);
  });
});

describe('createClaudeUnifiedTuiControlController — applyPermissionModeInFlight (lane Q)', () => {
  const GEN_ACCEPT = ['● working', '✶ Forging… (12s · esc to interrupt)', '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
  const GEN_TRUST_PROMPT = [
    '✶ Forging… (10s · esc to interrupt)',
    'Do you trust the files in this folder?',
    '1. Yes',
  ].join('\n');

  it('applies a permission-mode delta mid-generation via verified ShiftTab (probe Q-A)', async () => {
    const port = createFakeControlPort({ captures: [GENERATING, GEN_ACCEPT] });
    const controller = await controllerFor(port);

    const outcome = await controller.applyPermissionModeInFlight({ permissionMode: 'acceptEdits' });

    expect(outcome.status).toBe('applied');
    expect(outcome.promptMayProceed).toBe(true);
    expect(outcome.changes.map((c) => c.key)).toEqual(['permissionMode']);
    expect(port.sentKeys).toEqual(['ShiftTab']);
    expect(port.sentLiteral).toHaveLength(0);
  });

  it('does not flush pending next-idle model/effort stashes mid-turn', async () => {
    const port = createFakeControlPort({ captures: [GENERATING, GEN_ACCEPT] });
    const controller = await controllerFor(port);
    controller.scheduleDesiredRuntimeConfig({ desired: { model: 'sonnet' } });

    const outcome = await controller.applyPermissionModeInFlight({ permissionMode: 'acceptEdits' });

    expect(outcome.promptMayProceed).toBe(true);
    expect(port.sentLiteral.some((text) => text.startsWith('/model'))).toBe(false);
  });

  it('reports a blocked apply on a steer-veto screen without pressing keys', async () => {
    const port = createFakeControlPort({ captures: [GEN_TRUST_PROMPT] });
    const controller = await controllerFor(port);

    const outcome = await controller.applyPermissionModeInFlight({ permissionMode: 'acceptEdits' });

    expect(outcome.promptMayProceed).toBe(false);
    expect(port.sentKeys).toHaveLength(0);
  });
});

describe('createClaudeUnifiedTuiControlController — reconcileFromStatusline (lane Y effective-truth feed)', () => {
  it('folds statusline model/effort into lastVerified without touching the mode marker', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await controllerFor(port);

    controller.reconcileFromStatusline({ model: 'claude-fable-5', reasoningEffort: 'high' });

    expect(controller.getLastVerifiedRuntimeConfig()).toEqual({
      model: 'claude-fable-5',
      reasoningEffort: 'high',
      modeMarker: null,
      verifiedAtMs: 1000,
    });
    // Effective-truth feed only: zero TUI bytes.
    expect(port.sentLiteral).toHaveLength(0);
    expect(port.sentKeys).toHaveLength(0);
  });

  it('short-circuits a then-matching desired change as already_effective with zero TUI bytes', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await controllerFor(port);
    controller.reconcileFromStatusline({ model: 'claude-fable-5', reasoningEffort: 'high' });

    const outcome = await controller.applyDesiredRuntimeConfig({
      desired: { model: 'claude-fable-5', reasoningEffort: 'high' },
      reason: 'before_prompt',
    });

    expect(outcome.status).toBe('applied');
    expect(outcome.promptMayProceed).toBe(true);
    expect(outcome.changes.map((c) => `${c.key}:${c.timing}`)).toEqual([
      'model:skipped_already_effective',
      'reasoningEffort:skipped_already_effective',
    ]);
    expect(port.sentLiteral).toHaveLength(0);
    expect(port.sentKeys).toHaveLength(0);
    expect(port.captureCount()).toBe(0);
  });

  it('ignores absent fields (haiku omits effort) and a fully-empty update is a no-op', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await controllerFor(port);
    controller.reconcileAfterProviderPromptSubmit({ reasoningEffort: 'high', permissionMode: 'acceptEdits' });

    controller.reconcileFromStatusline({ model: 'claude-haiku-4-5' });
    expect(controller.getLastVerifiedRuntimeConfig()).toMatchObject({
      model: 'claude-haiku-4-5',
      reasoningEffort: 'high',
      modeMarker: 'acceptEdits',
    });

    const before = controller.getLastVerifiedRuntimeConfig();
    controller.reconcileFromStatusline({});
    expect(controller.getLastVerifiedRuntimeConfig()).toEqual(before);
  });

  it('composes with a later provider prompt-submit reconcile without regressing statusline facts', async () => {
    const port = createFakeControlPort({ captures: [IDLE] });
    const controller = await controllerFor(port);

    controller.reconcileFromStatusline({ model: 'claude-fable-5', reasoningEffort: 'xhigh' });
    controller.reconcileAfterProviderPromptSubmit({ model: 'claude-fable-5', permissionMode: 'plan' });

    expect(controller.getLastVerifiedRuntimeConfig()).toMatchObject({
      model: 'claude-fable-5',
      reasoningEffort: 'xhigh',
      modeMarker: 'plan',
    });
  });
});
