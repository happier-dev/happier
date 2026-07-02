import { describe, expect, it } from 'vitest';

async function loadContract(): Promise<Record<string, any> | null> {
  try {
    const modulePath = './v1';
    return await import(modulePath);
  } catch {
    return null;
  }
}

describe('session checkpoint/restore protocol contract', () => {
  it('requires session.restore inputs to use a source-qualified candidate', async () => {
    const contract = await loadContract();
    expect(contract).not.toBeNull();
    if (!contract) return;

    const parsed = contract.SessionRestoreRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace'],
      candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        turnId: 'turn-1',
      },
      confirmation: {
        sourceChoiceConfirmed: true,
      },
    });

    expect(parsed.success).toBe(true);
    expect(contract.SessionRestoreRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace'],
      checkpointId: 'checkpoint-1',
    }).success).toBe(false);
  });

  it('requires session.restore inputs to provide exactly one target selector', async () => {
    const contract = await loadContract();
    expect(contract).not.toBeNull();
    if (!contract) return;

    expect(contract.SessionRestoreRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace'],
    }).success).toBe(false);

    expect(contract.SessionRestoreRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace'],
      anchor: { kind: 'before_user_message', messageId: 'message-1' },
      candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
    }).success).toBe(false);
  });

  it('sanitizes provider restore tokens in operation receipts', async () => {
    const contract = await loadContract();
    expect(contract).not.toBeNull();
    if (!contract) return;

    const receipt = contract.buildCheckpointOperationReceiptV1({
      operation: 'restore',
      phase: 'succeeded',
      lifecycleId: 'restore-1',
      source: 'provider',
      scopes: ['conversation'],
      candidate: {
        source: 'provider',
        backendId: 'claude',
        target: {
          kind: 'provider_restore_token',
          token: 'raw-provider-token',
        },
      },
    });

    expect(JSON.stringify(receipt)).not.toContain('raw-provider-token');
    expect(receipt.candidate.target).toEqual({
      kind: 'provider_restore_token',
      redacted: true,
    });
  });

  it('requires composed restore candidates to declare per-part scope selections', async () => {
    const contract = await loadContract();
    expect(contract).not.toBeNull();
    if (!contract) return;

    const parsed = contract.SessionRestoreRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['conversation', 'workspace'],
      candidate: {
        source: 'composed',
        parts: [
          {
            scopes: ['conversation'],
            candidate: {
              source: 'provider',
              backendId: 'claude',
              target: {
                kind: 'provider_checkpoint',
                checkpointId: 'provider-conversation-1',
              },
            },
          },
          {
            scopes: ['workspace'],
            candidate: {
              source: 'happier_scm',
              checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
            },
          },
        ],
      },
      confirmation: { sourceChoiceConfirmed: true },
    });

    expect(parsed.success).toBe(true);
    expect(contract.SessionRestoreRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['conversation', 'workspace'],
      candidate: {
        source: 'composed',
        parts: [
          {
            source: 'provider',
            backendId: 'claude',
            target: {
              kind: 'provider_checkpoint',
              checkpointId: 'provider-conversation-1',
            },
          },
          {
            source: 'happier_scm',
            checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
          },
        ],
      },
      confirmation: { sourceChoiceConfirmed: true },
    }).success).toBe(false);
  });

  it('rejects duplicate checkpoint and restore scope selections', async () => {
    const contract = await loadContract();
    expect(contract).not.toBeNull();
    if (!contract) return;

    expect(contract.SessionRestoreRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace', 'workspace'],
      candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      confirmation: { sourceChoiceConfirmed: true },
    }).success).toBe(false);

    expect(contract.SessionRestoreRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['conversation', 'workspace'],
      candidate: {
        source: 'composed',
        parts: [
          {
            scopes: ['conversation'],
            candidate: {
              source: 'provider',
              backendId: 'claude',
              target: {
                kind: 'provider_checkpoint',
                checkpointId: 'provider-conversation-1',
              },
            },
          },
          {
            scopes: ['conversation', 'workspace'],
            candidate: {
              source: 'happier_scm',
              checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
            },
          },
        ],
      },
      confirmation: { sourceChoiceConfirmed: true },
    }).success).toBe(false);

    expect(contract.SessionCheckpointRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['conversation', 'workspace'],
      candidate: {
        source: 'composed',
        parts: [
          {
            scopes: ['conversation'],
            candidate: {
              source: 'provider',
              backendId: 'claude',
            },
          },
          {
            scopes: ['conversation', 'workspace'],
            candidate: {
              source: 'happier_scm',
            },
          },
        ],
      },
      confirmation: { sourceChoiceConfirmed: true },
    }).success).toBe(false);
  });

  it('requires checkpoint creation to execute an explicit creation candidate', async () => {
    const contract = await loadContract();
    expect(contract).not.toBeNull();
    if (!contract) return;

    const parsed = contract.SessionCheckpointRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['conversation', 'workspace'],
      candidate: {
        source: 'composed',
        parts: [
          {
            scopes: ['conversation'],
            candidate: {
              source: 'provider',
              backendId: 'claude',
            },
          },
          {
            scopes: ['workspace'],
            candidate: {
              source: 'happier_scm',
            },
          },
        ],
      },
      confirmation: { sourceChoiceConfirmed: true },
    });

    expect(parsed.success).toBe(true);
    expect(contract.SessionCheckpointRequestV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      scopes: ['workspace'],
      source: 'happier_scm',
      confirmation: { sourceChoiceConfirmed: true },
    }).success).toBe(false);
  });
});
