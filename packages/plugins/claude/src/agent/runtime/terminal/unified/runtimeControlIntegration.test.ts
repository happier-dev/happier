import { describe, expect, it, vi } from 'vitest';

import {
  createClaudeUnifiedRuntimeConfigOutcomeEmitter,
  mapApplyOutcomeToUpdateOutcome,
  mapRuntimeConfigUpdateToDesired,
} from './runtimeControlIntegration.js';
import { aggregateApplyOutcome } from './tuiControls/outcome.js';

const CONTEXT = {
  launchPermissionMode: 'acceptEdits',
  effectiveModelId: 'claude-opus-4-7',
  supportsEffort: true,
} as const;

describe('mapRuntimeConfigUpdateToDesired', () => {
  it('maps modelId / effort / ultracode / plan-mode directives onto the desired config', () => {
    expect(mapRuntimeConfigUpdateToDesired({ modelId: 'claude-sonnet-4-6' }, CONTEXT)).toEqual({
      kind: 'desired',
      desired: { model: 'claude-sonnet-4-6' },
    });
    expect(mapRuntimeConfigUpdateToDesired({ configOption: { id: 'reasoning_effort', value: 'high' } }, CONTEXT)).toEqual({
      kind: 'desired',
      desired: { reasoningEffort: 'high' },
    });
    expect(mapRuntimeConfigUpdateToDesired({ configOption: { id: 'ultracode', value: true } }, CONTEXT)).toEqual({
      kind: 'desired',
      desired: { ultracode: true },
    });
    expect(mapRuntimeConfigUpdateToDesired({ permissionMode: 'acceptEdits' }, CONTEXT)).toEqual({
      kind: 'desired',
      desired: { permissionMode: 'acceptEdits' },
    });
    expect(mapRuntimeConfigUpdateToDesired({ modeId: 'plan' }, CONTEXT)).toEqual({
      kind: 'desired',
      desired: { agentModeId: 'plan' },
    });
  });

  it('cycles back to the launch permission mode when a non-plan mode id arrives (plan exit)', () => {
    expect(mapRuntimeConfigUpdateToDesired({ modeId: 'code' }, CONTEXT)).toEqual({
      kind: 'desired',
      desired: { agentModeId: null, permissionMode: 'acceptEdits' },
    });
    expect(mapRuntimeConfigUpdateToDesired({ modeId: 'code' }, { ...CONTEXT, launchPermissionMode: null })).toEqual({
      kind: 'desired',
      desired: { agentModeId: null, permissionMode: 'default' },
    });
  });

  it('rejects effort controls when the installed CLI or effective model cannot honor them', () => {
    expect(
      mapRuntimeConfigUpdateToDesired(
        { configOption: { id: 'ultracode', value: true } },
        { ...CONTEXT, effectiveModelId: 'claude-sonnet-4-6' },
      ),
    ).toEqual({ kind: 'not_controllable', reason: 'ultracode_unsupported_for_model' });
    expect(
      mapRuntimeConfigUpdateToDesired(
        { configOption: { id: 'reasoning_effort', value: 'xhigh' } },
        { ...CONTEXT, supportsEffort: false },
      ),
    ).toEqual({ kind: 'not_controllable', reason: 'effort_unsupported_by_installed_cli' });
  });

  it('preserves a supported native effort for live TUI control', () => {
    expect(mapRuntimeConfigUpdateToDesired(
      { configOption: { id: 'reasoning_effort', value: 'max' } },
      { ...CONTEXT, effectiveModelId: 'claude-sonnet-4-6' },
    )).toEqual({ kind: 'desired', desired: { reasoningEffort: 'max' } });
  });

  it('uses the exact Provider descriptor without native downgrade or Claude-id inference', () => {
    const providerModel = {
      id: 'claude-opus-4-8',
      name: 'Gateway Opus',
      capabilities: { reasoningControls: 'supported' as const },
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Reasoning',
        type: 'select' as const,
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      }],
    };
    const providerContext = { ...CONTEXT, effectiveModelId: providerModel.id, providerModel };

    expect(mapRuntimeConfigUpdateToDesired(
      { configOption: { id: 'reasoning_effort', value: 'max' } },
      providerContext,
    )).toEqual({ kind: 'not_controllable', reason: 'effort_unsupported_for_model' });
    expect(mapRuntimeConfigUpdateToDesired(
      { configOption: { id: 'ultracode', value: true } },
      providerContext,
    )).toEqual({ kind: 'not_controllable', reason: 'ultracode_unsupported_for_model' });
  });

  it('does not consume the retired plural configOptions alias', () => {
    expect(mapRuntimeConfigUpdateToDesired({ configOptions: { reasoning_effort: 'high' } }, CONTEXT)).toEqual({
      kind: 'not_controllable',
      reason: 'unknown_directive:configOptions',
    });
  });

  it('fails the whole update over to the legacy path for non-controllable directives', () => {
    expect(mapRuntimeConfigUpdateToDesired({ modelId: 'default' }, CONTEXT).kind).toBe('not_controllable');
    expect(mapRuntimeConfigUpdateToDesired({ fallbackModel: 'claude-haiku-4-5' }, CONTEXT).kind).toBe('not_controllable');
    expect(mapRuntimeConfigUpdateToDesired({ configOption: { id: 'mystery', value: 1 } }, CONTEXT).kind).toBe('not_controllable');
    expect(mapRuntimeConfigUpdateToDesired({ somethingNew: true }, CONTEXT).kind).toBe('not_controllable');
    // A model change alongside an unknown directive must not be partially honored.
    expect(mapRuntimeConfigUpdateToDesired({ modelId: 'sonnet', somethingNew: true }, CONTEXT).kind).toBe('not_controllable');
    expect(mapRuntimeConfigUpdateToDesired({}, CONTEXT).kind).toBe('not_controllable');
  });
});

describe('mapApplyOutcomeToUpdateOutcome', () => {
  it('projects aggregate status/timing and the first change reason', () => {
    const outcome = aggregateApplyOutcome([
      { key: 'model', status: 'applied', timing: 'before_next_prompt' },
    ]);
    expect(mapApplyOutcomeToUpdateOutcome(outcome)).toEqual({ status: 'applied', timing: 'before_next_prompt' });

    const deferred = aggregateApplyOutcome([
      { key: 'reasoningEffort', status: 'applied', timing: 'next_idle', reason: 'generating' },
    ]);
    expect(mapApplyOutcomeToUpdateOutcome(deferred)).toEqual({ status: 'applied', timing: 'next_idle', reason: 'generating' });

    const failed = aggregateApplyOutcome([
      { key: 'model', status: 'failed', reason: 'not_delivered' },
    ]);
    expect(mapApplyOutcomeToUpdateOutcome(failed)).toMatchObject({ status: 'failed', reason: 'not_delivered' });
  });
});

describe('createClaudeUnifiedRuntimeConfigOutcomeEmitter', () => {
  it('groups changes per public status and emits one accurate event per group', () => {
    const sendSessionEvent = vi.fn();
    const emitter = createClaudeUnifiedRuntimeConfigOutcomeEmitter({ sendSessionEvent });

    emitter.emit(aggregateApplyOutcome([
      { key: 'model', status: 'applied', timing: 'before_next_prompt', requested: 'sonnet', effective: 'Sonnet 4.6' },
      { key: 'reasoningEffort', status: 'applied', timing: 'before_next_prompt', requested: 'high', effective: 'high' },
      { key: 'maxThinkingTokens', status: 'unsupported', requested: 4096, reason: 'no_tui_control' },
    ]));

    expect(sendSessionEvent).toHaveBeenCalledTimes(2);
    expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime-config-outcome',
      agentId: 'claude',
      runtime: 'claude-unified-terminal',
      status: 'applied',
      timing: 'before_next_prompt',
      changes: [
        expect.objectContaining({ key: 'model', requested: 'sonnet', effective: 'Sonnet 4.6' }),
        expect.objectContaining({ key: 'reasoningEffort', requested: 'high' }),
      ],
    }));
    expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'unsupported',
      reason: 'no_tui_control',
      changes: [expect.objectContaining({ key: 'maxThinkingTokens' })],
    }));
  });

  it('emits the sessionMode change key directly (frozen contract includes it)', () => {
    const sendSessionEvent = vi.fn();
    const emitter = createClaudeUnifiedRuntimeConfigOutcomeEmitter({ sendSessionEvent });

    emitter.emit(aggregateApplyOutcome([
      { key: 'sessionMode', status: 'applied', timing: 'current_window', requested: 'plan', effective: 'plan' },
    ]));

    expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'applied',
      changes: [expect.objectContaining({ key: 'sessionMode', effective: 'plan' })],
    }));
  });

  it('dedups unchanged (status,timing,reason) signatures and re-emits only on transitions', () => {
    const sendSessionEvent = vi.fn();
    const emitter = createClaudeUnifiedRuntimeConfigOutcomeEmitter({ sendSessionEvent });
    const blocked = aggregateApplyOutcome([
      { key: 'reasoningEffort', status: 'applied', timing: 'queued_until_safe_window', requested: 'high', reason: 'unsafe_overlay' },
    ]);

    emitter.emit(blocked);
    emitter.emit(blocked);
    emitter.emit(blocked);
    expect(sendSessionEvent).toHaveBeenCalledTimes(1);

    emitter.emit(aggregateApplyOutcome([
      { key: 'reasoningEffort', status: 'applied', timing: 'before_next_prompt', requested: 'high', effective: 'high' },
    ]));
    expect(sendSessionEvent).toHaveBeenCalledTimes(2);
  });
});
