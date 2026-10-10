import { describe, expect, it } from 'vitest';

import { normalizeRemoteBootstrapCliJsonResult } from './remoteSetupMachineRecipeExecutor.js';

describe('remote bootstrap CLI envelope admission', () => {
  it('recognizes the CLI signed-out result without treating other auth failures as signed out', () => {
    expect(normalizeRemoteBootstrapCliJsonResult({
      v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated', serverId: 'cloud' },
    }, true)).toEqual({ ok: true, data: { authenticated: false } });

    expect(normalizeRemoteBootstrapCliJsonResult({
      v: 1, ok: false, kind: 'auth_status', error: { code: 'auth_status_unavailable' },
    }, true).ok).toBe(false);
  });

  it.each([
    {},
    { authenticated: false },
    { ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } },
    { v: 2, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } },
    { v: 1, ok: 'false', kind: 'auth_status', error: { code: 'not_authenticated' } },
    { v: 1, ok: false, kind: 'auth_status' },
    { v: 1, ok: false, kind: 'auth_status', error: { code: '' } },
    { v: 1, ok: false, kind: 'server_set', error: { code: 'not_authenticated' } },
    { v: 1, ok: true, kind: 'auth_status', data: {} },
    { v: 1, ok: true, kind: 'auth_status', data: { authenticated: 'false' } },
    { v: 1, ok: true, kind: 'auth_status', data: [] },
  ])('rejects malformed or missing auth status envelopes: %j', (value) => {
    expect(() => normalizeRemoteBootstrapCliJsonResult(value, true)).toThrow(expect.objectContaining({ code: 'invalid_cli_response' }));
  });

  it('preserves valid signed-in and other command payloads', () => {
    const auth = { authenticated: true, machineId: 'machine-1' };
    expect(normalizeRemoteBootstrapCliJsonResult({ v: 1, ok: true, kind: 'auth_status', data: auth }, true))
      .toEqual({ ok: true, data: auth });
    const server = { active: { id: 'cloud' } };
    expect(normalizeRemoteBootstrapCliJsonResult({ v: 1, ok: true, kind: 'server_use', data: server }))
      .toEqual({ ok: true, data: server });
    const service = { services: [] };
    expect(normalizeRemoteBootstrapCliJsonResult(service)).toEqual({ ok: true, data: service });
  });
});
