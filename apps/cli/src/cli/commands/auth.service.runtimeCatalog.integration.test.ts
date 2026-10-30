import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleAuthServiceCommand } from './auth/service';

function captureLog() {
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

function sessionOwner(overrides: Record<string, unknown> = {}) {
  return {
    readSelection: vi.fn(async () => null),
    readCredential: vi.fn(async () => null),
    selectService: vi.fn(),
    replaceCredential: vi.fn(),
    rejectCredential: vi.fn(),
    authenticate: vi.fn(),
    logout: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

const SELECTION = {
  endpoint: 'https://service.example',
  serverIdentityId: 'srv_service',
  canonicalServerUrl: 'https://service.example',
};

describe('happier auth service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('reports the selected service only after its current identity and role verify', async () => {
    const output = captureLog();
    const resolvePresentation = vi.fn(async () => ({
      displayName: 'Acme Identity',
      endpoint: SELECTION.endpoint,
      serverIdentityId: SELECTION.serverIdentityId,
    }));

    await handleAuthServiceCommand(['status'], undefined, {
      createSession: () => sessionOwner({ readSelection: vi.fn(async () => SELECTION) }),
      resolvePresentation,
    });

    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Acme Identity');
    expect(text).toContain('https://service.example');
    expect(text).toContain('srv_service');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not present a stored pointer whose service no longer verifies as one', async () => {
    const output = captureLog();

    await handleAuthServiceCommand(['status'], undefined, {
      createSession: () => sessionOwner({ readSelection: vi.fn(async () => SELECTION) }),
      resolvePresentation: vi.fn(async () => null),
    });

    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('did not confirm its identity or sign-in role');
    expect(process.exitCode).toBe(1);
  });

  it('says nothing is selected instead of probing a service that was never chosen', async () => {
    const output = captureLog();
    const resolvePresentation = vi.fn(async () => null);

    await handleAuthServiceCommand(['status'], undefined, {
      createSession: () => sessionOwner(),
      resolvePresentation,
    });

    expect(output.mock.calls.flat().join('\n')).toContain('No sign-in service is selected.');
    expect(resolvePresentation).not.toHaveBeenCalled();
  });

  it('signs in through the setup-entry owner without entering or switching a Home', async () => {
    const output = captureLog();
    const promptInput = vi.fn(async () => 'k');
    const runSetupEntry = vi.fn(async () => ({
      kind: 'signed_in' as const,
      endpoint: 'https://service.example',
    }));

    await handleAuthServiceCommand(['use', 'https://service.example'], undefined, {
      createSession: () => sessionOwner(),
      runSetupEntry: runSetupEntry as never,
      isInteractiveTerminal: () => true,
      promptInput,
    });

    expect(runSetupEntry).toHaveBeenCalledWith({
      endpoint: 'https://service.example',
      context: { kind: 'none' },
      stopAfter: 'sign_in',
      promptInputFn: promptInput,
    });
    expect(output.mock.calls.flat().join('\n')).toContain('https://service.example');
    expect(process.exitCode).toBeUndefined();
  });

  it('tells a non-interactive caller exactly which command signs in when no valid credential is stored', async () => {
    const output = captureLog();
    const runSetupEntry = vi.fn(async () => ({ kind: 'cancelled' as const }));

    await handleAuthServiceCommand(['use', 'https://service.example'], undefined, {
      createSession: () => sessionOwner(),
      runSetupEntry: runSetupEntry as never,
      isInteractiveTerminal: () => false,
      promptInput: vi.fn(async () => ''),
    });

    expect(runSetupEntry).toHaveBeenCalledWith({
      endpoint: 'https://service.example',
      context: { kind: 'none' },
      stopAfter: 'sign_in',
    });
    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('happier auth service use https://service.example');
    expect(text).not.toContain('cancelled');
    expect(process.exitCode).toBe(1);
  });

  it('drops only this CLI\'s service credential on logout', async () => {
    const output = captureLog();
    const logout = vi.fn(async () => {});
    const clear = vi.fn(async () => {});

    await handleAuthServiceCommand(['logout'], undefined, {
      createSession: () => sessionOwner({ logout, clear }),
    });

    expect(logout).toHaveBeenCalledOnce();
    // `clear` would also drop the selected service; logout must not.
    expect(clear).not.toHaveBeenCalled();
    expect(output.mock.calls.flat().join('\n'))
      .toContain('Homes you already entered keep their own access.');
  });

  it('refuses an unknown or malformed service subcommand', async () => {
    await expect(handleAuthServiceCommand(['nope'], undefined, { createSession: () => sessionOwner() }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(handleAuthServiceCommand(['use'], undefined, { createSession: () => sessionOwner() }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(handleAuthServiceCommand(['status', 'extra'], undefined, { createSession: () => sessionOwner() }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  });
});
