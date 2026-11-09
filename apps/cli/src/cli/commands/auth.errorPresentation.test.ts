import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHappierJsonExecutorFromTextRunner, runRemoteHomeEnrollmentFlow } from '@happier-dev/cli-common/systemTasks';
import { readRemoteEnrollmentCommandFailure } from '@happier-dev/protocol/ssh/commandFailure';
import { ActionOperationFailureV1Schema } from '@happier-dev/protocol/actions/operations/v1';

import { handleAuthCliCommand } from './auth';
import { projectSafeAuthError } from './auth/errorDiagnostic';
import { handleAuthWait } from './auth/wait';

afterEach(() => vi.restoreAllMocks());

describe('auth command error presentation', () => {
  it.each([
    { code: 'HOME_FEATURES_NETWORK', expected: 'HOME_FEATURES_NETWORK', carrierFailure: undefined },
    { code: 'private_secret', expected: 'AUTH_ENROLL_REMOTE_FAILED', carrierFailure: undefined },
    { code: 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE', expected: 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE',
      carrierFailure: { attemptedCarrier: 'iroh', reason: 'transport_closed' } },
    ...[false, true].map(buffered => ({ code: 'HOME_AUTHORITY_MISMATCH', expected: 'HOME_AUTHORITY_MISMATCH',
      carrierFailure: undefined, buffered, authority: { authorityReason: 'descriptor', authorityPhase: 'first_contact',
        authorityCarrier: 'https', authorityDescriptorPresent: false } })),
  ])('emits a closed enrollment error envelope ($expected, buffered=$buffered)', async ({ code, expected, carrierFailure, ...variant }) => {
    const authority = 'authority' in variant ? variant.authority : undefined;
    const buffered = 'buffered' in variant && variant.buffered;
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      throw Object.assign(new Error('private-input'), { code, token: 'private-token', carrierFailure, ...authority });
    });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
      chunks.push(String(chunk));
      (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.();
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
    await expect(handleAuthCliCommand({ args: buffered ? ['auth', 'request', '--json', '--remote-enrollment', '--home-target-stdin']
      : ['auth', 'enroll-remote', '--json-lines', '--home-target-stdin'],
      rawArgv: [], terminalRuntime: null })).rejects.toThrow('test_exit');
    expect(JSON.parse(chunks.join(''))).toEqual({ v: 1, ok: false, kind: buffered ? 'auth_request' : 'auth_enroll_remote',
      error: { code: expected, category: 'auth_error', ...(carrierFailure ? { carrierFailure } : {}), ...authority } });
    expect(chunks.join('')).not.toMatch(/private-input|private-token|private_secret/);
    // Feed the real guest producer's bytes through the real controller/reader.
    const failure = await runRemoteHomeEnrollmentFlow({
      executor: createHappierJsonExecutorFromTextRunner(async (_args, options) => {
        options?.onStdoutChunk?.(chunks.join(''));
        return { status: 1, stdout: chunks.join(''), stderr: '' };
      }), homeTargetInput: { kind: 'https_url', url: 'https://home.example.test' },
      ...(buffered ? { processIO: 'buffered' as const } : {}),
      approvePairingRequest: async () => { throw new Error('Failure cannot request approval'); },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed',
      message: expect.stringContaining(buffered ? `code ${expected}` : `guestCliCode ${expected}`) });
    if (carrierFailure) expect(failure).toMatchObject({ message: expect.stringContaining('attemptedCarrier iroh; carrierReason transport_closed') });
    if (!(failure instanceof Error) || !('code' in failure)) throw failure;
    const presented = readRemoteEnrollmentCommandFailure(failure.code, failure.message);
    expect(presented?.message).toBe(failure.message);
    const settled = ActionOperationFailureV1Schema.parse({ errorCode: presented?.code, error: presented?.message,
      ...(presented && 'details' in presented ? { details: presented.details } : {}) });
    expect(settled.error).toBe(failure.message);
    if (authority) expect(settled.details).toEqual({ kind: 'homeAuthorityMismatch', ...authority });
  });
  it('requires JSON for finite auth wait through the typed owner boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
    await expect(handleAuthWait([])).rejects.toMatchObject({ code: 'AUTH_WAIT_INVALID_ARGUMENT' });
  });
  it.each([
    { args: ['wait', '--json'], code: 'AUTH_WAIT_INVALID_ARGUMENT', exitCode: 2 },
    { args: ['wait', '--json', '--public-key', 'invalid'], code: 'AUTH_WAIT_INVALID_ARGUMENT', exitCode: 2 },
    { args: ['wait', '--json', '--secrets-json-stdin'], code: 'AUTH_WAIT_FAILED', exitCode: 1 },
  ])('projects wait validation failures as typed JSON ($code, exit $exitCode)', async ({ args, code, exitCode }) => {
    // Stdin/stdout and process exit are OS boundaries; dispatch and wait stay real.
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { throw new Error('private-input'); });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
      chunks.push(String(chunk));
      (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.();
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
    await expect(handleAuthCliCommand({ args: ['auth', ...args], rawArgv: [], terminalRuntime: null })).rejects.toThrow('test_exit');
    expect(exit).toHaveBeenCalledWith(exitCode);
    expect(JSON.parse(chunks.join(''))).toMatchObject({ v: 1, ok: false, kind: 'auth_wait', error: { code, category: 'auth_error' } });
    expect(chunks.join('')).not.toContain('private-input');
  });

  it('emits a credential-free JSON failure for finite remote enrollment commands', async () => {
    const failure = Object.assign(new Error('private-response-body'), { code: 'ERR_BAD_REQUEST',
      response: { status: 409, data: { error: 'database_transaction_conflict_exhausted', token: 'private-token' } } });
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { throw failure; });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
      chunks.push(String(chunk));
      (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.();
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
    await expect(handleAuthCliCommand({ args: ['auth', 'wait', '--json', '--remote-enrollment', '--secrets-json-stdin'],
      rawArgv: [], terminalRuntime: null })).rejects.toThrow('test_exit');
    expect(JSON.parse(chunks.join(''))).toEqual({ v: 1, ok: false, kind: 'auth_wait',
      error: { code: 'ERR_BAD_REQUEST', category: 'http_error', status: 409, serverCode: 'database_transaction_conflict_exhausted' } });
    expect(chunks.join('')).not.toMatch(/private-response-body|private-token/);
  });

  it.each(['ECONNABORTED', 'ECONNRESET'])('classifies wait transport failure %s as Home unavailable', async code => {
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      throw Object.assign(new Error('private-network-detail'), { code });
    });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
      chunks.push(String(chunk));
      (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.();
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
    await expect(handleAuthCliCommand({ args: ['auth', 'wait', '--json', '--secrets-json-stdin'],
      rawArgv: [], terminalRuntime: null })).rejects.toThrow('test_exit');
    expect(JSON.parse(chunks.join(''))).toEqual({ v: 1, ok: false, kind: 'auth_wait',
      error: { code: 'AUTH_WAIT_HOME_UNAVAILABLE', category: 'auth_error' } });
  });

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
  it('redacts credentials embedded in error text through the shared diagnostic owner', () => {
    const token = `hap_v1_12345678-1234-4234-8234-123456789abc_${'A'.repeat(43)}`;
    const diagnostic = projectSafeAuthError({ name: `Authorization: Bearer ${token}`,
      code: `token:${token}`, message: `Request refused Authorization: Bearer ${token}; recovery_secret=private-recovery-key`,
      response: { status: 401 } });
    expect(JSON.stringify(diagnostic)).not.toContain(token);
    expect(JSON.stringify(diagnostic)).not.toContain('private-recovery-key');
    // A redacted string is no longer a protocol code. The dispatch must use
    // its typed fallback rather than lose the code at the recipe's safe reader.
    expect(diagnostic.code).toBeUndefined();
    expect(diagnostic.status).toBe(401);
  });

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
