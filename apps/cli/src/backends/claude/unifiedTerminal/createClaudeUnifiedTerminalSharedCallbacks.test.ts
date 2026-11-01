import { describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedTerminalSharedCallbacks } from './createClaudeUnifiedTerminalSharedCallbacks';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { applyClaudeEffectiveModelUpdate } from '../sessionModels/effectiveModelUpdate';
import { createClaudeSessionModelsReconciler } from '../sessionModels/reconcileClaudeSessionModelsState';

describe('createClaudeUnifiedTerminalSharedCallbacks', () => {
  it('shares clear and metadata-applier lifecycle behavior across launcher corridors', async () => {
    const wakePendingMaterialization = vi.fn();
    const flushPendingMetadataMode = vi.fn(async () => undefined);
    let metadataApplier: ((mode: never) => Promise<never>) | null = null;
    const reconcileModels = createClaudeSessionModelsReconciler();
    let metadata = createTestMetadata({ sessionModelsV1: reconcileModels({ metadata: null, source: 'catalog', incomingState: {
      v: 1, provider: 'claude', updatedAt: 10, currentModelId: 'claude-sonnet-4-6', availableModels: [{
        id: 'claude-sonnet-4-6', name: 'Sonnet', modelOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high' }],
      }],
    } }) });
    const sessionClient = {
      sendSessionEvent: vi.fn(),
      hasActiveCanonicalTurn: () => false,
      getMetadataSnapshot: () => metadata,
      updateMetadata: async (updater: (prev: Metadata) => Metadata) => { metadata = updater(metadata); },
    };
    const callbacks = createClaudeUnifiedTerminalSharedCallbacks({
      sessionClient,
      reconcileModels,
      observeInFlightSteerAvailabilitySnapshot: vi.fn(),
      sustainedPendingDeliveryBlockHandler: {
        blockForSustainedBlocker: vi.fn(async () => false),
        wakePendingMaterialization,
      },
      dialogChoiceBroker: {} as never,
      tuiRuntimeControlEnabled: true,
      registerStatuslineRuntimeReconciler: vi.fn(() => () => undefined),
      getMetadataRuntimeModeApplier: () => metadataApplier,
      setMetadataRuntimeModeApplier: (apply) => {
        metadataApplier = apply as typeof metadataApplier;
      },
      flushPendingMetadataMode,
      logPrefix: '[test]',
      logDebug: vi.fn(),
    });

    callbacks.onDraftGuardClear?.();
    callbacks.tuiRuntimeControl.onBlockedApplyClear?.();
    expect(wakePendingMaterialization).toHaveBeenCalledTimes(2);

    const apply = vi.fn(async () => ({ promptMayProceed: true, attempted: true }));
    const unregister = callbacks.tuiRuntimeControl.registerMetadataRuntimeModeApplier?.(apply);
    expect(metadataApplier).toBe(apply);
    expect(flushPendingMetadataMode).toHaveBeenCalledOnce();

    unregister?.();
    expect(metadataApplier).toBeNull();

    callbacks.tuiRuntimeControl.emitRuntimeConfigOutcome({ status: 'applied', timing: 'before_next_prompt', message: '',
      changes: [{ key: 'reasoningEffort', requested: 'low', effective: 'low' }],
    });
    // A catalog/selection currentModelId is not evidence that Claude is running it.
    expect(metadata.sessionAppliedModelV1).toBeUndefined();
    expect(metadata.sessionModelsV1?.availableModels[0]?.modelOptions?.[0]?.currentValue).toBe('high');
    applyClaudeEffectiveModelUpdate({
      client: sessionClient, reconcileModels, modelId: 'claude-sonnet-4-6', source: 'statusline', logPrefix: '[test]',
    });
    callbacks.tuiRuntimeControl.emitRuntimeConfigOutcome({ status: 'applied', timing: 'before_next_prompt', message: '',
      changes: [{ key: 'reasoningEffort', requested: 'low', effective: 'low' }],
    });
    expect(metadata.sessionModelsV1?.availableModels[0]?.modelOptions?.[0]?.currentValue).toBe('low');
    for (const outcome of [
      { status: 'applied', timing: 'scheduled_for_next_prompt', message: '', changes: [{ key: 'reasoningEffort', requested: 'medium', effective: 'medium' }] },
      { status: 'applied', timing: 'current_window', message: '', changes: [{ key: 'reasoningEffort', requested: 'medium', effective: 'medium', reason: 'delivered_unverified' }] },
    ] as const) callbacks.tuiRuntimeControl.emitRuntimeConfigOutcome(outcome);
    expect(metadata.sessionModelsV1?.availableModels[0]?.modelOptions?.[0]?.currentValue).toBe('low');
  });
});
