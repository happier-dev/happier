import axios from 'axios';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

const resolveSessionTransportContext = vi.fn();
const execute = vi.fn();
const createCliActionExecutor = vi.fn(() => ({ execute }));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials: createCliActionExecutor,
}));

describe('happier session actions --json contract', () => {
  afterEach(() => vi.restoreAllMocks());
  let protocol: typeof import('@happier-dev/protocol');
  let handleSessionCommand: typeof import('../index').handleSessionCommand;

  beforeAll(async () => {
    protocol = await import('@happier-dev/protocol');
    ({ handleSessionCommand } = await import('../index'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return {
        status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
      };
      if (path === '/v2/account/settings') return {
        status: 200, data: { version: 1, content: { t: 'plain', v: {} } },
      };
      return { status: 404, data: {} };
    });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess_protocol_actions_execute_1',
      rawSession: { id: 'sess_protocol_actions_execute_1', metadata: {} },
      ctx: null,
      accountEncryptionCurrentness: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 },
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
            encryption: null,
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
