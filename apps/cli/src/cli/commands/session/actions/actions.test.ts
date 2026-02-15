import { describe, expect, it, vi } from 'vitest';

describe('happier session actions (unit)', () => {
  it('prints a JSON envelope for actions list', async () => {
    const { handleSessionCommand } = await import('../handleSessionCommand');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));
    try {
      await handleSessionCommand(['actions', 'list', '--json'], {
        readCredentialsFn: async () => null,
      });
      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_list');
      expect(Array.isArray(parsed.data?.actionSpecs)).toBe(true);
      expect(parsed.data.actionSpecs.length).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prints a JSON envelope for actions describe', async () => {
    const { handleSessionCommand } = await import('../handleSessionCommand');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));
    try {
      await handleSessionCommand(['actions', 'describe', 'review.start', '--json'], {
        readCredentialsFn: async () => null,
      });
      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_actions_describe');
      expect(parsed.data?.actionSpec?.id).toBe('review.start');
      expect(parsed.data?.actionSpec?.surfaces).toBeTruthy();
    } finally {
      logSpy.mockRestore();
    }
  });
});

