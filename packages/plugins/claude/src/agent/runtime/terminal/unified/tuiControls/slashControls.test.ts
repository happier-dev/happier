import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFakeControlPort } from './fakeControlPort.js';
import { createClaudeSettingsGuard, type SettingsGuard } from './settingsGuard.js';
import { applyEffortControl, applyModelControl, type SlashControlContext } from './slashControls.js';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS, type ApplyRuntimeConfigReason } from './types.js';
import type { ControlRuntime } from './controlRuntime.js';
import type { FakeControlPort } from './fakeControlPort.js';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeGuard(): Promise<{ guard: SettingsGuard; settingsPath: string; original: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-slash-'));
  tempRoots.push(dir);
  const settingsPath = join(dir, 'settings.json');
  const original = JSON.stringify({ statusLine: { type: 'command' } });
  await writeFile(settingsPath, original, 'utf8');
  return { guard: createClaudeSettingsGuard({ configDir: dir }), settingsPath, original };
}

function runtimeFor(port: FakeControlPort): ControlRuntime {
  return {
    port,
    wait: async () => undefined,
    timings: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS,
    nowMs: () => 0,
  };
}

function contextFor(port: FakeControlPort, guard: SettingsGuard, reason: ApplyRuntimeConfigReason = 'before_prompt'): SlashControlContext {
  return { runtime: runtimeFor(port), settingsGuard: guard, reason };
}

const IDLE = ['╭─────╮', '│ >   │', '╰─────╯', '  ? for shortcuts'].join('\n');
const MODEL_CONFIRMATION = ['Set model to Sonnet 4.6 and saved as your default for new sessions', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
const SWITCH_DIALOG = ['Switch model?', '❯ 1. Yes, switch', '  2. No, go back'].join('\n');
const GENERATING = ['● working', '✶ Forging… (10s · esc to interrupt)'].join('\n');
const EFFORT_CONFIRMATION = ['Set reasoning effort to high', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');

describe('applyModelControl', () => {
  it('types /model and submits only from an idle safe window, verifying via confirmation text (B1, B9)', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, MODEL_CONFIRMATION] });
    const { guard } = await makeGuard();

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');

    expect(result).toMatchObject({ kind: 'applied', timing: 'before_next_prompt', effective: 'Sonnet 4.6' });
    expect(port.sentLiteral).toContain('/model sonnet');
    expect(port.sentKeys).toContain('Enter');
  });

  it('fires onCommandTyped at TYPE time even when the command is aborted before submit (ported S-7)', async () => {
    // RESUME2: a typed-but-never-submitted command can survive the cleanup Escape as a composer
    // leftover. Submit-only registration left that residue classified as a foreign user draft,
    // permanently blocking idle prompt injection — the own-text registry must learn the text the
    // moment it is WRITTEN, not when Enter is sent.
    const USER_DRAFT = ['\u256d\u2500\u2500\u2500\u2500\u2500\u256e', '\u2502 > my own text \u2502', '\u2570\u2500\u2500\u2500\u2500\u2500\u256f'].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, USER_DRAFT] });
    const { guard } = await makeGuard();
    const typed: string[] = [];
    const submitted: string[] = [];
    const ctx: SlashControlContext = {
      runtime: runtimeFor(port),
      settingsGuard: guard,
      reason: 'before_prompt',
      onCommandTyped: (text) => typed.push(text),
      onCommandSubmitted: (text) => submitted.push(text),
    };

    const result = await applyModelControl(ctx, 'sonnet');

    expect(result).toMatchObject({ kind: 'failed', reason: 'toctou_drift_before_submit' });
    expect(typed).toEqual(['/model sonnet']);
    expect(submitted).toEqual([]);
  });

  it('detects and answers the Switch model? confirmation dialog (B19)', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, SWITCH_DIALOG, MODEL_CONFIRMATION] });
    const { guard } = await makeGuard();

    const result = await applyModelControl(contextFor(port, guard), 'claude-sonnet-4-6');

    expect(result.kind).toBe('applied');
    expect(port.sentLiteral).toContain('/model claude-sonnet-4-6');
    // Confirms the dialog by selecting option 1 (Yes, switch).
    expect(port.sentLiteral).toContain('1');
  });

  it('refuses to type /model mid-generation and schedules for next idle (probe P-D)', async () => {
    const port = createFakeControlPort({ captures: [GENERATING] });
    const { guard } = await makeGuard();

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');

    expect(result).toMatchObject({ kind: 'scheduled', timing: 'next_idle' });
    expect(port.sentLiteral).toHaveLength(0);
    expect(port.sentKeys).toHaveLength(0);
  });

  // L2 (incident cmq8y3nlx): a submitted command with a clean composer but no confirmation within
  // the bounded verification window was DELIVERED — Claude may render the confirmation late or
  // execute the command after a queued window. It must not be reported as a definitive failure,
  // but a required prompt must not proceed until later evidence verifies the config.
  it('reports a delivered command without confirmation as deferred-unverified (never prompt-greenlighting)', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, IDLE] });
    const { guard, settingsPath, original } = await makeGuard();

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');

    expect(result).toMatchObject({
      kind: 'scheduled',
      timing: 'queued_until_safe_window',
      reason: 'delivered_unverified',
    });
    expect((result as { effective?: unknown }).effective).toBeUndefined();
    // The settings guard still restores persisted defaults on every exit.
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
    // No Escape: the command was submitted and may be executing; Escape could cancel it.
    expect(port.sentKeys).not.toContain('Escape');
  });

  it('polls past slow confirmation rendering until the confirmation appears (L2)', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, IDLE, IDLE, MODEL_CONFIRMATION] });
    const { guard } = await makeGuard();

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');

    expect(result).toMatchObject({ kind: 'applied', effective: 'Sonnet 4.6' });
  });

  it('treats a command queued by a starting turn as delivered-pending, not failed (L2)', async () => {
    const QUEUED = ['✶ Forging… (2s · esc to interrupt)', '  Press up to edit queued messages'].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, IDLE, QUEUED] });
    const { guard } = await makeGuard();

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');

    expect(result).toMatchObject({ kind: 'scheduled', timing: 'next_idle', reason: 'queued_by_provider' });
    expect(port.sentKeys).not.toContain('Escape');
  });

  it('fails and clears the composer when the command never left the slash picker (not delivered)', async () => {
    const STUCK_PICKER = [
      '╭───────────────────────╮',
      '│ > /model sonnet       │',
      '╰───────────────────────╯',
      '  /model — switch the active model',
    ].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, IDLE, STUCK_PICKER] });
    const { guard, settingsPath, original } = await makeGuard();

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');

    expect(result.kind).toBe('failed');
    expect(port.sentKeys).toContain('Escape');
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
  });

  it('restores settings when the Enter send fails after the command may have executed (host race)', async () => {
    const { guard, settingsPath, original } = await makeGuard();
    const port = createFakeControlPort({
      captures: [IDLE, IDLE],
      failSendKeys: ['Enter'],
      onSendSpecialKey: async (key) => {
        // Claude may execute the command even when the send reports a host failure: simulate the
        // durable settings mutation landing right as the Enter send dies.
        if (key === 'Enter') await writeFile(settingsPath, JSON.stringify({ model: 'sonnet' }), 'utf8');
      },
    });

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');

    expect(result.kind).toBe('failed');
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
  });

  it('restores settings when the post-Enter capture fails (host race)', async () => {
    const { guard, settingsPath, original } = await makeGuard();
    const port = createFakeControlPort({
      captures: [IDLE, IDLE],
      failCaptureAtIndexes: [2],
      onSendSpecialKey: async (key) => {
        if (key === 'Enter') await writeFile(settingsPath, JSON.stringify({ model: 'sonnet' }), 'utf8');
      },
    });

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');

    expect(result.kind).toBe('failed');
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
  });

  it('reports failed when the settings guard cannot guarantee restore', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, MODEL_CONFIRMATION] });
    // Simulate the fs-boundary guard being unable to restore (Settings Isolation Rules).
    const guard: SettingsGuard = {
      async acquire() {
        return {
          configDir: '/tmp/x',
          snapshot: [],
          async restore() {
            return { ok: false, reason: 'byte mismatch after restoring settings.json' };
          },
          async release() {
            return undefined;
          },
        };
      },
    };

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');
    expect(result.kind).toBe('failed');
    expect((result as { reason: string }).reason).toContain('settings');
  });
});

describe('unsafe-overlay recovery (incident cmq8y3nlx, L5)', () => {
  const LEFTOVER_PICKER = [
    '╭───────────────────────╮',
    '│ > /effort medium      │',
    '╰───────────────────────╯',
    '  /effort — set the reasoning effort',
  ].join('\n');

  it('clears a leftover slash-command overlay with a bounded Escape and proceeds', async () => {
    const port = createFakeControlPort({ captures: [LEFTOVER_PICKER, IDLE, IDLE, EFFORT_CONFIRMATION] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toMatchObject({ kind: 'applied', effective: 'high' });
    expect(port.sentKeys[0]).toBe('Escape');
    expect(port.sentLiteral).toContain('/effort high');
  });

  it('defers when the overlay survives the bounded Escape', async () => {
    const port = createFakeControlPort({ captures: [LEFTOVER_PICKER, LEFTOVER_PICKER] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toMatchObject({ kind: 'scheduled', timing: 'queued_until_safe_window', reason: 'leftover_slash_draft' });
    expect(port.sentLiteral).toHaveLength(0);
  });

  it('never sends Escape into a genuine user draft (defers instead)', async () => {
    const USER_DRAFT = [
      '╭───────────────────────╮',
      '│ > my half-typed idea  │',
      '╰───────────────────────╯',
    ].join('\n');
    const port = createFakeControlPort({ captures: [USER_DRAFT] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toMatchObject({ kind: 'scheduled', timing: 'queued_until_safe_window', reason: 'unsafe_overlay' });
    expect(port.sentKeys).not.toContain('Escape');
  });
});

// Live probe capture 2026-06-11 (Claude Code 2.1.173, tmux, probes/lane-n, incident cmq8y3nlx L6):
// `/effort <level>` on a conversation cached at a different effort opens a confirmation dialog.
// Enter alone resolves it to the highlighted option; Escape / "No, go back" prints
// `Kept effort level as <current>`.
const EFFORT_DIALOG = [
  '❯ /effort high',
  '   Change effort level?',
  '   Your next response will be slower and use more tokens',
  '',
  '   This conversation is cached for the current effort level. Switching to high means the full history gets',
  '   re-read on your next message.',
  '',
  '   ❯ 1. Yes, switch to high',
  '     2. No, go back',
].join('\n');
const EFFORT_SET_HIGH = [
  '❯ /effort high',
  '  ⎿  Set effort level to high (saved as your default for new sessions): Comprehensive implementation with',
  '     extensive testing and documentation',
  '╭─────╮',
  '│ >   │',
  '╰─────╯',
].join('\n');
const EFFORT_KEPT_LOW = [
  '❯ /effort high',
  '  ⎿  Kept effort level as low',
  '╭─────╮',
  '│ >   │',
  '╰─────╯',
].join('\n');
const EFFORT_SET_LOW = [
  '❯ /effort low',
  '  ⎿  Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation',
  '╭─────╮',
  '│ >   │',
  '╰─────╯',
].join('\n');

describe('effort change confirmation dialog (incident cmq8y3nlx, L6)', () => {
  it('answers the dialog deliberately (Yes, switch) and verifies the applied level', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, EFFORT_DIALOG, EFFORT_SET_HIGH] });
    const { guard, settingsPath, original } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toMatchObject({ kind: 'applied', effective: 'high' });
    expect(port.sentLiteral).toEqual(['/effort high', '1']);
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
  });

  it('answers a dialog that renders late in the verification poll (L2 composition)', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, IDLE, IDLE, EFFORT_DIALOG, EFFORT_SET_HIGH] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toMatchObject({ kind: 'applied', effective: 'high' });
    expect(port.sentLiteral).toContain('1');
  });

  it('reports a precise failure when the dialog resolves as kept (declined), never silent', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, EFFORT_DIALOG, EFFORT_KEPT_LOW] });
    const { guard, settingsPath, original } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toEqual({ kind: 'failed', reason: 'effort_change_declined_by_dialog_default' });
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
  });

  it('does not misreport stale scrollback set-confirmations as success while the dialog is open', async () => {
    // The dialog screen still shows an older "Set effort level to high" row above it; verification
    // must wait for the post-dialog screen instead of accepting the stale row.
    const STALE = [
      '❯ /effort high',
      '  ⎿  Set effort level to high (saved as your default for new sessions): Comprehensive implementation with',
      '     extensive testing and documentation',
      EFFORT_DIALOG,
    ].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, IDLE, STALE, EFFORT_KEPT_LOW] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toEqual({ kind: 'failed', reason: 'effort_change_declined_by_dialog_default' });
  });

  it('answers a LEFTOVER matching dialog at the initial capture instead of failing (queued command executed at turn end)', async () => {
    const port = createFakeControlPort({ captures: [EFFORT_DIALOG, EFFORT_SET_HIGH] });
    const { guard, settingsPath, original } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toMatchObject({ kind: 'applied', effective: 'high' });
    // The dialog IS the pending command: answer it, never type a duplicate /effort.
    expect(port.sentLiteral).toEqual(['1']);
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
  });

  it('declines a leftover dialog whose target does not match, then runs the requested command', async () => {
    const port = createFakeControlPort({ captures: [EFFORT_DIALOG, EFFORT_KEPT_LOW, EFFORT_KEPT_LOW, EFFORT_SET_LOW] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'low');

    expect(result).toMatchObject({ kind: 'applied', effective: 'low' });
    // '2' dismisses the stale dialog (target high ≠ requested low), then the fresh command runs.
    expect(port.sentLiteral).toEqual(['2', '/effort low']);
  });

  it('accepts an xhigh dialog target when ultracode was requested (ultracode maps to xhigh)', async () => {
    const DIALOG_XHIGH = EFFORT_DIALOG.replaceAll('high', 'xhigh');
    const SET_ULTRACODE = [
      '❯ /effort ultracode',
      '  ⎿  Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration',
      '╭─────╮',
      '│ >   │',
      '╰─────╯',
    ].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, IDLE, DIALOG_XHIGH, SET_ULTRACODE] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'ultracode');

    expect(result).toMatchObject({ kind: 'applied', effective: 'ultracode' });
    expect(port.sentLiteral).toEqual(['/effort ultracode', '1']);
  });

  it('cancels and fails precisely when the dialog never accepts the bounded answers', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, EFFORT_DIALOG] });
    const { guard, settingsPath, original } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toEqual({ kind: 'failed', reason: 'control_dialog_unresponsive' });
    // Bounded: at most two confirm answers, then a single Escape (dialog Escape = clean cancel).
    expect(port.sentLiteral.filter((text) => text === '1')).toHaveLength(2);
    expect(port.sentKeys.filter((key) => key === 'Escape')).toHaveLength(1);
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
  });

  it('treats a dialog interrupted by a starting turn as delivered-pending (L2 composition)', async () => {
    const QUEUED = ['✶ Forging… (2s · esc to interrupt)', '  Press up to edit queued messages'].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, IDLE, QUEUED] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toMatchObject({ kind: 'scheduled', timing: 'next_idle', reason: 'queued_by_provider' });
  });

  it('does not regress Switch model? dialog handling when an effort kept row is on screen', async () => {
    const MODEL_CONFIRM_WITH_KEPT = [
      '  ⎿  Kept effort level as low',
      'Set model to Sonnet 4.6 and saved as your default for new sessions',
      '╭─────╮',
      '│ >   │',
      '╰─────╯',
    ].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, IDLE, SWITCH_DIALOG, MODEL_CONFIRM_WITH_KEPT] });
    const { guard } = await makeGuard();

    const result = await applyModelControl(contextFor(port, guard), 'claude-sonnet-4-6');

    expect(result).toMatchObject({ kind: 'applied', effective: 'Sonnet 4.6' });
  });
});

describe('applyEffortControl', () => {
  it('types /effort and verifies via confirmation text (B2, B10)', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, EFFORT_CONFIRMATION] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toMatchObject({ kind: 'applied', effective: 'high' });
    expect(port.sentLiteral).toContain('/effort high');
  });

  it('refuses mid-generation and schedules for next idle', async () => {
    const port = createFakeControlPort({ captures: [GENERATING] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');
    expect(result.kind).toBe('scheduled');
    expect(port.sentLiteral).toHaveLength(0);
  });
});

describe('double-typed control concatenation (incident cmq7pyqkj, U1)', () => {
  // Our own `/effort medium` left in the composer after a failed submit, with the slash picker
  // CLOSED (a cleanup Escape closes the picker but can leave the text). This screen passes the
  // safe-window check — slash text is neither a picker overlay nor a user draft — so before the
  // fix the controller typed straight into it and submitted `/effort medium/effort medium`
  // ("Invalid argument: medium/effort medium").
  const LEFTOVER_DRAFT_NO_PICKER = [
    '╭───────────────────────╮',
    '│ > /effort medium      │',
    '╰───────────────────────╯',
  ].join('\n');
  const EFFORT_SET_MEDIUM = [
    '❯ /effort medium',
    '  ⎿  Set effort level to medium (saved as your default for new sessions)',
    '╭─────╮',
    '│ >   │',
    '╰─────╯',
  ].join('\n');

  it('clears a leftover slash draft (picker closed) before typing instead of concatenating', async () => {
    const port = createFakeControlPort({ captures: [LEFTOVER_DRAFT_NO_PICKER, IDLE, IDLE, EFFORT_SET_MEDIUM] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'medium');

    expect(result).toMatchObject({ kind: 'applied', effective: 'medium' });
    // The leftover draft is OUR failed control: bounded Escape clears it BEFORE any typing.
    expect(port.sentKeys[0]).toBe('Escape');
    expect(port.sentLiteral).toEqual(['/effort medium']);
  });

  it('defers without typing when the leftover slash draft survives the bounded clears', async () => {
    const port = createFakeControlPort({ captures: [LEFTOVER_DRAFT_NO_PICKER] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'medium');

    expect(result).toMatchObject({ kind: 'scheduled', timing: 'queued_until_safe_window', reason: 'leftover_slash_draft' });
    expect(port.sentLiteral).toHaveLength(0);
    expect(port.sentKeys).not.toContain('Enter');
  });

  it('never submits when the pre-Enter recapture shows a CONCATENATED command (incident replay)', async () => {
    const DOUBLED = [
      '╭───────────────────────────────────────╮',
      '│ > /effort medium/effort medium        │',
      '╰───────────────────────────────────────╯',
    ].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, DOUBLED] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'medium');

    expect(result).toEqual({ kind: 'failed', reason: 'composer_content_mismatch' });
    expect(port.sentKeys).not.toContain('Enter');
    expect(port.sentKeys).toContain('Escape');
  });

  it('still submits when the pre-Enter recapture shows EXACTLY the typed command (picker open)', async () => {
    const TYPED_EXACT = [
      '╭───────────────────────╮',
      '│ > /effort high        │',
      '╰───────────────────────╯',
      '  /effort — set the reasoning effort',
    ].join('\n');
    const port = createFakeControlPort({ captures: [IDLE, TYPED_EXACT, EFFORT_CONFIRMATION] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toMatchObject({ kind: 'applied', effective: 'high' });
    expect(port.sentKeys).toContain('Enter');
  });
});

describe('resume effort re-apply skip (incident cmq7pyqkj, U2)', () => {
  // A resumed TUI re-renders this conversation's effort evidence in scrollback. When that
  // evidence already names the requested level, typing `/effort` is pure re-apply churn (and
  // feeds the U1 leftover-draft class): the control must report already-effective, zero bytes.
  const RESUMED_SET_MEDIUM = [
    '❯ /effort medium',
    '  ⎿  Set effort level to medium (saved as your default for new sessions)',
    '╭─────╮',
    '│ >   │',
    '╰─────╯',
  ].join('\n');

  it('reports already-effective with ZERO bytes when the screen already shows the requested effort', async () => {
    const port = createFakeControlPort({ captures: [RESUMED_SET_MEDIUM] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'medium');

    expect(result).toEqual({ kind: 'already_effective', effective: 'medium' });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('treats the latest kept-notice as the current level (outranks older set rows)', async () => {
    const KEPT_LOW_AFTER_SET_HIGH = [
      '❯ /effort high',
      '  ⎿  Set effort level to high (saved as your default for new sessions)',
      '❯ /effort low',
      '  ⎿  Kept effort level as low',
      '╭─────╮',
      '│ >   │',
      '╰─────╯',
    ].join('\n');
    const port = createFakeControlPort({ captures: [KEPT_LOW_AFTER_SET_HIGH] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'low');

    expect(result).toEqual({ kind: 'already_effective', effective: 'low' });
    expect(port.sentLiteral).toEqual([]);
  });

  it('does not skip when the evidence differs from the requested level', async () => {
    const port = createFakeControlPort({ captures: [RESUMED_SET_MEDIUM, RESUMED_SET_MEDIUM, EFFORT_CONFIRMATION] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(port.sentLiteral).toContain('/effort high');
    expect(result.kind).toBe('applied');
  });

  it('never skips an ultracode request on plain xhigh evidence (ultracode is a setting, not a level)', async () => {
    const SET_XHIGH = ['❯ /effort xhigh', '  ⎿  Set effort level to xhigh', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
    const SET_ULTRACODE = ['❯ /effort ultracode', '  ⎿  Set effort level to ultracode (this session only)', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
    const port = createFakeControlPort({ captures: [SET_XHIGH, SET_XHIGH, SET_ULTRACODE] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'ultracode');

    expect(port.sentLiteral).toContain('/effort ultracode');
    expect(result).toMatchObject({ kind: 'applied', effective: 'ultracode' });
  });
});

describe('unrecognized confirmation dialogs (P-B fail-closed, incident cmq8y3nlx class)', () => {
  // A ❯-numbered selection dialog whose heading matches NO recognized matcher (e.g. a dialog added
  // by a newer Claude build). Typing answers it; Escape declines it — both are forbidden.
  const UNRECOGNIZED_DIALOG = [
    ' Reset conversation cache?',
    ' Your next response may be slower',
    '',
    ' ❯ 1. Yes, reset it',
    '   2. No, go back',
  ].join('\n');

  it('fails closed to requires-interactive-control and sends ZERO bytes when the initial capture shows an unrecognized dialog', async () => {
    const port = createFakeControlPort({ captures: [UNRECOGNIZED_DIALOG] });
    const { guard } = await makeGuard();

    const result = await applyEffortControl(contextFor(port, guard), 'high');

    expect(result).toEqual({ kind: 'unreachable', reason: 'unrecognized_confirmation_dialog' });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });

  it('never blind-Enters or Escapes when an unrecognized dialog appears between typing and submit', async () => {
    const port = createFakeControlPort({ captures: [IDLE, UNRECOGNIZED_DIALOG] });
    const { guard } = await makeGuard();

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');

    expect(result).toEqual({ kind: 'unreachable', reason: 'unrecognized_confirmation_dialog' });
    expect(port.sentKeys).not.toContain('Enter');
    expect(port.sentKeys).not.toContain('Escape');
  });

  it('fails closed WITHOUT Escape when an unrecognized dialog we caused appears during the verification poll', async () => {
    const port = createFakeControlPort({ captures: [IDLE, IDLE, UNRECOGNIZED_DIALOG] });
    const { guard } = await makeGuard();

    const result = await applyModelControl(contextFor(port, guard), 'sonnet');

    expect(result).toEqual({ kind: 'unreachable', reason: 'unrecognized_confirmation_dialog' });
    // Only the command submit Enter — never an Escape (dialog decline) and never a dialog answer.
    expect(port.sentKeys).toEqual(['Enter']);
    expect(port.sentLiteral).toEqual(['/model sonnet']);
  });

  it('incident replay: repeated attempts against a stuck unrecognized dialog escalate every time and never send bytes (no decline loop possible)', async () => {
    const port = createFakeControlPort({ captures: [UNRECOGNIZED_DIALOG] });
    const { guard } = await makeGuard();

    const first = await applyEffortControl(contextFor(port, guard), 'high');
    const second = await applyEffortControl(contextFor(port, guard), 'high');

    expect(first).toEqual({ kind: 'unreachable', reason: 'unrecognized_confirmation_dialog' });
    expect(second).toEqual({ kind: 'unreachable', reason: 'unrecognized_confirmation_dialog' });
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual([]);
  });
});

describe('isControllerTypedSlashCommandResidue (ported HF-4 / A2-HIGH-1)', () => {
  it('recognizes controller-vocabulary residue including the concatenated double-typed form', async () => {
    const { isControllerTypedSlashCommandResidue } = await import('./slashControls.js');
    expect(isControllerTypedSlashCommandResidue('/model sonnet')).toBe(true);
    expect(isControllerTypedSlashCommandResidue('/effort high')).toBe(true);
    expect(isControllerTypedSlashCommandResidue('/effort medium/effort medium')).toBe(true);
    expect(isControllerTypedSlashCommandResidue('  /model opus  ')).toBe(true);
  });

  it('fails safe to foreign for anything outside the finite controller vocabulary', async () => {
    const { isControllerTypedSlashCommandResidue } = await import('./slashControls.js');
    // User-typed commands the controller never types stay foreign drafts.
    expect(isControllerTypedSlashCommandResidue('/compact focus on tests')).toBe(false);
    expect(isControllerTypedSlashCommandResidue('/clear')).toBe(false);
    expect(isControllerTypedSlashCommandResidue('hello world')).toBe(false);
    expect(isControllerTypedSlashCommandResidue('')).toBe(false);
    // A model arg containing '/' cannot be proven controller-typed — fail safe.
    expect(isControllerTypedSlashCommandResidue('/model anthropic/sonnet extra')).toBe(false);
  });
});
