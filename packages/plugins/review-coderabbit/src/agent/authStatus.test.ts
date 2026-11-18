import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { CODERABBIT_PLUGIN } from '../manifest.js';

describe('registered CodeRabbit native authentication', () => {
  it.each([
    [{ type: 'status', phase: 'auth', status: 'not_authenticated', authenticated: false }, { state: 'logged_out', reason: 'missing_credentials' }],
    [{ type: 'status', phase: 'auth', authenticated: true, user: { email: 'private@example.test' }, organization: 'private-team' }, { state: 'logged_in', method: 'unknown' }],
    [{ type: 'status', phase: 'auth', authenticated: 'true' }, { state: 'unknown', reason: 'probe_failed' }],
  ])('returns secret-free readiness from native status %j', async (payload, expected) => {
    const activation = await createPluginTestkit({ manifest: CODERABBIT_PLUGIN.manifest, module: { activate: CODERABBIT_PLUGIN.activate } });
    try {
      const auth = activation.registration('agents', 'coderabbit')?.cliAuth;
      if (!auth) throw new Error('CodeRabbit native auth registration missing');
      const result = await auth.detectAuthStatus({ runDeclaredSystemToolCommand: async command => {
        expect(command).toEqual({ toolId: 'coderabbit-cli', args: ['auth', 'status', '--agent'] });
        return { ok: true, exitCode: 0, stdout: JSON.stringify(payload), stderr: '' };
      } });
      expect(result).toEqual({ ...expected, source: 'command' });
    } finally { await activation.dispose(); }
  });
});
