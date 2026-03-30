import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const resolveSessionTransportContext = vi.fn();
const execute = vi.fn();
const createCliActionExecutor = vi.fn(() => ({ execute }));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

vi.mock('@/session/actions/createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

describe('happier session actions --json contract', () => {
  let protocol: typeof import('@happier-dev/protocol');
  let handleSessionCommand: typeof import('../index').handleSessionCommand;

  beforeAll(async () => {
    protocol = await import('@happier-dev/protocol');
    ({ handleSessionCommand } = await import('../index'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess_protocol_actions_execute_1',
      rawSession: { id: 'sess_protocol_actions_execute_1', metadata: {} },
      ctx: { type: 'plain' as const },
      mode: 'plain' as const,
    });
    execute.mockResolvedValue({ ok: true, result: { started: true } });
  });

  it('prints a SessionActionsListEnvelopeSchema-compatible payload', { timeout: 60_000 }, async () => {
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'list', '--json']);
      const parsed = output.json();
      expect(protocol.SessionActionsListEnvelopeSchema.safeParse(parsed).success).toBe(true);
    } finally {
      output.restore();
    }
  });

  it('prints a SessionActionsDescribeEnvelopeSchema-compatible payload', { timeout: 60_000 }, async () => {
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'describe', 'review.start', '--json']);
      const parsed = output.json();
      expect(protocol.SessionActionsDescribeEnvelopeSchema.safeParse(parsed).success).toBe(true);
    } finally {
      output.restore();
    }
  });

  it('prints a SessionActionsExecuteEnvelopeSchema-compatible payload', { timeout: 60_000 }, async () => {
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(
        ['actions', 'execute', 'sess_protocol_actions_execute_1', 'review.start', '--input-json', '{"instructions":"Review."}', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          }),
        },
      );
      const parsed = output.json();
      expect(protocol.SessionActionsExecuteEnvelopeSchema.safeParse(parsed).success).toBe(true);
    } finally {
      output.restore();
    }
  });
});
