import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

describe('handleSessionCommand required positionals', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it.each([
    ['status', ['status', '--json']],
    ['wait', ['wait', '--json']],
    ['stop', ['stop', '--json']],
    ['history', ['history', '--json']],
    ['archive', ['archive', '--json']],
    ['unarchive', ['unarchive', '--json']],
    ['run list', ['run', 'list', '--json']],
  ] as const)('rejects missing %s ids before reading credentials', async (_label, argv) => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const readCredentialsFn = vi.fn(async () => {
      throw new Error('credentials must not be read without a session id');
    });
    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand([...argv], { readCredentialsFn });

      expect(output.json()).toMatchObject({
        ok: false,
        error: { code: 'invalid_arguments' },
      });
      expect(readCredentialsFn).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });
});
