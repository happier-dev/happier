import { beforeAll, describe, expect, it, vi } from 'vitest';

describe('happier session actions --json contract', () => {
  let protocol: typeof import('@happier-dev/protocol');
  let handleSessionCommand: typeof import('../index').handleSessionCommand;

  beforeAll(async () => {
    protocol = await import('@happier-dev/protocol');
    ({ handleSessionCommand } = await import('../index'));
  });

  it('prints a SessionActionsListEnvelopeSchema-compatible payload', { timeout: 60_000 }, async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    try {
      await handleSessionCommand(['actions', 'list', '--json']);
      const parsed = JSON.parse(logs.join('\n').trim());
      expect(protocol.SessionActionsListEnvelopeSchema.safeParse(parsed).success).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prints a SessionActionsDescribeEnvelopeSchema-compatible payload', { timeout: 60_000 }, async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    try {
      await handleSessionCommand(['actions', 'describe', 'review.start', '--json']);
      const parsed = JSON.parse(logs.join('\n').trim());
      expect(protocol.SessionActionsDescribeEnvelopeSchema.safeParse(parsed).success).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
