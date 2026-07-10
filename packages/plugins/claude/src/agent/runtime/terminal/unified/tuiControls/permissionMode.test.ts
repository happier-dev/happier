import { describe, expect, it } from 'vitest';

import { createFakeControlPort, type FakeControlPort } from './fakeControlPort.js';
import {
  applyPermissionModeControl,
  resolveTargetModeMarker,
  type PermissionModeContext,
} from './permissionMode.js';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './types.js';
import type { ControlRuntime } from './controlRuntime.js';

function runtimeFor(port: FakeControlPort): ControlRuntime {
  return { port, wait: async () => undefined, timings: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS, nowMs: () => 0 };
}

function ctxFor(port: FakeControlPort): PermissionModeContext {
  return { runtime: runtimeFor(port), maxAttempts: 6 };
}

const DEFAULT = ['╭─────╮', '│ >   │', '╰─────╯', '  ? for shortcuts'].join('\n');
const ACCEPT = ['╭─────╮', '│ >   │', '╰─────╯', '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
const PLAN = ['╭─────╮', '│ >   │', '╰─────╯', '  ⏸ plan mode on (shift+tab to cycle)'].join('\n');
const AUTO = ['╭─────╮', '│ >   │', '╰─────╯', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');
const GENERATING = ['● working', '✶ Forging… (10s · esc to interrupt)'].join('\n');

describe('resolveTargetModeMarker', () => {
  it('maps canonical and aliased permission modes to cycle markers', () => {
    expect(resolveTargetModeMarker({ permissionMode: 'acceptEdits' })).toEqual({ kind: 'cyclable', marker: 'acceptEdits' });
    expect(resolveTargetModeMarker({ permissionMode: 'safe-yolo' })).toEqual({ kind: 'cyclable', marker: 'auto' });
    expect(resolveTargetModeMarker({ permissionMode: 'yolo' })).toEqual({ kind: 'cyclable', marker: 'bypassPermissions' });
    expect(resolveTargetModeMarker({ agentModeId: 'plan', permissionMode: 'default' })).toEqual({ kind: 'cyclable', marker: 'plan' });
  });

  it('gives agentModeId=plan precedence over the permission mode, and leaving plan falls back to it (incident cmq9hemcs)', () => {
    // Entering plan: plan wins even when the session-control permission mode is safe-yolo.
    expect(resolveTargetModeMarker({ agentModeId: 'plan', permissionMode: 'safe-yolo' })).toEqual({ kind: 'cyclable', marker: 'plan' });
    // Leaving plan: the cleared agent mode hands control back to the permission mode.
    expect(resolveTargetModeMarker({ agentModeId: null, permissionMode: 'safe-yolo' })).toEqual({ kind: 'cyclable', marker: 'auto' });
  });

  it('marks dontAsk / read-only as launch-only (not cycle reachable)', () => {
    expect(resolveTargetModeMarker({ permissionMode: 'dontAsk' }).kind).toBe('launch_only');
    expect(resolveTargetModeMarker({ permissionMode: 'read-only' }).kind).toBe('launch_only');
  });
});

describe('applyPermissionModeControl — verified ShiftTab cycling (B11)', () => {
  it('cycles with raw ShiftTab until the target marker, verifying after each press (B4)', async () => {
    const port = createFakeControlPort({ captures: [DEFAULT, ACCEPT, PLAN] });

    const result = await applyPermissionModeControl(ctxFor(port), { permissionMode: 'plan' });

    expect(result).toMatchObject({ kind: 'applied', effective: 'plan' });
    expect(port.sentKeys).toEqual(['ShiftTab', 'ShiftTab']);
    // Never uses /permissions (it is an editor, not a mode setter) — B3.
    expect(port.sentLiteral).toHaveLength(0);
  });

  it('short-circuits when already in the target mode without pressing any key', async () => {
    const port = createFakeControlPort({ captures: [PLAN] });
    const result = await applyPermissionModeControl(ctxFor(port), { agentModeId: 'plan', permissionMode: 'default' });
    expect(result.kind).toBe('already_effective');
    expect(port.sentKeys).toHaveLength(0);
  });

  it('returns requires_interactive_control (never loops) when a mode is unreachable (B5)', async () => {
    // auto is model/account-gated; the cycle returns to default without ever showing it.
    const port = createFakeControlPort({ captures: [DEFAULT, ACCEPT, PLAN, DEFAULT] });

    const result = await applyPermissionModeControl(ctxFor(port), { permissionMode: 'auto' });

    expect(result.kind).toBe('unreachable');
    expect(port.sentLiteral).toHaveLength(0);
    // Bounded: it stops once it cycles back to a previously seen marker.
    expect(port.sentKeys.length).toBeLessThanOrEqual(6);
  });

  it('honors a bounded attempt limit even if the marker never repeats', async () => {
    const port = createFakeControlPort({ captures: [DEFAULT, ACCEPT, PLAN, AUTO] });
    const result = await applyPermissionModeControl({ runtime: runtimeFor(port), maxAttempts: 2 }, { permissionMode: 'bypassPermissions' });
    expect(result.kind).toBe('unreachable');
    expect(port.sentKeys.length).toBeLessThanOrEqual(2);
  });

  it('treats dontAsk as requires_restart and sends no keys', async () => {
    const port = createFakeControlPort({ captures: [DEFAULT] });
    const result = await applyPermissionModeControl(ctxFor(port), { permissionMode: 'dontAsk' });
    expect(result.kind).toBe('requires_restart');
    expect(port.sentKeys).toHaveLength(0);
  });

  it('queues until a safe window when Claude is generating', async () => {
    const port = createFakeControlPort({ captures: [GENERATING] });
    const result = await applyPermissionModeControl(ctxFor(port), { permissionMode: 'acceptEdits' });
    expect(result).toMatchObject({ kind: 'scheduled', timing: 'queued_until_safe_window', reason: 'unsafe_window' });
    expect(port.sentKeys).toHaveLength(0);
  });

  it('reports the exact blocker reason when a known prompt blocks the default mode-cycle window', async () => {
    const GENERATING_PERMISSION_PROMPT = [
      '✶ Forging… (10s · esc to interrupt)',
      'Do you want to proceed?',
      '1. Yes',
      '  ? for shortcuts',
    ].join('\n');
    const port = createFakeControlPort({ captures: [GENERATING_PERMISSION_PROMPT] });
    const result = await applyPermissionModeControl(ctxFor(port), { permissionMode: 'acceptEdits' });
    expect(result).toMatchObject({
      kind: 'scheduled',
      timing: 'queued_until_safe_window',
      reason: 'permission_prompt',
    });
    expect(port.sentKeys).toHaveLength(0);
  });
});

describe('applyPermissionModeControl — in_flight_steer window (lane Q, probe Q-A)', () => {
  // Probe Q-A (2.1.173): raw ShiftTab registers LIVE during generation and the footer marker
  // renders mid-generation, so verified cycling is safe in the steer-safe generating window.
  const GENERATING_DEFAULT = ['● working', '✶ Forging… (10s · esc to interrupt)', '╭─────╮', '│ >   │', '╰─────╯'].join('\n');
  const GENERATING_ACCEPT = [
    '● working',
    '✶ Forging… (12s · esc to interrupt)',
    '╭─────╮', '│ >   │', '╰─────╯',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n');
  const GENERATING_PERMISSION_PROMPT_DEFAULT = [
    '✶ Forging… (10s · esc to interrupt)',
    'Do you want to proceed?',
    '1. Yes',
    '  ? for shortcuts',
  ].join('\n');
  const GENERATING_PERMISSION_PROMPT_ACCEPT = [
    '✶ Forging… (10s · esc to interrupt)',
    'Do you want to proceed?',
    '1. Yes',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n');

  it('cycles and verifies the marker mid-generation when the steer window is allowed', async () => {
    const port = createFakeControlPort({ captures: [GENERATING_DEFAULT, GENERATING_ACCEPT] });

    const result = await applyPermissionModeControl(
      { ...ctxFor(port), window: 'in_flight_steer' },
      { permissionMode: 'acceptEdits' },
    );

    expect(result).toMatchObject({ kind: 'applied', effective: 'acceptEdits', timing: 'current_window' });
    expect(port.sentKeys).toEqual(['ShiftTab']);
  });

  it('allows mode cycling through a permission prompt in the mode-cycle window', async () => {
    const port = createFakeControlPort({
      captures: [GENERATING_PERMISSION_PROMPT_DEFAULT, GENERATING_PERMISSION_PROMPT_ACCEPT],
    });

    const result = await applyPermissionModeControl(
      { ...ctxFor(port), window: 'in_flight_steer' },
      { permissionMode: 'acceptEdits' },
    );

    expect(result).toMatchObject({ kind: 'applied', effective: 'acceptEdits', timing: 'current_window' });
    expect(port.sentKeys).toEqual(['ShiftTab']);
  });

  it('default window keeps deferring on generating screens (no behavior change)', async () => {
    const port = createFakeControlPort({ captures: [GENERATING_DEFAULT] });

    const result = await applyPermissionModeControl(ctxFor(port), { permissionMode: 'acceptEdits' });

    expect(result).toMatchObject({ kind: 'scheduled', timing: 'queued_until_safe_window' });
    expect(port.sentKeys).toHaveLength(0);
  });

  it('keeps non-permission prompt blockers deferred in the mode-cycle window with exact reasons', async () => {
    const GENERATING_TRUST_PROMPT = [
      '✶ Forging… (10s · esc to interrupt)',
      'Do you trust the files in this folder?',
      '1. Yes',
    ].join('\n');
    const port = createFakeControlPort({ captures: [GENERATING_TRUST_PROMPT] });

    const result = await applyPermissionModeControl(
      { ...ctxFor(port), window: 'in_flight_steer' },
      { permissionMode: 'acceptEdits' },
    );

    expect(result).toMatchObject({
      kind: 'scheduled',
      timing: 'queued_until_safe_window',
      reason: 'trust_prompt',
    });
    expect(port.sentKeys).toHaveLength(0);
  });
});
