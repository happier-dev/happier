import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const { handleSessionCommand } = await import('./handleSessionCommand');

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

  it.each([
    ['unknown list options', ['list', '--definitely-invalid', '--json'], 'Usage: happier session list'],
    ['invalid list limits', ['list', '--limit', '0', '--json'], 'Invalid --limit'],
  ] as const)('rejects %s with a truthful JSON error and exit code', async (_label, argv, expectedMessage) => {
    const readCredentialsFn = vi.fn(async () => {
      throw new Error('credentials must not be read for invalid arguments');
    });
    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand([...argv], { readCredentialsFn });

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'session_list',
        error: {
          code: 'invalid_arguments',
          message: expect.stringContaining(expectedMessage),
        },
      });
      expect(process.exitCode).toBe(1);
      expect(readCredentialsFn).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

});
