import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { resolveSessionCommandResumeDelegation } from './sessionCommandResumeDelegation';

const credentials = { token: 'token-1' } as Credentials;

describe('resolveSessionCommandResumeDelegation', () => {
  it('delegates implicit resume when the id is a Happier session', async () => {
    const ensureAuthFn = vi.fn(async () => ({ credentials }));
    const fetchSessionByIdFn = vi.fn(async () => ({ id: 'session-1' }));

    await expect(resolveSessionCommandResumeDelegation({
      args: ['--resume', 'session-1'],
      explicitProviderSubcommand: false,
      resumeFlags: ['--resume', '-r'],
      readCredentialsFn: async () => null,
      ensureAuthFn,
      fetchSessionByIdFn,
    })).resolves.toEqual({ kind: 'delegate', sessionId: 'session-1' });

    expect(ensureAuthFn).toHaveBeenCalledTimes(1);
    expect(fetchSessionByIdFn).toHaveBeenCalledWith({ token: 'token-1', sessionId: 'session-1' });
  });

  it('continues without lookup for explicit provider invocations', async () => {
    const fetchSessionByIdFn = vi.fn(async () => ({ id: 'session-1' }));

    await expect(resolveSessionCommandResumeDelegation({
      args: ['claude', '--resume', 'session-1'],
      explicitProviderSubcommand: true,
      resumeFlags: ['--resume', '-r'],
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn,
    })).resolves.toEqual({ kind: 'continue' });

    expect(fetchSessionByIdFn).not.toHaveBeenCalled();
  });

  it('delegates long inline resume values', async () => {
    const fetchSessionByIdFn = vi.fn(async () => ({ id: 'session-2' }));

    await expect(resolveSessionCommandResumeDelegation({
      args: ['--resume=session-2'],
      explicitProviderSubcommand: false,
      resumeFlags: ['--resume', '-r'],
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn,
    })).resolves.toEqual({ kind: 'delegate', sessionId: 'session-2' });

    expect(fetchSessionByIdFn).toHaveBeenCalledWith({ token: 'token-1', sessionId: 'session-2' });
  });

  it('ignores unsupported short inline resume assignments', async () => {
    const fetchSessionByIdFn = vi.fn(async () => ({ id: 'session-3' }));

    await expect(resolveSessionCommandResumeDelegation({
      args: ['-r=session-3'],
      explicitProviderSubcommand: false,
      resumeFlags: ['--resume', '-r'],
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn,
    })).resolves.toEqual({ kind: 'continue' });

    expect(fetchSessionByIdFn).not.toHaveBeenCalled();
  });

  it('continues for bare resume flags and non-session lookup results', async () => {
    const fetchSessionByIdFn = vi.fn(async () => null);

    await expect(resolveSessionCommandResumeDelegation({
      args: ['--resume'],
      explicitProviderSubcommand: false,
      resumeFlags: ['--resume', '-r'],
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn,
    })).resolves.toEqual({ kind: 'continue' });
    expect(fetchSessionByIdFn).not.toHaveBeenCalled();

    await expect(resolveSessionCommandResumeDelegation({
      args: ['-r', 'vendor-session-1'],
      explicitProviderSubcommand: false,
      resumeFlags: ['--resume', '-r'],
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn,
    })).resolves.toEqual({ kind: 'continue' });
    expect(fetchSessionByIdFn).toHaveBeenCalledWith({ token: 'token-1', sessionId: 'vendor-session-1' });

    await expect(resolveSessionCommandResumeDelegation({
      args: ['-r=vendor-session-2'],
      explicitProviderSubcommand: false,
      resumeFlags: ['--resume', '-r'],
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn,
    })).resolves.toEqual({ kind: 'continue' });
    expect(fetchSessionByIdFn).toHaveBeenCalledTimes(1);
  });

  it('continues when credential or lookup work fails', async () => {
    await expect(resolveSessionCommandResumeDelegation({
      args: ['--resume', 'session-1'],
      explicitProviderSubcommand: false,
      resumeFlags: ['--resume'],
      readCredentialsFn: async () => null,
      ensureAuthFn: async () => {
        throw new Error('auth unavailable');
      },
      fetchSessionByIdFn: async () => ({ id: 'session-1' }),
    })).resolves.toEqual({ kind: 'continue' });

    await expect(resolveSessionCommandResumeDelegation({
      args: ['--resume', 'session-1'],
      explicitProviderSubcommand: false,
      resumeFlags: ['--resume'],
      readCredentialsFn: async () => credentials,
      fetchSessionByIdFn: async () => {
        throw new Error('server offline');
      },
    })).resolves.toEqual({ kind: 'continue' });
  });
});
