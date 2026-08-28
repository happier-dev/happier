import { afterEach, describe, expect, it, vi } from 'vitest';

const credentialBoundary = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));
vi.mock('@/persistence', () => ({ readStoredCredentials: credentialBoundary.readStoredCredentials }));
import { handleMachinesCommand } from './machines';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe('machines root command', () => {
  it('uses the real stored-credential source so a token-only PAT reaches machine transport', async () => {
    credentialBoundary.readStoredCredentials.mockResolvedValue({ token: 'pat', credentialProvenance: 'api_token' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const listMachinesFn = vi.fn(async () => []);
    await handleMachinesCommand(['list'], { listMachinesFn });
    expect(credentialBoundary.readStoredCredentials).toHaveBeenCalledOnce();
    expect(listMachinesFn).toHaveBeenCalledWith(expect.objectContaining({ credentialProvenance: 'api_token' }), undefined);
  });

  it('emits a stable invalid_arguments JSON envelope for an unknown option', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
      output += String(chunk);
      const callback = args.find((value) => typeof value === 'function');
      callback?.();
      return true;
    }) as any);
    await handleMachinesCommand(['list', '--bogus', '--json'], { readCredentialsFn: vi.fn() });
    expect(JSON.parse(output)).toMatchObject({ v: 1, ok: false, kind: 'machines_list', error: { code: 'invalid_arguments' } });
    expect(process.exitCode).toBe(1);
  });

  it.each(['stored_session', 'api_token'] as const)('lists account inventory for %s credentials', async (credentialProvenance) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const listMachinesFn = vi.fn(async () => [{ id: 'machine-1', label: 'desk', active: true, revokedAt: null, replacedByMachineId: null }]);
    await handleMachinesCommand(['list'], {
      readCredentialsFn: async () => ({ token: 'token', credentialProvenance } as any),
      listMachinesFn,
    });
    expect(listMachinesFn).toHaveBeenCalledOnce();
    expect(output.mock.calls.flat().join('\n')).toContain('machine-1');
  });

  it('rejects unknown options before reading credentials', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const readCredentialsFn = vi.fn();
    await handleMachinesCommand(['list', '--bogus'], { readCredentialsFn });
    expect(readCredentialsFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('classifies unexpected inventory exceptions as exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleMachinesCommand(['list'], {
      readCredentialsFn: async () => ({ token: 'token', credentialProvenance: 'stored_session' } as any),
      listMachinesFn: async () => { throw new Error('dependency exploded'); },
    });
    expect(process.exitCode).toBe(2);
  });
});
