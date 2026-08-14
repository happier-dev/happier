import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostHandle, TerminalInputState } from '@/integrations/terminalHost/_types';

import { createClaudeUnifiedInFlightSteerEvaluator } from './createClaudeUnifiedInFlightSteerEvaluator';
import type { ClaudeUnifiedPromptBatch } from './_types';
import type { EnhancedMode } from '../loop';

const handle: TerminalHostHandle = {
  kind: 'tmux',
  sessionName: 'happier-claude-steer-test',
  paneId: '%1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

afterEach(() => {
  vi.useRealTimers();
});

const generatingScreen = [
  '● Working through the task…',
  '  reading files, running tests',
  '',
  '✶ Forging… (42s · esc to interrupt)',
].join('\n');

const generatingScreenWithDraft = [
  '✶ Forging… (42s · esc to interrupt)',
  '╭───────────────────────────────────────────────╮',
  '│ > half-typed user thought                     │',
  '╰───────────────────────────────────────────────╯',
].join('\n');

const idleInteractiveScreen = [
  'What would you like to work on?',
  '╭───────────────────────────────────────────────╮',
  '│ >                                             │',
  '╰───────────────────────────────────────────────╯',
].join('\n');

const unknownResumeScreen = [
  'Resuming previous conversation...',
  'Rendering transcript messages and tools...',
].join('\n');

const modeFooterWithoutComposerScreen = [
  'Applied runtime control; transcript is redrawing',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

const queuedBannerScreen = [
  '✶ Forging… (44s · esc to interrupt)',
  '  Press up to edit queued messages',
].join('\n');

const queuedBannerScreenWithDraft = [
  '✶ Forging… (44s · esc to interrupt)',
  '  Press up to edit queued messages',
  '╭───────────────────────────────────────────────╮',
  '│ > not actually queued yet                     │',
  '╰───────────────────────────────────────────────╯',
].join('\n');

function createHarness(opts?: Readonly<{
  screen?: string | (() => string);
  cursor?: Readonly<{ x: number; y: number }> | undefined;
  captureInputState?: ((handle: TerminalHostHandle) => Promise<TerminalInputState>) | undefined | 'absent';
  initialPermissionMode?: EnhancedMode['permissionMode'] | undefined;
  queuedBannerCheckDelayMs?: number | undefined;
  onPromptCustodyByTerminal?: ((batch: ClaudeUnifiedPromptBatch<EnhancedMode>) => void | Promise<void>) | undefined;
}>) {
  const telemetry = { emit: vi.fn() };
  const screen = opts?.screen ?? generatingScreen;
  const captureInputState = opts?.captureInputState === 'absent'
    ? undefined
    : opts?.captureInputState ?? vi.fn(async (): Promise<TerminalInputState> => ({
      stable: true,
      currentInput: typeof screen === 'function' ? screen() : screen,
      cursor: opts?.cursor,
      observedAt: Date.now(),
    }));
  const wiring = createClaudeUnifiedInFlightSteerEvaluator<EnhancedMode>({
    hostAdapter: captureInputState ? { captureInputState } : {},
    handle,
    telemetry,
    initialPermissionMode: opts?.initialPermissionMode ?? 'default',
    queuedBannerCheckDelayMs: opts?.queuedBannerCheckDelayMs ?? 0,
    ...(opts?.onPromptCustodyByTerminal
      ? { onPromptCustodyByTerminal: opts.onPromptCustodyByTerminal }
      : {}),
  });
  return { telemetry, captureInputState, wiring };
}

function pendingBatch(message: string, permissionMode: EnhancedMode['permissionMode'] = 'default') {
  return {
    message,
    mode: { permissionMode } satisfies EnhancedMode,
    origin: { kind: 'ui_pending' as const },
  };
}

describe('createClaudeUnifiedInFlightSteerEvaluator', () => {
  it('approves steering on an actively-generating clean screen and emits a safe decision', async () => {
    const { telemetry, wiring } = createHarness();

    const decision = await wiring.evaluateInFlightSteer(pendingBatch('steer me'));

    expect(decision).toEqual({ steer: true });
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: expect.objectContaining({ decision: 'safe', originKind: 'ui_pending' }),
    });
  });

  it.each([
    {
      label: 'user draft on a generating screen',
      screen: generatingScreenWithDraft,
      cursor: { x: 27, y: 2 },
      reason: 'user_draft',
    },
    { label: 'permission prompt', screen: 'Do you want to proceed?\n❯ 1. Yes\n  2. No', reason: 'permission_prompt' },
    { label: 'trust folder prompt', screen: 'Do you trust the files in this folder?\n❯ 1. Yes, proceed', reason: 'trust_prompt' },
    { label: 'switch model dialog', screen: 'Switch model?\n❯ 1. Sonnet\n  2. Opus', reason: 'switch_model_dialog' },
    { label: 'slash picker', screen: '╭──╮\n│ > /mod │\n╰──╮\n  /model — switch the active model', reason: 'slash_picker' },
  ])('vetoes steering when the screen shows a $label', async ({ screen, cursor, reason }) => {
    const { telemetry, wiring } = createHarness({ screen, cursor });

    const decision = await wiring.evaluateInFlightSteer(pendingBatch('steer me'));

    expect(decision).toMatchObject({ steer: false, reason });
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: expect.objectContaining({ decision: 'vetoed', reason, originKind: 'ui_pending' }),
    });
  });

  // D19b: an idle interactive composer is a SAFE steer surface (typed text submits as the next
  // message) and doubles as turn-end evidence for the lost-hook acceptance fallback.
  it('steers on an idle interactive composer and carries turn-likely-ended evidence (D19b)', async () => {
    const idle = createHarness({ screen: idleInteractiveScreen });
    await expect(idle.wiring.evaluateInFlightSteer(pendingBatch('steer me'))).resolves.toEqual({
      steer: true,
      turnLikelyEnded: true,
    });

    const unknown = createHarness({ screen: unknownResumeScreen });
    const unknownDecision = await unknown.wiring.evaluateInFlightSteer(pendingBatch('steer me'));
    expect(unknownDecision).toMatchObject({ steer: false, reason: 'no_interactive_composer' });
    expect(unknownDecision).not.toMatchObject({ turnLikelyEnded: true });
  });

  it('vetoes a mode-footer capture whose interactive marker is stale but composer is absent', async () => {
    const { telemetry, wiring } = createHarness({ screen: modeFooterWithoutComposerScreen });

    const decision = await wiring.evaluateInFlightSteer(pendingBatch('exact pending prompt'));

    expect(decision).toMatchObject({ steer: false, reason: 'no_interactive_composer' });
    expect(decision).not.toMatchObject({ turnLikelyEnded: true });
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: expect.objectContaining({
        decision: 'vetoed',
        reason: 'no_interactive_composer',
        originKind: 'ui_pending',
      }),
    });
  });

  it('refuses to steer a prompt that changes the permission mode while a turn is live', async () => {
    const { telemetry, wiring } = createHarness({ initialPermissionMode: 'default', screen: generatingScreen });

    const decision = await wiring.evaluateInFlightSteer(pendingBatch('switch to accept edits', 'acceptEdits'));

    expect(decision).toMatchObject({ steer: false, reason: 'permission_mode_change' });
    expect(decision).not.toMatchObject({ turnLikelyEnded: true });
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: expect.objectContaining({ decision: 'vetoed', reason: 'permission_mode_change' }),
    });
  });

  // L1 (incident cmq7pyqkj): a mode-change refusal must still capture turn-end screen evidence so
  // the arbiter's stale-turn recovery can drain the prompt when no live turn exists behind a stale
  // 'running' state. Capture failures keep the plain refusal (fail-closed: no recovery evidence).
  it('carries turn-likely-ended evidence on a mode-change refusal when the composer is idle', async () => {
    const idle = createHarness({ initialPermissionMode: 'default', screen: idleInteractiveScreen });
    await expect(idle.wiring.evaluateInFlightSteer(pendingBatch('switch mode', 'acceptEdits'))).resolves.toEqual({
      steer: false,
      reason: 'permission_mode_change',
      turnLikelyEnded: true,
    });

    const failing = createHarness({
      initialPermissionMode: 'default',
      captureInputState: vi.fn(async () => {
        throw new Error('capture failed');
      }),
    });
    const decision = await failing.wiring.evaluateInFlightSteer(pendingBatch('switch mode', 'acceptEdits'));
    expect(decision).toMatchObject({ steer: false, reason: 'permission_mode_change' });
    expect(decision).not.toMatchObject({ turnLikelyEnded: true });
  });

  // Incident 2026-06-12 (session cmq7pyqkj, UI message starved behind a long turn): the UI sends
  // 'yolo' while the daemon spawn normalizes the same intent to 'bypassPermissions'. Alias pairs
  // that map to the SAME effective Claude mode are NOT a permission-mode change and must steer.
  it.each([
    ['yolo', 'bypassPermissions'],
    ['bypassPermissions', 'yolo'],
  ] as const)('steers when requested mode %s is a Claude-equivalent alias of active mode %s', async (requested, active) => {
    const { telemetry, wiring } = createHarness({ initialPermissionMode: active, screen: generatingScreen });

    const decision = await wiring.evaluateInFlightSteer(pendingBatch('steer me', requested));

    expect(decision).toEqual({ steer: true });
    expect(telemetry.emit).not.toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: expect.objectContaining({ reason: 'permission_mode_change' }),
    });
  });

  it('tracks the active permission mode from new-turn injections', async () => {
    const { wiring } = createHarness({ initialPermissionMode: 'default' });

    wiring.observeInjectedPrompt(
      pendingBatch('next turn in accept edits', 'acceptEdits'),
      { acceptedAs: 'new_turn', turnStateAtInjection: 'idle' },
    );

    await expect(wiring.evaluateInFlightSteer(pendingBatch('steer me', 'acceptEdits'))).resolves.toEqual({ steer: true });
  });

  it('vetoes when the host cannot capture the screen', async () => {
    const absent = createHarness({ captureInputState: 'absent' });
    await expect(absent.wiring.evaluateInFlightSteer(pendingBatch('steer me'))).resolves.toMatchObject({
      steer: false,
      reason: 'screen_capture_unavailable',
    });

    const failing = createHarness({
      captureInputState: vi.fn(async () => {
        throw new Error('tmux capture failed');
      }),
    });
    const decision = await failing.wiring.evaluateInFlightSteer(pendingBatch('steer me'));
    expect(decision).toMatchObject({ steer: false, reason: 'screen_capture_failed' });
    expect(failing.telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: expect.objectContaining({ decision: 'vetoed', reason: 'screen_capture_failed' }),
    });
  });

  it('emits acceptance-armed telemetry when a steered prompt arms at turn end', () => {
    const { telemetry, wiring } = createHarness();

    wiring.onSteerAcceptanceArmed(pendingBatch('steer me'));

    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: { decision: 'acceptance_armed', originKind: 'ui_pending' },
    });
  });

  it('verifies the queued-message banner after a steer injection and reports visibility', async () => {
    const custody = vi.fn();
    const visibleBatch = pendingBatch('steer me');
    const visible = createHarness({ screen: queuedBannerScreen, onPromptCustodyByTerminal: custody });
    visible.wiring.observeInjectedPrompt(
      visibleBatch,
      { acceptedAs: 'in_flight_steer', turnStateAtInjection: 'running' },
    );
    await vi.waitFor(() => {
      expect(visible.telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.steer.decision',
        properties: expect.objectContaining({ decision: 'queued_banner_check', queuedBannerVisible: true }),
      });
    });
    expect(custody).toHaveBeenCalledTimes(1);
    expect(custody).toHaveBeenCalledWith(visibleBatch);

    const hiddenCustody = vi.fn();
    const hidden = createHarness({ screen: generatingScreen, onPromptCustodyByTerminal: hiddenCustody });
    hidden.wiring.observeInjectedPrompt(
      pendingBatch('steer me'),
      { acceptedAs: 'in_flight_steer', turnStateAtInjection: 'running' },
    );
    await vi.waitFor(() => {
      expect(hidden.telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.steer.decision',
        properties: expect.objectContaining({ decision: 'queued_banner_check', queuedBannerVisible: false }),
      });
    });
    expect(hiddenCustody).not.toHaveBeenCalled();
  });

  it('retries queued-message banner custody probes before leaving steer custody unresolved', async () => {
    vi.useFakeTimers();
    let screen = generatingScreen;
    const custody = vi.fn();
    const captureInputState = vi.fn(async (): Promise<TerminalInputState> => ({
      stable: true,
      currentInput: screen,
      observedAt: Date.now(),
    }));
    const harness = createHarness({
      captureInputState,
      queuedBannerCheckDelayMs: 400,
      onPromptCustodyByTerminal: custody,
    });
    const batch = pendingBatch('steer me');

    harness.wiring.observeInjectedPrompt(
      batch,
      { acceptedAs: 'in_flight_steer', turnStateAtInjection: 'running' },
    );

    await vi.advanceTimersByTimeAsync(400);
    expect(custody).not.toHaveBeenCalled();

    screen = queuedBannerScreen;
    await vi.advanceTimersByTimeAsync(1_200);
    expect(captureInputState).toHaveBeenCalledTimes(2);
    expect(custody).toHaveBeenCalledTimes(1);
    expect(custody).toHaveBeenCalledWith(batch);
  });

  it('does not report terminal custody when the queued banner is visible but the composer still has a draft', async () => {
    const custody = vi.fn();
    const harness = createHarness({ screen: queuedBannerScreenWithDraft, onPromptCustodyByTerminal: custody });

    harness.wiring.observeInjectedPrompt(
      pendingBatch('not actually queued yet'),
      { acceptedAs: 'in_flight_steer', turnStateAtInjection: 'running' },
    );

    await vi.waitFor(() => {
      expect(harness.telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.steer.decision',
        properties: expect.objectContaining({
          decision: 'queued_banner_check',
          queuedBannerVisible: true,
          composerDraftPresent: true,
        }),
      });
    });
    expect(custody).not.toHaveBeenCalled();
  });

  it('does not run a queued-banner check once disposed', async () => {
    const { telemetry, captureInputState, wiring } = createHarness({ queuedBannerCheckDelayMs: 5 });

    wiring.observeInjectedPrompt(
      pendingBatch('steer me'),
      { acceptedAs: 'in_flight_steer', turnStateAtInjection: 'running' },
    );
    wiring.dispose();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(captureInputState).not.toHaveBeenCalled();
    expect(telemetry.emit).not.toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: expect.objectContaining({ decision: 'queued_banner_check' }),
    });
  });
});

describe('createClaudeUnifiedInFlightSteerEvaluator — availability snapshot tee (lane P, O-design Seam A)', () => {
  function teeHarness(initialScreen: string) {
    const telemetry = { emit: vi.fn() };
    let screen = initialScreen;
    const snapshots: Array<{ available: boolean; reason: string | null }> = [];
    const wiring = createClaudeUnifiedInFlightSteerEvaluator<EnhancedMode>({
      hostAdapter: {
        captureInputState: async (): Promise<TerminalInputState> => ({
          stable: true,
          currentInput: screen,
          observedAt: Date.now(),
        }),
      },
      handle,
      telemetry,
      initialPermissionMode: 'default',
      queuedBannerCheckDelayMs: 0,
      onAvailabilitySnapshot: (snapshot) => snapshots.push(snapshot),
    });
    return { wiring, snapshots, setScreen: (next: string) => { screen = next; } };
  }

  it('tees unsafe on vetoed screens and safe on clean screens, de-duplicating repeats', async () => {
    const dialogScreen = 'Switch model?\n❯ 1. Yes, switch\n  2. No, go back';
    const { wiring, snapshots, setScreen } = teeHarness(dialogScreen);

    await wiring.evaluateInFlightSteer(pendingBatch('one'));
    await wiring.evaluateInFlightSteer(pendingBatch('two'));
    expect(snapshots).toEqual([{ available: false, reason: 'unsafe_window' }]);

    setScreen(generatingScreen);
    await wiring.evaluateInFlightSteer(pendingBatch('three'));
    expect(snapshots).toEqual([
      { available: false, reason: 'unsafe_window' },
      { available: true, reason: null },
    ]);
  });

  it('proves the current session-level safe window before Pending claim without a prompt batch', async () => {
    const { wiring, snapshots } = teeHarness(generatingScreen);

    await expect(wiring.refreshAvailability()).resolves.toEqual({ available: true, reason: null });
    expect(snapshots).toEqual([{ available: true, reason: null }]);
  });

  it('does NOT tee a snapshot for the payload-specific permission-mode refusal (UI computes that locally)', async () => {
    const { wiring, snapshots } = teeHarness(generatingScreen);

    await wiring.evaluateInFlightSteer(pendingBatch('mode change', 'plan'));

    expect(snapshots).toEqual([]);
  });
});

describe('createClaudeUnifiedInFlightSteerEvaluator — in-flight mode apply (lane Q)', () => {
  function createApplyHarness(outcome: { status: 'applied' | 'scheduled_in_turn' | 'unsupported' | 'failed' } | 'throws') {
    const telemetry = { emit: vi.fn() };
    const applyPermissionModeDeltaInFlight = vi.fn(async (): Promise<any> => {
      if (outcome === 'throws') throw new Error('apply transport failed');
      return outcome;
    });
    const captureInputState = vi.fn(async (): Promise<TerminalInputState> => ({
      stable: true,
      currentInput: generatingScreen,
      observedAt: Date.now(),
    }));
    const wiring = createClaudeUnifiedInFlightSteerEvaluator<EnhancedMode>({
      hostAdapter: { captureInputState },
      handle,
      telemetry,
      initialPermissionMode: 'default',
      queuedBannerCheckDelayMs: 0,
      applyPermissionModeDeltaInFlight,
    });
    return { telemetry, wiring, applyPermissionModeDeltaInFlight };
  }

  it('applies the mode delta to the running turn then approves the steer', async () => {
    const { wiring, applyPermissionModeDeltaInFlight } = createApplyHarness({ status: 'applied' });

    const decision = await wiring.evaluateInFlightSteer(pendingBatch('steer me', 'acceptEdits'));

    expect(applyPermissionModeDeltaInFlight).toHaveBeenCalledWith({ permissionMode: 'acceptEdits' });
    expect(decision).toEqual({ steer: true });

    // The applied mode becomes the running turn's mode: a follow-up steer with the same mode
    // does not re-apply.
    applyPermissionModeDeltaInFlight.mockClear();
    const second = await wiring.evaluateInFlightSteer(pendingBatch('again', 'acceptEdits'));
    expect(applyPermissionModeDeltaInFlight).not.toHaveBeenCalled();
    expect(second).toEqual({ steer: true });
  });

  it('keeps the permission_mode_change veto when the apply reports unsupported/failed', async () => {
    for (const status of ['unsupported', 'failed'] as const) {
      const { wiring } = createApplyHarness({ status });
      const decision = await wiring.evaluateInFlightSteer(pendingBatch('steer me', 'acceptEdits'));
      expect(decision).toMatchObject({ steer: false, reason: 'permission_mode_change' });
    }
  });

  it('keeps the veto (fail-closed) when the apply hook throws', async () => {
    const { wiring } = createApplyHarness('throws');
    const decision = await wiring.evaluateInFlightSteer(pendingBatch('steer me', 'acceptEdits'));
    expect(decision).toMatchObject({ steer: false, reason: 'permission_mode_change' });
  });
});

describe('createClaudeUnifiedInFlightSteerEvaluator — user_draft starvation (lane X, incident cmq8y3nlx)', () => {
  const ownLeftoverText = 'please continue with the refactor';

  function idleScreenWithDraft(draft: string): string {
    return [
      '╭───────────────────────────────────────────────╮',
      `│ > ${draft}                                    │`,
      '╰───────────────────────────────────────────────╯',
    ].join('\n');
  }

  function generatingScreenWithDraftText(draft: string): string {
    return [
      '✶ Forging… (42s · esc to interrupt)',
      '╭───────────────────────────────────────────────╮',
      `│ > ${draft}                                    │`,
      '╰───────────────────────────────────────────────╯',
    ].join('\n');
  }

  function starvationHarness(opts: Readonly<{
    initialScreen: string;
    initialCursor?: Readonly<{ x: number; y: number }> | undefined;
    ownTexts?: readonly string[];
    onClear?: (() => void) | undefined;
    escalationThreshold?: number | undefined;
  }>) {
    const telemetry = { emit: vi.fn() };
    let screen = opts.initialScreen;
    let cursor = opts.initialCursor;
    const snapshots: Array<{ available: boolean; reason: string | null }> = [];
    const starvations: Array<{ consecutiveVetoes: number; ownLeftover: boolean; draftLength: number }> = [];
    const ownTexts = new Set((opts.ownTexts ?? []).map((text) => text.trim()));
    const clearOwnLeftoverDraft = vi.fn(async () => {
      opts.onClear?.();
    });
    const wiring = createClaudeUnifiedInFlightSteerEvaluator<EnhancedMode>({
      hostAdapter: {
        captureInputState: async (): Promise<TerminalInputState> => ({
          stable: true,
          currentInput: screen,
          cursor,
          observedAt: Date.now(),
        }),
      },
      handle,
      telemetry,
      initialPermissionMode: 'default',
      queuedBannerCheckDelayMs: 0,
      onAvailabilitySnapshot: (snapshot) => snapshots.push(snapshot),
      ownComposerTexts: { matches: (draft: string) => ownTexts.has(draft.trim()) },
      clearOwnLeftoverDraft,
      draftClearSettleMs: 0,
      userDraftEscalationThreshold: opts.escalationThreshold ?? 3,
      onUserDraftStarvation: (info) => starvations.push({ ...info }),
    });
    return {
      telemetry,
      wiring,
      snapshots,
      starvations,
      clearOwnLeftoverDraft,
      setScreen: (next: string, nextCursor?: Readonly<{ x: number; y: number }>) => {
        screen = next;
        cursor = nextCursor;
      },
    };
  }

  it('clears an OWN leftover draft on a non-generating screen, then steers', async () => {
    const harness = starvationHarness({
      initialScreen: idleScreenWithDraft(ownLeftoverText),
      ownTexts: [ownLeftoverText],
      onClear: () => harness.setScreen(idleInteractiveScreen),
    });

    const decision = await harness.wiring.evaluateInFlightSteer(pendingBatch('steer me'));

    expect(harness.clearOwnLeftoverDraft).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({ steer: true, turnLikelyEnded: true });
    expect(harness.starvations).toEqual([]);
  });

  it('clears controller slash-command residue even when the own-text registry cannot match it', async () => {
    const harness = starvationHarness({
      initialScreen: idleScreenWithDraft('/effort max/effort ultracode'),
      ownTexts: [ownLeftoverText],
      onClear: () => harness.setScreen(idleInteractiveScreen),
    });

    const decision = await harness.wiring.evaluateInFlightSteer(pendingBatch('steer me'));

    expect(harness.clearOwnLeftoverDraft).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({ steer: true, turnLikelyEnded: true });
    expect(harness.starvations).toEqual([]);
  });

  it('clear attempts are bounded; a surviving own draft falls back to the veto', async () => {
    const harness = starvationHarness({
      initialScreen: idleScreenWithDraft(ownLeftoverText),
      ownTexts: [ownLeftoverText],
    });

    const decision = await harness.wiring.evaluateInFlightSteer(pendingBatch('steer me'));

    expect(harness.clearOwnLeftoverDraft.mock.calls.length).toBeLessThanOrEqual(2);
    expect(decision).toMatchObject({ steer: false, reason: 'user_draft' });
  });

  it('NEVER clears while the screen is generating, even for an own leftover (Escape would interrupt the turn)', async () => {
    const harness = starvationHarness({
      initialScreen: generatingScreenWithDraftText(ownLeftoverText),
      ownTexts: [ownLeftoverText],
    });

    const decision = await harness.wiring.evaluateInFlightSteer(pendingBatch('steer me'));

    expect(harness.clearOwnLeftoverDraft).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ steer: false, reason: 'user_draft' });
  });

  it('NEVER clears a genuine user draft', async () => {
    const harness = starvationHarness({
      initialScreen: idleScreenWithDraft('my half-typed thought'),
      initialCursor: { x: 25, y: 1 },
      ownTexts: [ownLeftoverText],
    });

    const decision = await harness.wiring.evaluateInFlightSteer(pendingBatch('steer me'));

    expect(harness.clearOwnLeftoverDraft).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ steer: false, reason: 'user_draft' });
  });

  it('classifies contextual placeholder-looking plain captures as style-unavailable, not proven user drafts', async () => {
    const harness = starvationHarness({
      initialScreen: generatingScreenWithDraftText('read the current file'),
      ownTexts: [ownLeftoverText],
    });

    const decision = await harness.wiring.evaluateInFlightSteer(pendingBatch('steer me'));

    expect(harness.clearOwnLeftoverDraft).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ steer: false, reason: 'capture_style_unavailable' });
    expect(harness.telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: expect.objectContaining({
        decision: 'vetoed',
        reason: 'capture_style_unavailable',
        draftLength: 'read the current file'.length,
      }),
    });
  });

  it('escalates ONCE after N consecutive user_draft vetoes: honest published reason + one notification', async () => {
    const harness = starvationHarness({
      initialScreen: generatingScreenWithDraftText('my half-typed thought'),
      initialCursor: { x: 25, y: 2 },
      escalationThreshold: 3,
    });
    const batch = pendingBatch('steer me');

    await harness.wiring.evaluateInFlightSteer(batch);
    await harness.wiring.evaluateInFlightSteer(batch);
    expect(harness.starvations).toEqual([]);
    expect(harness.snapshots).toEqual([{ available: false, reason: 'unsafe_window' }]);

    await harness.wiring.evaluateInFlightSteer(batch);
    expect(harness.starvations).toEqual([
      { consecutiveVetoes: 3, ownLeftover: false, draftLength: 'my half-typed thought'.length },
    ]);
    expect(harness.snapshots).toEqual([
      { available: false, reason: 'unsafe_window' },
      { available: false, reason: 'user_terminal_draft' },
    ]);
    expect(harness.telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: expect.objectContaining({ decision: 'starvation_escalated', reason: 'user_draft' }),
    });

    // Further vetoes never re-notify (no infinite silent loop, but also no notification spam).
    await harness.wiring.evaluateInFlightSteer(batch);
    await harness.wiring.evaluateInFlightSteer(batch);
    expect(harness.starvations).toHaveLength(1);
  });

  it('a safe steer resets the starvation episode; a later episode escalates again', async () => {
    const harness = starvationHarness({
      initialScreen: generatingScreenWithDraftText('my half-typed thought'),
      initialCursor: { x: 25, y: 2 },
      escalationThreshold: 2,
    });
    const batch = pendingBatch('steer me');

    await harness.wiring.evaluateInFlightSteer(batch);
    await harness.wiring.evaluateInFlightSteer(batch);
    expect(harness.starvations).toHaveLength(1);

    harness.setScreen(generatingScreen);
    await expect(harness.wiring.evaluateInFlightSteer(batch)).resolves.toEqual({ steer: true });

    harness.setScreen(generatingScreenWithDraftText('another thought'), { x: 19, y: 2 });
    await harness.wiring.evaluateInFlightSteer(batch);
    await harness.wiring.evaluateInFlightSteer(batch);
    expect(harness.starvations).toHaveLength(2);
  });

  it('user_draft veto telemetry carries draft evidence (length + own-draft classification)', async () => {
    const harness = starvationHarness({
      initialScreen: generatingScreenWithDraftText(ownLeftoverText),
      ownTexts: [ownLeftoverText],
    });

    await harness.wiring.evaluateInFlightSteer(pendingBatch('steer me'));

    expect(harness.telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.steer.decision',
      properties: expect.objectContaining({
        decision: 'vetoed',
        reason: 'user_draft',
        draftLength: ownLeftoverText.length,
        ownDraft: true,
      }),
    });
  });
});
