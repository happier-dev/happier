import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

vi.mock('axios');

import { CliReloginRequiredError, SUPPORTED_SCHEMA_VERSION, type Settings } from '@/persistence';

import { resolveActiveServerAuthReadiness } from './resolveActiveServerAuthReadiness';

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    onboardingCompleted: false,
    ...overrides,
  };
}

describe('resolveActiveServerAuthReadiness', () => {
  it('checks Account currentness when booting from a retained 0.2 secret', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: {
        mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing',
        contentKeyFingerprint: 'content', updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'available' },
      },
    });
    const readiness = await resolveActiveServerAuthReadiness({
      readCredentialsFn: async () => ({
        token: 'header.eyJzdWIiOiJhY2NvdW50LTEifQ.signature',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
        credentialProvenance: 'stored_session',
      }),
      readSettingsFn: async () => createSettings(),
      validateTokenFn: async () => ({ state: 'valid', httpStatus: 200 }),
    });
    expect(readiness.authenticated).toBe(true);
    expect(vi.mocked(axios.get).mock.calls.some(([url]) =>
      String(url).endsWith('/v1/account/encryption/currentness'))).toBe(true);
  });

  it('does not report a locally allocated machine id as server-registered', async () => {
    const readiness = await resolveActiveServerAuthReadiness({
      readCredentialsFn: async () => ({
        token: 'valid-token',
        encryption: null,
        credentialProvenance: 'stored_session',
      }),
      readSettingsFn: async () => createSettings({
        machineId: 'machine-local-only',
        machineIdConfirmedByServer: false,
      }),
      validateTokenFn: async () => ({ state: 'valid', httpStatus: 200, accountLabel: 'alice' }),
    });

    expect(readiness).toMatchObject({
      credentialState: 'valid',
      authenticated: true,
      accountLabel: 'alice',
      machineId: 'machine-local-only',
      machineRegistrationState: 'local-only',
      machineRegistered: false,
    });
  });

  it('does not report stored credentials as authenticated when server validation is inconclusive', async () => {
    const readiness = await resolveActiveServerAuthReadiness({
      readCredentialsFn: async () => ({
        token: 'stored-token',
        encryption: null,
        credentialProvenance: 'stored_session',
      }),
      readSettingsFn: async () => createSettings({
        machineId: 'machine-confirmed',
        machineIdConfirmedByServer: true,
      }),
      validateTokenFn: async () => ({
        state: 'unknown',
        httpStatus: null,
        reasonCode: 'TimeoutError',
      }),
    });

    expect(readiness).toMatchObject({
      credentials: expect.objectContaining({ token: 'stored-token' }),
      credentialState: 'unknown',
      authenticated: false,
      unusableReason: null,
      machineId: 'machine-confirmed',
      machineRegistrationState: 'server-confirmed',
      machineRegistered: true,
    });
  });

  it('passes caller cancellation to the canonical stored-credential validator', async () => {
    const caller = new AbortController();
    const observed: AbortSignal[] = [];

    await resolveActiveServerAuthReadiness({
      readCredentialsFn: async () => ({
        token: 'stored-token',
        encryption: null,
        credentialProvenance: 'stored_session',
      }),
      readSettingsFn: async () => createSettings({ machineId: undefined }),
      signal: caller.signal,
      validateTokenFn: async (_token, signal) => {
        if (signal) observed.push(signal);
        return { state: 'unknown', httpStatus: null, reasonCode: 'fixture' };
      },
    });

    expect(observed).toEqual([caller.signal]);
  });

  it('distinguishes missing, rejected, and server-confirmed readiness facts', async () => {
    const missing = await resolveActiveServerAuthReadiness({
      readCredentialsFn: async () => null,
      readSettingsFn: async () => createSettings(),
    });
    expect(missing).toMatchObject({
      credentialState: 'missing',
      machineRegistrationState: 'no-local-id',
      authenticated: false,
      machineRegistered: false,
    });

    const rejected = await resolveActiveServerAuthReadiness({
      readCredentialsFn: async () => ({
        token: 'rejected-token',
        encryption: null,
        credentialProvenance: 'stored_session',
      }),
      readSettingsFn: async () => createSettings({
        machineId: 'machine-confirmed',
        machineIdConfirmedByServer: true,
      }),
      validateTokenFn: async () => ({
        state: 'invalid',
        httpStatus: 401,
        reasonCode: 'not_authenticated',
      }),
    });
    expect(rejected).toMatchObject({
      credentialState: 'invalid',
      authenticated: false,
      unusableReason: 'credentials-rejected',
      machineRegistrationState: 'server-confirmed',
      machineRegistered: true,
    });
  });

  it('reports an obsolete stored bearer as a typed re-login reason so login can replace it', async () => {
    const validateTokenFn = vi.fn();
    const readiness = await resolveActiveServerAuthReadiness({
      readCredentialsFn: async () => { throw new CliReloginRequiredError(); },
      readSettingsFn: async () => createSettings(),
      validateTokenFn,
    });

    expect(readiness).toMatchObject({
      credentials: null,
      credentialState: 'missing',
      authenticated: false,
      unusableReason: 'no-credentials',
      credentialReason: 'cli_relogin_required',
    });
    expect(validateTokenFn).not.toHaveBeenCalled();
  });
});
