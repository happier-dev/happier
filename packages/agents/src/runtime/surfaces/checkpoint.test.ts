import { describe, expect, it } from 'vitest';

import * as checkpointSurface from './checkpoint.js';

type CheckpointSurfaceRuntimeContract = Readonly<{
  parseCheckpointAvailabilityRequestV1?: (input: unknown) => unknown;
  parseCreateCheckpointRequestV1?: (input: unknown) => unknown;
  parseResolveCheckpointRestoreTargetRequestV1?: (input: unknown) => unknown;
  parseRestoreCheckpointRequestV1?: (input: unknown) => unknown;
}>;

const runtimeContract = checkpointSurface as CheckpointSurfaceRuntimeContract;

describe('checkpoint surface request contracts', () => {
  it('requires restore requests to provide exactly one anchor or target', () => {
    expect(runtimeContract.parseRestoreCheckpointRequestV1).toBeTypeOf('function');
    const parse = runtimeContract.parseRestoreCheckpointRequestV1!;

    expect(() => parse({
      sessionId: 'session-1',
      scopes: ['conversation'],
    })).toThrow(/exactly one/i);

    expect(() => parse({
      sessionId: 'session-1',
      anchor: { kind: 'before_user_message', messageId: 'message-1' },
      target: { kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' },
      scopes: ['conversation'],
    })).toThrow(/exactly one/i);
  });

  it('accepts only the final semantic restore anchor shape', () => {
    expect(runtimeContract.parseResolveCheckpointRestoreTargetRequestV1).toBeTypeOf('function');
    const parse = runtimeContract.parseResolveCheckpointRestoreTargetRequestV1!;

    expect(parse({
      sessionId: 'session-1',
      anchor: {
        kind: 'before_user_message',
        messageId: 'message-1',
        evidence: {
          turnId: 'turn-1',
          messageSeq: 7,
          seqRange: {
            startSeqInclusive: 4,
            endSeqInclusive: 8,
          },
        },
      },
      scopes: ['conversation'],
    })).toMatchObject({
      anchor: {
        kind: 'before_user_message',
        messageId: 'message-1',
      },
    });

    const staleUserMessageSeqAnchor = `user_${'message_seq'}`;
    expect(() => parse({
      sessionId: 'session-1',
      anchor: { kind: staleUserMessageSeqAnchor, seq: 7 },
      scopes: ['conversation'],
    })).toThrow(/before_user_message/i);
  });

  it('preserves explicit provider target classes without generic ids', () => {
    expect(runtimeContract.parseRestoreCheckpointRequestV1).toBeTypeOf('function');
    const parse = runtimeContract.parseRestoreCheckpointRequestV1!;

    expect(parse({
      sessionId: 'session-1',
      target: { kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' },
      scopes: ['conversation'],
    })).toMatchObject({
      target: { kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' },
    });

    expect(parse({
      sessionId: 'session-1',
      target: { kind: 'provider_message', messageId: 'message-1' },
      scopes: ['conversation'],
    })).toMatchObject({
      target: { kind: 'provider_message', messageId: 'message-1' },
    });

    expect(parse({
      sessionId: 'session-1',
      target: { kind: 'provider_turn', turnId: 'turn-1' },
      scopes: ['conversation'],
    })).toMatchObject({
      target: { kind: 'provider_turn', turnId: 'turn-1' },
    });

    expect(parse({
      sessionId: 'session-1',
      target: { kind: 'provider_restore_token', token: 'opaque-token-1' },
      scopes: ['conversation'],
    })).toMatchObject({
      target: { kind: 'provider_restore_token', token: 'opaque-token-1' },
    });

    expect(() => parse({
      sessionId: 'session-1',
      target: {
        kind: 'provider_checkpoint',
        id: 'checkpoint-1',
      },
      scopes: ['conversation'],
    })).toThrow(/checkpointId/i);
  });

  it('allows availability checks for restore-target resolution with semantic anchor context', () => {
    expect(runtimeContract.parseCheckpointAvailabilityRequestV1).toBeTypeOf('function');
    const parse = runtimeContract.parseCheckpointAvailabilityRequestV1!;

    expect(parse({
      operation: 'resolveRestoreTarget',
      sessionId: 'session-1',
      anchor: { kind: 'before_user_message', messageId: 'message-1' },
      scopes: ['conversation'],
      timing: 'idle',
    })).toMatchObject({
      operation: 'resolveRestoreTarget',
      anchor: { kind: 'before_user_message', messageId: 'message-1' },
    });

    expect(() => parse({
      operation: 'resolveRestoreTarget',
      sessionId: 'session-1',
      scopes: ['conversation'],
      timing: 'idle',
    })).toThrow(/anchor/i);

    expect(() => parse({
      operation: 'restore',
      sessionId: 'session-1',
      scopes: ['conversation'],
      timing: 'idle',
    })).toThrow(/exactly one/i);
  });

  it('validates create-checkpoint requests before handler dispatch', () => {
    expect(runtimeContract.parseCreateCheckpointRequestV1).toBeTypeOf('function');
    const parse = runtimeContract.parseCreateCheckpointRequestV1!;

    expect(parse({
      sessionId: 'session-1',
      scopes: ['conversation', 'workspace'],
      timing: 'idle',
      label: 'before risky edit',
    })).toMatchObject({
      sessionId: 'session-1',
      scopes: ['conversation', 'workspace'],
      timing: 'idle',
    });

    expect(() => parse({
      sessionId: 'session-1',
      scopes: [],
      timing: 'idle',
    })).toThrow(/scopes/i);

    expect(() => parse({
      sessionId: 'session-1',
      scopes: ['conversation'],
    })).toThrow(/timing/i);
  });

  it('rejects duplicate scope selections at the provider surface boundary', () => {
    expect(runtimeContract.parseCreateCheckpointRequestV1).toBeTypeOf('function');
    expect(runtimeContract.parseRestoreCheckpointRequestV1).toBeTypeOf('function');
    expect(runtimeContract.parseResolveCheckpointRestoreTargetRequestV1).toBeTypeOf('function');

    expect(() => runtimeContract.parseCreateCheckpointRequestV1!({
      sessionId: 'session-1',
      scopes: ['workspace', 'workspace'],
      timing: 'idle',
    })).toThrow(/duplicates/i);

    expect(() => runtimeContract.parseRestoreCheckpointRequestV1!({
      sessionId: 'session-1',
      target: { kind: 'provider_checkpoint', checkpointId: 'checkpoint-1' },
      scopes: ['conversation', 'conversation'],
    })).toThrow(/duplicates/i);

    expect(() => runtimeContract.parseResolveCheckpointRestoreTargetRequestV1!({
      sessionId: 'session-1',
      anchor: { kind: 'before_user_message', messageId: 'message-1' },
      scopes: ['workspace', 'workspace'],
    })).toThrow(/duplicates/i);
  });
});
