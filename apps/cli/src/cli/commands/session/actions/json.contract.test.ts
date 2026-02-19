import { describe, expect, it, vi } from 'vitest';

describe('happier session actions --json contract', () => {
  it('prints a SessionActionsListEnvelopeSchema-compatible payload', async () => {
    const protocol: any = await import('../../../../../../../node_modules/@happier-dev/protocol/dist/index.js');
    const { handleSessionCommand } = await import('../index');
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

  it('prints a SessionActionsDescribeEnvelopeSchema-compatible payload', async () => {
    const protocol: any = await import('../../../../../../../node_modules/@happier-dev/protocol/dist/index.js');
    const { handleSessionCommand } = await import('../index');
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
