import { afterEach, describe, expect, it, vi } from 'vitest';

const credentialBoundary = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));
vi.mock('@/persistence', () => ({ readStoredCredentials: credentialBoundary.readStoredCredentials }));
import { handleActionsCommand } from './actions';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

function credentials(provenance: 'api_token' | 'stored_session'): any {
  return { token: 'token', credentialProvenance: provenance };
}

describe('actions root command', () => {
  it('describes request ids as correlation unless the Action owns idempotency', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleActionsCommand(['--help']);

    const help = log.mock.calls.map(([value]) => String(value)).join('\n');
    expect(help).toContain('--request-id <id>');
    expect(help).toContain('Request correlation identifier');
    expect(help).not.toContain('Idempotency request identifier');
  });

  it('shows help from a concrete subcommand without reading credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn();

    await handleActionsCommand(['search', '--help'], { readCredentialsFn });

    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('happier actions search');
    expect(process.exitCode).toBeUndefined();
  });

  it('preserves canonical Action failure code, candidates, and details as expected exit 1', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk); args.find((value) => typeof value === 'function')?.(); return true;
    }) as any);
    const execute = vi.fn(async () => ({ ok: false, errorCode: 'action_disabled', error: 'Disabled by policy', details: { policy: 'deny' } }));
    await handleActionsCommand(['get', 'machines.list', '--json'], {
      readCredentialsFn: async () => credentials('stored_session'),
      createExecutorFn: (() => ({ execute })) as any,
    });
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: { code: 'action_disabled', message: 'Disabled by policy', details: { policy: 'deny' } },
    });
    expect(process.exitCode).toBe(1);
  });

  it('uses the real stored-credential source so a token-only PAT reaches public transport composition', async () => {
    credentialBoundary.readStoredCredentials.mockResolvedValue(credentials('api_token'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true, result: { actionSpecs: [] } }));
    const createExecutorFn = vi.fn(() => ({ execute }));
    await handleActionsCommand(['search', 'machines'], { createExecutorFn: createExecutorFn as any });
    expect(credentialBoundary.readStoredCredentials).toHaveBeenCalledOnce();
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ credentialProvenance: 'api_token' }),
      externalActionClient: true,
    }));
  });

  it.each(['stored_session', 'api_token'] as const)('uses the same API surface for built-in and contributed invoke with %s credentials', async (provenance) => {
    vi.spyOn(process.stdout, 'write').mockImplementation(((...args: any[]) => { args.find((value) => typeof value === 'function')?.(); return true; }) as any);
    const execute = vi.fn(async () => ({ ok: true, result: { invoked: true } }));
    const deps = {
      readCredentialsFn: async () => credentials(provenance),
      createExecutorFn: (() => ({ execute })) as any,
    };
    await handleActionsCommand(['invoke', 'machines.list', '--input-json', '{}'], deps);
    await handleActionsCommand(['invoke', 'example.plugin/actions/do-work', '--input-json', '{"value":1}'], deps);
    expect(execute.mock.calls[0]).toEqual(['machines.list', {}, expect.objectContaining({ surface: 'api' })]);
    expect(execute.mock.calls[1]).toEqual(['action.invoke', {
      action: { pluginId: 'example.plugin', localId: 'do-work' }, input: { value: 1 },
    }, expect.objectContaining({ surface: 'api' })]);
  });

  it.each([
    { v: 1, ok: true, hits: [] },
    { v: 1, ok: false, errorCode: 'memory_disabled', error: 'Memory is disabled' },
  ])('preserves an admitted Action result unchanged when its own result contains ok=$ok', async (result) => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn(async () => ({ ok: true as const, result }));

    await handleActionsCommand(['invoke', 'memory.search', '--input-json', '{}', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(JSON.parse(output)).toEqual({
      v: 1,
      ok: true,
      kind: 'actions_invoke',
      data: result,
    });
    expect(process.exitCode).toBe(0);
  });

  it('accepts the Protocol request-id grammar instead of imposing a CLI-only ASCII subset', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(((...args: any[]) => {
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn(async () => ({ ok: true as const, result: { invoked: true } }));

    await handleActionsCommand(['invoke', 'machines.list', '--request-id', 'corrélation-☃', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).toHaveBeenCalledWith(
      'machines.list',
      {},
      expect.objectContaining({ actionRequestId: 'corrélation-☃' }),
    );
    expect(process.exitCode).toBe(0);
  });

  it('rejects a request id beyond the Protocol-owned limit', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn();

    await handleActionsCommand(['invoke', 'machines.list', '--request-id', 'x'.repeat(129), '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(process.exitCode).toBe(1);
  });

  it('rejects request-id outer whitespace instead of silently changing the Protocol identity', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      args.find((value) => typeof value === 'function')?.();
      return true;
    }) as any);
    const execute = vi.fn();

    await handleActionsCommand(['invoke', 'machines.list', '--request-id', ' correlation ', '--json'], {
      readCredentialsFn: async () => credentials('api_token'),
      createExecutorFn: (() => ({ execute })) as any,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(process.exitCode).toBe(1);
  });

  it('emits a stable invalid_arguments JSON envelope for a missing option value', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      const callback = args.find((value) => typeof value === 'function');
      callback?.();
      return true;
    }) as any);
    await handleActionsCommand(['invoke', 'machines.list', '--input-json', '--json'], {
      readCredentialsFn: vi.fn(), createExecutorFn: vi.fn() as any,
    });
    expect(JSON.parse(output)).toMatchObject({ v: 1, ok: false, error: { code: 'invalid_arguments' } });
    expect(process.exitCode).toBe(1);
  });

  it.each(['stored_session', 'api_token'] as const)('binds an exact machine and uses canonical get input for %s credentials', async (provenance) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const execute = vi.fn(async () => ({ ok: true, result: { actionSpec: { id: 'machines.list', title: 'Machines', inputSchema: {} } } }));
    const createExecutorFn = vi.fn(() => ({ execute }));
    await handleActionsCommand(['get', 'machines.list', '--machine-id', 'machine-1'], {
      readCredentialsFn: async () => credentials(provenance),
      createExecutorFn: createExecutorFn as any,
    });
    expect(createExecutorFn).toHaveBeenCalledWith(expect.objectContaining({ externalActionClient: true, machineId: 'machine-1' }));
    expect(execute).toHaveBeenCalledWith('action.spec.get', { id: 'machines.list' }, expect.objectContaining({ surface: 'api' }));
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects unknown options before reading credentials', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn(async () => credentials('stored_session'));
    await handleActionsCommand(['search', '--bogus'], { readCredentialsFn, createExecutorFn: vi.fn() as any });
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('classifies an unexpected dependency exception as exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleActionsCommand(['search', 'machines'], {
      readCredentialsFn: async () => { throw new Error('dependency exploded'); },
      createExecutorFn: vi.fn() as any,
    });
    expect(process.exitCode).toBe(2);
  });
});
