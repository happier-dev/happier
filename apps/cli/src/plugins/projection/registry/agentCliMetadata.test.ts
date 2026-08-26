import type { PluginAgentCliMetadata } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativeAgentCliAuthSpec } from './agentCliMetadata';

function metadata(params: Readonly<{
  environmentVariables?: readonly string[];
  missingCredentialState?: 'logged_out' | 'unknown';
  nonInteractiveStatusProbe?: true;
}>): PluginAgentCliMetadata {
  return {
    executable: {
      binaryName: 'acme',
      sourcePreference: 'system-first',
    },
    install: {
      managed: null,
      manual: { kind: 'command' },
    },
    auth: {
      support: 'status_only',
      ...(params.environmentVariables ? { environmentVariables: [...params.environmentVariables] } : {}),
      ...(params.missingCredentialState
        ? { missingCredentialState: params.missingCredentialState }
        : {}),
      ...(params.nonInteractiveStatusProbe ? { nonInteractiveStatusProbe: true } : {}),
      loginLaunches: [],
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('native Agent CLI auth metadata', () => {
  it('uses host-owned declared environment facts and preserves both absent-credential semantics', async () => {
    const loggedOutSpec = createNativeAgentCliAuthSpec(metadata({
      environmentVariables: ['HAPPIER_AUTH_METADATA_LOGGED_OUT'],
    }));
    const unknownSpec = createNativeAgentCliAuthSpec(metadata({
      environmentVariables: ['HAPPIER_AUTH_METADATA_UNKNOWN'],
      missingCredentialState: 'unknown',
    }));
    const manualOnlySpec = createNativeAgentCliAuthSpec(metadata({}));

    expect(loggedOutSpec.isSafeForBackgroundChecks).toBe(true);
    expect(unknownSpec.isSafeForBackgroundChecks).toBe(true);
    expect(manualOnlySpec.isSafeForBackgroundChecks).toBe(false);

    vi.stubEnv('HAPPIER_AUTH_METADATA_LOGGED_OUT', '');
    vi.stubEnv('HAPPIER_AUTH_METADATA_UNKNOWN', '');
    await expect(loggedOutSpec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
    });
    await expect(unknownSpec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
      state: 'unknown',
      reason: 'unsupported',
    });

    vi.stubEnv('HAPPIER_AUTH_METADATA_LOGGED_OUT', 'present');
    vi.stubEnv('HAPPIER_AUTH_METADATA_UNKNOWN', 'present');
    await expect(loggedOutSpec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
    await expect(unknownSpec.detectAuthStatus?.({ resolvedPath: '/unused' })).resolves.toEqual({
      state: 'logged_in',
      method: 'api_key_env',
      source: 'env',
    });
  });
});
