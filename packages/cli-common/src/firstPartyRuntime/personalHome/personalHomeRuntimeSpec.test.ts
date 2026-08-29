import { describe, expect, it } from 'vitest';

import {
  createPersonalHomeRuntimeSpec,
  parsePersonalHomeRuntimePurpose,
  renderPersonalHomeRuntimeEnv,
  resolvePersonalHomeRuntimeSpec,
} from './personalHomeRuntimeSpec.js';
import { resolvePersonalHomeRuntimeLayout } from './layout.js';
import { parseRelayRuntimeTaskParams } from '../../systemTasks/kinds/relayRuntimeKinds.js';

describe('Personal Home runtime purpose', () => {
  it('renders the fixed loopback/plaintext bootstrap environment', () => {
    const spec = createPersonalHomeRuntimeSpec({
      canonicalServerUrl: 'http://127.0.0.1:43123',
    });

    expect(spec).toEqual({
      purpose: 'personal-home',
      bindAddress: '127.0.0.1',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      encryptionStoragePolicy: 'plaintext_only',
      defaultAccountMode: 'plain',
      anonymousSignupPhase: 'loopback-bootstrap-then-disabled',
    });
    expect(renderPersonalHomeRuntimeEnv({ spec, port: 43123 })).toEqual({
      HAPPIER_SERVER_HOST: '127.0.0.1',
      PORT: '43123',
      HAPPIER_PUBLIC_SERVER_URL: 'http://127.0.0.1:43123',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
      AUTH_ANONYMOUS_SIGNUP_ENABLED: '1',
    });
  });

  it('renders signup closure without changing the canonical origin', () => {
    const spec = resolvePersonalHomeRuntimeSpec({
      canonicalServerUrl: 'http://127.0.0.1:43123',
    });

    expect(renderPersonalHomeRuntimeEnv({
      spec,
      port: 43123,
      anonymousSignupEnabled: false,
    }).AUTH_ANONYMOUS_SIGNUP_ENABLED).toBe('0');
    expect(renderPersonalHomeRuntimeEnv({
      spec,
      port: 43123,
      anonymousSignupEnabled: false,
    }).HAPPIER_PUBLIC_SERVER_URL).toBe('http://127.0.0.1:43123');
  });

  it('rejects arbitrary environment injection and malformed purposes', () => {
    const spec = createPersonalHomeRuntimeSpec({
      canonicalServerUrl: 'http://127.0.0.1:43123',
    });

    expect(() => renderPersonalHomeRuntimeEnv({
      spec,
      port: 43123,
      overrides: { HANDY_MASTER_SECRET: 'must-not-be-user-injected' },
    })).toThrow(/unsupported Personal Home environment key/u);
    expect(() => parsePersonalHomeRuntimePurpose({
      kind: 'personal-home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      env: { arbitrary: 'value' },
    })).toThrow(/unsupported Personal Home environment key/u);
    expect(() => parseRelayRuntimeTaskParams({
      target: { kind: 'local' },
      purpose: {
        kind: 'personal-home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
      },
      env: { HANDY_MASTER_SECRET: 'must-not-be-user-injected' },
    })).toThrow(/unsupported Personal Home environment key/u);
  });

  it('resolves the Personal Home data paths beneath the managed runtime root', () => {
    const layout = resolvePersonalHomeRuntimeLayout({
      homeDir: '/tmp/personal-home-layout-test',
      platform: 'linux',
      mode: 'user',
    });

    expect(layout.installRoot).toBe('/tmp/personal-home-layout-test/.happier/self-host');
    expect(layout.configDir).toBe(`${layout.installRoot}/config`);
    expect(layout.logsDir).toBe(`${layout.installRoot}/logs`);
    expect(layout.dataDir).toBe(`${layout.installRoot}/data`);
    expect(layout.databasePath).toBe(`${layout.dataDir}/happier-server-light.sqlite`);
    expect(layout.publicFilesDir).toBe(`${layout.dataDir}/files`);
    expect(layout.privateFilesDir).toBe(`${layout.dataDir}/files/private`);
    expect(layout.masterSecretPath).toBe(`${layout.dataDir}/handy-master-secret.txt`);
    expect(layout.backupsDir).toBe(`${layout.dataDir}/backups`);
    expect(layout.derivedDataDir).toBe(`${layout.dataDir}/derived`);
  });
});
