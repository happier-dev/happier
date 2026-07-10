import { describe, expect, it } from 'vitest';

import {
  isOpenCodeManagedServerCommand,
  OPENCODE_BINARY_IDENTITY_ENV,
  OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV,
  resolveOpenCodeManagedServerStateFingerprintInput,
} from './managedServerState.js';

function fingerprintFor(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(resolveOpenCodeManagedServerStateFingerprintInput(env));
}

describe('resolveOpenCodeManagedServerStateFingerprintInput', () => {
  it('keys connected sessions on the stable selection identity, not rotating auth bytes', () => {
    const base: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'openai-codex|profile:acct-1',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'token-v1' } }),
    };
    const rotated: NodeJS.ProcessEnv = {
      ...base,
      // Same account, refreshed access token => different auth bytes, identical selection identity.
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'token-v2' } }),
    };

    expect(fingerprintFor(base)).toBe(fingerprintFor(rotated));
  });

  it('produces different fingerprints for two different connected accounts', () => {
    const accountA: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'openai-codex|profile:acct-1',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'token-a' } }),
    };
    const accountB: NodeJS.ProcessEnv = {
      ...accountA,
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'openai-codex|profile:acct-2',
    };

    expect(fingerprintFor(accountA)).not.toBe(fingerprintFor(accountB));
  });

  it('falls back to hashing the auth content when no selection identity is present', () => {
    const credentialA: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ anthropic: { type: 'api', key: 'key-a' } }),
    };
    const credentialB: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ anthropic: { type: 'api', key: 'key-b' } }),
    };

    // Distinct stored credentials must never collide on the fallback path.
    expect(fingerprintFor(credentialA)).not.toBe(fingerprintFor(credentialB));
  });

  it('never exposes raw auth-content or token bytes in the fingerprint input', () => {
    const secret = 'super-secret-access-token';
    const input = resolveOpenCodeManagedServerStateFingerprintInput({
      HOME: '/Users/example',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: secret } }),
    });

    expect(JSON.stringify(input)).not.toContain(secret);
  });

  it('keeps native sessions in a stable empty-auth class that never collides with connected sessions', () => {
    const native: NodeJS.ProcessEnv = { HOME: '/Users/example' };
    const connected: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'openai-codex|profile:acct-1',
    };

    const nativeOnce = fingerprintFor(native);
    const nativeTwice = fingerprintFor({ HOME: '/Users/example' });
    expect(nativeOnce).toBe(nativeTwice);
    expect(nativeOnce).not.toBe(fingerprintFor(connected));
  });

  it('changes the fingerprint when the opencode binary identity changes', () => {
    const v1: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      [OPENCODE_BINARY_IDENTITY_ENV]: 'opencode@1.14.41|/opt/opencode',
    };
    const v2: NodeJS.ProcessEnv = {
      ...v1,
      [OPENCODE_BINARY_IDENTITY_ENV]: 'opencode@1.15.0|/opt/opencode',
    };

    expect(fingerprintFor(v1)).not.toBe(fingerprintFor(v2));
  });

  it('changes the fingerprint when config isolation switches the config home', () => {
    const shared: NodeJS.ProcessEnv = { HOME: '/Users/example' };
    const isolated: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      XDG_CONFIG_HOME: '/Users/example/.happier/opencode/config',
    };

    expect(fingerprintFor(shared)).not.toBe(fingerprintFor(isolated));
  });

  it('changes the fingerprint when the managed server auth credentials change', () => {
    const noAuth: NodeJS.ProcessEnv = { HOME: '/Users/example' };
    const withAuth: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      OPENCODE_SERVER_USERNAME: 'happier',
      OPENCODE_SERVER_PASSWORD: 'pw',
    };

    expect(fingerprintFor(noAuth)).not.toBe(fingerprintFor(withAuth));
  });

  // F3: a DIRECT API key (`{type:'api'}` whose key is NOT a broker marker) is a real secret in the
  // env. A direct-key rotation under the SAME account keeps the stable selection identity unchanged,
  // so without folding the direct-key bytes the stale server would keep using the OLD key. Fold a HASH
  // of the non-broker direct-key auth content back into the fingerprint so rotation re-keys the server.
  it('changes the fingerprint when a direct API key rotates under the same selection identity (F3)', () => {
    const base: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|anthropic:console:acct-1',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-console-v1' } }),
    };
    const rotated: NodeJS.ProcessEnv = {
      ...base,
      OPENCODE_AUTH_CONTENT: JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-console-v2' } }),
    };

    expect(fingerprintFor(base)).not.toBe(fingerprintFor(rotated));
  });

  it('keeps the fingerprint stable when a brokered OAuth marker is present and tokens rotate (F3 excludes the broker marker)', () => {
    const base: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:profile:acct-1',
      // The broker marker is a stable, non-secret `{type:'api'}` entry; it must be EXCLUDED from the
      // direct-key fold so OAuth rotation (which never changes the marker) does not churn the server.
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'api', key: 'happier-broker:openai:1' } }),
    };
    const rotated: NodeJS.ProcessEnv = {
      ...base,
      // Same marker (OAuth rotates behind the broker, marker is constant) => identical fingerprint.
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'api', key: 'happier-broker:openai:1' } }),
    };

    expect(fingerprintFor(base)).toBe(fingerprintFor(rotated));
  });

  it('does not react to a non-api (legacy oauth) entry under a stable selection identity (F3 only folds direct api keys)', () => {
    // A legacy `{type:'oauth'}` entry's rotating bytes are governed by the selection identity, NOT the
    // direct-key fold — so rotating its access token must NOT change the fingerprint (preserves the
    // brokered-OAuth no-churn invariant).
    const base: NodeJS.ProcessEnv = {
      HOME: '/Users/example',
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:profile:acct-1',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'token-v1', refresh: 'r1' } }),
    };
    const rotated: NodeJS.ProcessEnv = {
      ...base,
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'token-v2', refresh: 'r2' } }),
    };

    expect(fingerprintFor(base)).toBe(fingerprintFor(rotated));
  });

  it('never exposes the raw direct API key in the fingerprint input (F3 folds a hash only)', () => {
    const directKey = 'sk-ant-console-super-secret';
    const input = resolveOpenCodeManagedServerStateFingerprintInput({
      HOME: '/Users/example',
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|anthropic:console:acct-1',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ anthropic: { type: 'api', key: directKey } }),
    });

    expect(JSON.stringify(input)).not.toContain(directKey);
  });
});

describe('isOpenCodeManagedServerCommand', () => {
  it('matches opencode serve commands case-insensitively', () => {
    expect(isOpenCodeManagedServerCommand('/opt/OpenCode serve --hostname=127.0.0.1')).toBe(true);
    expect(isOpenCodeManagedServerCommand('opencode auth list')).toBe(false);
  });
});
