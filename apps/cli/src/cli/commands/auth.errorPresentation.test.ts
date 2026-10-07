import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleAuthCliCommand } from './auth';
import { projectSafeAuthError } from './auth/errorDiagnostic';

afterEach(() => vi.restoreAllMocks());

describe('auth command error presentation', () => {
  it.each([undefined, '', 'Unknown error'])('surfaces a safe error code when the message is %s without DEBUG', async (message) => {
    const code = `MODULE_NOT_FOUND:${'dependency.'.repeat(12)}missing`;
    const error = { code, message, request: { token: 'private-token' } };
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { throw error; });
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
    const previousDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    try {
      await expect(handleAuthCliCommand({ args: ['auth', '--secrets-json-stdin'], rawArgv: [], terminalRuntime: null })).rejects.toThrow('test_exit');
      const diagnostic = JSON.stringify(output.mock.calls);
      expect(diagnostic).toContain(code);
      expect(diagnostic).not.toMatch(/Unknown error|private-token/);
    } finally {
      if (previousDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = previousDebug;
    }
  });

  it('preserves a foreign-realm module error without printing attached credentials', async () => {
    const name = `ModuleResolutionError:${'dependency.'.repeat(12)}missing`;
    const code = `MODULE_NOT_FOUND:${'dependency.'.repeat(12)}missing`;
    const message = `Resolution trace: ${'parent -> '.repeat(240)}Cannot find module 'libsodium-wrappers-sumo' from '/$bunfs/root/index.js'`;
    const error: unknown = runInNewContext(`Object.assign(new Error(message), {
      name, code, request: { password: 'private-password' },
      response: { status: 503, data: { token: 'private-token' } }, config: { headers: { Authorization: 'private-bearer' } }
    })`, { name, code, message });
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
      expect(output.mock.calls).toContainEqual([{ name, code, message, status: 503 }]);
      expect(diagnostic).not.toMatch(/private-password|private-token|private-bearer/);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      if (previousDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = previousDebug;
    }
  });
});

describe('safe auth error projection', () => {
  it('preserves safe numeric codes and HTTP status without retaining other fields', () => {
    expect(projectSafeAuthError({
      code: Number.MAX_SAFE_INTEGER,
      status: 599,
      request: { password: 'private-password' },
      response: { status: 200, data: { token: 'private-token' } },
    })).toEqual({ name: 'Error', message: String(Number.MAX_SAFE_INTEGER), code: Number.MAX_SAFE_INTEGER, status: 599 });
  });

  it.each([
    { code: Number.MAX_SAFE_INTEGER + 1, status: 99, response: { status: 600 } },
    { code: 'INVALID/CODE', status: 199.5, response: { status: '503' } },
    { code: { token: 'private-token' }, status: Number.NaN, response: { status: { value: 503 } } },
  ])('excludes invalid code and status scalars: %j', (error) => {
    expect(projectSafeAuthError(error)).toEqual({ name: 'Error', message: 'Unknown error' });
  });
});
