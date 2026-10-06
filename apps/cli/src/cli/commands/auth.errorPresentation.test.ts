import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleAuthCliCommand } from './auth';

afterEach(() => vi.restoreAllMocks());

describe('auth command error presentation', () => {
  it.each([undefined, '', 'Unknown error'])('surfaces a safe error code when the message is %s without DEBUG', async (message) => {
    const error = { code: 'MODULE_NOT_FOUND', message, request: { token: 'private-token' } };
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { throw error; });
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
    const previousDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    try {
      await expect(handleAuthCliCommand({ args: ['auth', '--secrets-json-stdin'], rawArgv: [], terminalRuntime: null })).rejects.toThrow('test_exit');
      const diagnostic = JSON.stringify(output.mock.calls);
      expect(diagnostic).toContain('MODULE_NOT_FOUND');
      expect(diagnostic).not.toMatch(/Unknown error|private-token/);
    } finally {
      if (previousDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = previousDebug;
    }
  });

  it('preserves a foreign-realm module error without printing attached credentials', async () => {
    const error: unknown = runInNewContext(`Object.assign(new Error("Cannot find module 'libsodium-wrappers-sumo' from '/$bunfs/root/index.js'"), {
      code: 'MODULE_NOT_FOUND', request: { password: 'private-password' },
      response: { data: { token: 'private-token' } }, config: { headers: { Authorization: 'private-bearer' } }
    })`);
    expect(error).not.toBeInstanceOf(Error);
    // Stdin is an OS boundary. The real auth dispatch and diagnostic projection
    // receive the same foreign-realm error shape as Bun module resolution.
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { throw error; });
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
    const previousDebug = process.env.DEBUG;
    process.env.DEBUG = '1';
    try {
      await expect(handleAuthCliCommand({ args: ['auth', '--secrets-json-stdin'], rawArgv: [], terminalRuntime: null })).rejects.toThrow('test_exit');
      const diagnostic = JSON.stringify(output.mock.calls);
      expect(diagnostic).toContain('libsodium-wrappers-sumo');
      expect(diagnostic).toContain('/$bunfs/root/index.js');
      expect(diagnostic).toContain('MODULE_NOT_FOUND');
      expect(diagnostic).not.toMatch(/private-password|private-token|private-bearer/);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      if (previousDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = previousDebug;
    }
  });
});
