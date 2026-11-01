import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import type { Session } from '../session';
import { createClaudeSessionModelsReconciler } from '../sessionModels/reconcileClaudeSessionModelsState';
import { createClaudeStatuslineApplier } from './applyClaudeStatuslineUpdate';
import type { ClaudeStatuslinePayload } from './statuslinePayload';

// Boundary mock: ApiSessionClient is the server transport. updateMetadata applies the updater to
// an in-memory metadata object so assertions target resulting state, not call wiring.
function createSessionFixture(params?: Readonly<{
  sessionId?: string | null;
  transcriptPath?: string | null;
  metadata?: Metadata;
}>): Readonly<{
  session: Session;
  getMetadata: () => Metadata;
  getUpdateMetadataCallCount: () => number;
  getSessionEventCalls: () => readonly Readonly<{ event: unknown; id: string | undefined }>[];
  getRuntimeReconcileCalls: () => readonly Readonly<{ model?: string; reasoningEffort?: string }>[];
}> {
  let metadata: Metadata = params?.metadata ?? {} as Metadata;
  let updateMetadataCallCount = 0;
  const sessionEventCalls: Array<Readonly<{ event: unknown; id: string | undefined }>> = [];
  const runtimeReconcileCalls: Readonly<{ model?: string; reasoningEffort?: string }>[] = [];
  const session = {
    sessionId: params?.sessionId ?? null,
    transcriptPath: params?.transcriptPath ?? null,
    reconcileSessionModels: createClaudeSessionModelsReconciler(),
    reconcileClaudeRuntimeFromStatusline: (input: Readonly<{ model?: string; reasoningEffort?: string }>) => {
      runtimeReconcileCalls.push(input);
    },
    client: {
      sessionId: 'happy-session-id',
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent: vi.fn((event: unknown, id?: string) => {
        sessionEventCalls.push({ event, id });
      }),
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        updateMetadataCallCount += 1;
        metadata = updater(metadata);
      },
      getMetadataSnapshot: () => metadata,
    },
  } as unknown as Session;
  return {
    session,
    getMetadata: () => metadata,
    getUpdateMetadataCallCount: () => updateMetadataCallCount,
    getSessionEventCalls: () => sessionEventCalls,
    getRuntimeReconcileCalls: () => runtimeReconcileCalls,
  };
}

function buildPayload(overrides?: Partial<ClaudeStatuslinePayload>): ClaudeStatuslinePayload {
  return {
    session_id: 'claude-session-id',
    transcript_path: '/tmp/transcript.jsonl',
    model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
    context_window: { context_window_size: 200_000, current_usage: null },
    version: '2.1.170',
    exceeds_200k_tokens: false,
    fast_mode: false,
    thinking: { enabled: true },
    ...overrides,
  };
}

describe('createClaudeStatuslineApplier', () => {
  it('publishes observed effort changes without overwriting the requested effort', () => {
    const fixture = createSessionFixture({ sessionId: 'claude-session-id', metadata: createTestMetadata({
      sessionConfigOptionOverridesV1: { v: 1, updatedAt: 20, overrides: { reasoning_effort: { value: 'medium', updatedAt: 20 } } },
    }) });
    fixture.session.reconcileSessionModels({ metadata: fixture.getMetadata(), source: 'catalog', incomingState: {
      v: 1, provider: 'claude', updatedAt: 10, currentModelId: 'claude-sonnet-4-6', availableModels: [{
        id: 'claude-sonnet-4-6', name: 'Sonnet', modelOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high' }],
      }],
    } });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });
    for (const reasoningEffort of ['low', 'medium']) {
      applier.apply(fixture.session, buildPayload({ model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet' }, effort: { level: reasoningEffort } }));
      expect(fixture.getMetadata().sessionModelsV1?.availableModels[0]?.modelOptions?.[0]?.currentValue).toBe(reasoningEffort);
    }
    expect(fixture.getMetadata().sessionConfigOptionOverridesV1?.overrides.reasoning_effort?.value).toBe('medium');
    expect(fixture.getMetadata().sessionModelsV1?.updatedAt).toBe(10);
    expect(fixture.getMetadata().sessionModelsV1).toEqual(fixture.getMetadata().acpSessionModelsV1);
  });

  it('adopts the live model and direct context window into session models metadata', () => {
    const fixture = createSessionFixture({ sessionId: 'claude-session-id' });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload());

    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-haiku-4-5-20251001',
      availableModels: [
        {
          id: 'claude-haiku-4-5-20251001',
          name: 'Haiku 4.5',
          contextWindowTokens: 200_000,
        },
      ],
    });
    expect(fixture.getMetadata().acpSessionModelsV1).toMatchObject({
      currentModelId: 'claude-haiku-4-5-20251001',
    });
    expect(fixture.getMetadata().sessionAppliedModelV1).toMatchObject({
      v: 1, provider: 'claude', modelId: 'claude-haiku-4-5-20251001',
    });
  });

  it('repairs Running from an observation even when current-model metadata already matches', () => {
    const fixture = createSessionFixture({ sessionId: 'claude-session-id', metadata: createTestMetadata({
      sessionModelsV1: {
        v: 1, provider: 'claude', updatedAt: 1, currentModelId: 'claude-haiku-4-5-20251001',
        availableModels: [{ id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', contextWindowTokens: 200_000 }],
      },
      sessionAppliedModelV1: { v: 1, provider: 'claude', updatedAt: 2, modelId: 'requested-but-refused' },
    }) });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });
    applier.apply(fixture.session, buildPayload());
    expect(fixture.getMetadata().sessionAppliedModelV1?.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('dedupes repeated identical payloads to a single metadata write', () => {
    const fixture = createSessionFixture({ sessionId: 'claude-session-id' });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload());
    applier.apply(fixture.session, buildPayload());
    applier.apply(fixture.session, buildPayload());

    expect(fixture.getUpdateMetadataCallCount()).toBe(1);
  });

  it('writes again when the model or window changes', () => {
    const fixture = createSessionFixture({ sessionId: 'claude-session-id' });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload());
    applier.apply(fixture.session, buildPayload({
      model: { id: 'claude-fable-5', display_name: 'Fable 5' },
      context_window: { context_window_size: 1_000_000 },
    }));

    expect(fixture.getUpdateMetadataCallCount()).toBe(2);
    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      currentModelId: 'claude-fable-5',
      availableModels: [
        expect.objectContaining({ id: 'claude-fable-5', contextWindowTokens: 1_000_000 }),
      ],
    });
  });

  it('emits one visible session event when the statusline reports an active model transition', () => {
    const fixture = createSessionFixture({ sessionId: 'claude-session-id' });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload({
      model: { id: 'claude-fable-5', display_name: 'Fable 5' },
    }));
    applier.apply(fixture.session, buildPayload({
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    }));
    applier.apply(fixture.session, buildPayload({
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    }));

    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-opus-4-8',
    });
    expect(fixture.getSessionEventCalls()).toEqual([
      {
        event: { type: 'message', message: 'Model changed to Opus 4.8' },
        id: 'claude:model-changed:claude-fable-5:claude-opus-4-8',
      },
    ]);
  });

  it('ignores payloads from a foreign Claude session', () => {
    const fixture = createSessionFixture({
      sessionId: 'other-claude-session',
      transcriptPath: '/tmp/other.jsonl',
    });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload());

    expect(fixture.getUpdateMetadataCallCount()).toBe(0);
    expect(fixture.getMetadata().sessionModelsV1).toBeUndefined();
  });

  it('accepts early payloads arriving before the session id is known', () => {
    const fixture = createSessionFixture({ sessionId: null, transcriptPath: null });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload());

    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      currentModelId: 'claude-haiku-4-5-20251001',
    });
  });

  it('matches by transcript path when the Claude session id rotated', () => {
    const fixture = createSessionFixture({
      sessionId: 'old-session-id',
      transcriptPath: '/tmp/transcript.jsonl',
    });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload({ session_id: 'new-session-id' }));

    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      currentModelId: 'claude-haiku-4-5-20251001',
    });
  });

  it('tolerates payloads without model or context window data', () => {
    const fixture = createSessionFixture({ sessionId: 'claude-session-id' });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, { session_id: 'claude-session-id' });
    applier.apply(fixture.session, buildPayload({ context_window: undefined }));

    expect(fixture.getUpdateMetadataCallCount()).toBe(1);
    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      currentModelId: 'claude-haiku-4-5-20251001',
    });
  });
});

describe('createClaudeStatuslineApplier — runtime reconcile feed (lane Y)', () => {
  it('feeds model + effort into the session runtime reconciler, deduped on real change', () => {
    const fixture = createSessionFixture({ sessionId: 'claude-session-id' });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload({ effort: { level: 'high' } }));
    applier.apply(fixture.session, buildPayload({ effort: { level: 'high' } }));

    expect(fixture.getRuntimeReconcileCalls()).toEqual([
      { model: 'claude-haiku-4-5-20251001', reasoningEffort: 'high' },
    ]);

    // An effort-only change re-feeds the reconciler, but Haiku has no effort control to publish.
    applier.apply(fixture.session, buildPayload({ effort: { level: 'medium' } }));
    expect(fixture.getRuntimeReconcileCalls()).toEqual([
      { model: 'claude-haiku-4-5-20251001', reasoningEffort: 'high' },
      { model: 'claude-haiku-4-5-20251001', reasoningEffort: 'medium' },
    ]);
    expect(fixture.getUpdateMetadataCallCount()).toBe(1);
  });

  it('omits reasoningEffort when the payload carries no effort (haiku)', () => {
    const fixture = createSessionFixture({ sessionId: 'claude-session-id' });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload());

    expect(fixture.getRuntimeReconcileCalls()).toEqual([
      { model: 'claude-haiku-4-5-20251001' },
    ]);
  });

  it('does not reconcile from foreign/stale session payloads', () => {
    const fixture = createSessionFixture({
      sessionId: 'other-claude-session',
      transcriptPath: '/tmp/other.jsonl',
    });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload());

    expect(fixture.getRuntimeReconcileCalls()).toHaveLength(0);
  });

  it('never writes desired-state surfaces (modelOverrideV1 / permissionMode / acpSessionModeOverrideV1)', () => {
    const fixture = createSessionFixture({ sessionId: 'claude-session-id' });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    applier.apply(fixture.session, buildPayload({ effort: { level: 'high' } }));

    const metadata = fixture.getMetadata();
    expect(metadata.modelOverrideV1).toBeUndefined();
    expect(metadata.permissionMode).toBeUndefined();
    expect(metadata.permissionModeUpdatedAt).toBeUndefined();
    expect(metadata.acpSessionModeOverrideV1).toBeUndefined();
    // Only the effective/display surfaces are written.
    expect(Object.keys(metadata).sort()).toEqual(['acpSessionModelsV1', 'sessionAppliedModelV1', 'sessionModelsV1']);
  });
});
