import { describe, expect, it, vi } from 'vitest';
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

describe('happier session actions (unit)', () => {
  it('prints a JSON envelope for actions execute', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: {},
      },
      ctx: { type: 'plain' as const },
      mode: 'plain' as const,
    });
    execute.mockResolvedValueOnce({ ok: true, result: { started: true } });

    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'execute', 'sess-1', 'review.start', '--input-json', '{"instructions":"Review."}', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_execute');
      expect(parsed.data).toEqual({
        sessionId: 'sess-1',
        actionId: 'review.start',
        result: { started: true },
      });
      expect(execute).toHaveBeenCalledWith(
        'review.start',
        { instructions: 'Review.' },
        { defaultSessionId: 'sess-1', surface: 'cli' },
      );
    } finally {
      output.restore();
    }
  });

  it('prints a JSON envelope for actions list', async () => {
    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'list', '--json'], {
        readCredentialsFn: async () => null,
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_list');
      expect(Array.isArray(parsed.data?.actionSpecs)).toBe(true);
      expect(parsed.data.actionSpecs.length).toBeGreaterThan(0);
    } finally {
      output.restore();
    }
  });

  it('prints a JSON envelope for actions describe', async () => {
    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['actions', 'describe', 'review.start', '--json'], {
        readCredentialsFn: async () => null,
      });
      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_describe');
      expect(parsed.data?.actionSpec?.id).toBe('review.start');
      expect(parsed.data?.actionSpec?.surfaces).toBeTruthy();
    } finally {
      output.restore();
    }
  });
});
