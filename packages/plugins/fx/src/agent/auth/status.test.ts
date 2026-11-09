import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { FX_PLUGIN } from '../../manifest.js';

// FX 0.0.14, build 1a070af32cdf, observed 2026-10-27 with `fx status --json`.
// Missing/expired fields are pinned to src/core/output/output_contracts.zig at that revision.
describe('registered FX native auth status', () => {
  it.each([
    [{ kind: 'status', auth: 'Codex subscription', auth_refreshable: true }, { state: 'logged_in' }],
    [{ kind: 'status', auth: 'AI_GATEWAY_API_KEY', auth_refreshable: false }, { state: 'logged_in', method: 'api_key_env' }],
    [{ kind: 'status', auth: 'missing', auth_refreshable: false }, { state: 'logged_out', reason: 'missing_credentials' }],
    [{ kind: 'status', auth: 'Codex subscription', auth_refreshable: true, auth_expired: true }, { state: 'logged_out', reason: 'expired' }],
    [{ kind: 'status', auth: 'unknown-future-source' }, { state: 'unknown', reason: 'probe_failed' }],
    [{ kind: 'status', auth: 'host managed', auth_refreshable: false }, { state: 'unknown', reason: 'not_configured' }],
    [{ kind: 'other', auth: 'Codex subscription' }, { state: 'unknown', reason: 'probe_failed' }],
    [{ kind: 'status', auth: 'Codex subscription', auth_expired: 'true' }, { state: 'unknown', reason: 'probe_failed' }],
    [null, { state: 'unknown', reason: 'probe_failed' }],
  ])('interprets native status %j', async (payload, expected) => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const auth = activation.registration('agents', 'fx')?.cliAuth;
      expect(auth).toBeDefined();
      if (!auth) throw new Error('FX auth callback missing');
      const status = await auth.detectAuthStatus({ runDeclaredSystemToolCommand: async command => {
        expect(command).toEqual({ toolId: 'fx-cli', args: ['status', '--json'] });
        return { ok: true, exitCode: 0, stdout: JSON.stringify(payload), stderr: '' };
      } });
      expect(status).toMatchObject({ ...expected, source: 'command' });
    } finally { await activation.dispose(); }
  });

  it.each([{ ok: false, exitCode: 1, stdout: '{"kind":"status","auth":"Codex subscription"}', stderr: '' },
    { ok: true, exitCode: 0, stdout: 'malformed', stderr: '' }])('keeps unavailable/malformed evidence unknown', async result => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const auth = activation.registration('agents', 'fx')?.cliAuth;
      if (!auth) throw new Error('FX auth callback missing');
      expect(await auth.detectAuthStatus({ runDeclaredSystemToolCommand: async () => result })).toEqual({ state: 'unknown', reason: 'probe_failed', source: 'command' });
    } finally { await activation.dispose(); }
  });
});
