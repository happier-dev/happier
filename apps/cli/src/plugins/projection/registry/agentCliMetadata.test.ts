import { PluginAgentContributionV2Schema, type PluginAgentCliMetadata } from '@happier-dev/protocol';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { createManifestAgentCatalogEntry, createNativeAgentCliAuthSpec } from './agentCliMetadata';

function metadata(params: Readonly<{
  environmentVariables?: readonly string[];
  credentialPaths?: readonly string[];
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
      ...(params.credentialPaths ? { credentialPaths: [...params.credentialPaths] } : {}),
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
  it('projects an external Agent command policy and leaves an undeclared policy absent', () => {
    const cli = metadata({});
    const declaration = {
      id: 'assistant', title: 'Assistant', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
    };
    const withPolicy = PluginAgentContributionV2Schema.parse({
      ...declaration, cli: { ...cli, commandPolicy: { daemonAutostartDefault: 'preferLocalTui' } },
    });
    const withoutPolicy = PluginAgentContributionV2Schema.parse({ ...declaration, cli });
    const project = (definition: typeof withPolicy) => createManifestAgentCatalogEntry({
      agentId: 'acme.assistant/assistant', pluginId: 'acme.assistant', definition,
      cli: definition.cli ?? null, provenance: 'external',
    });
    expect(project(withPolicy)?.cliCommandPolicy).toEqual({ daemonAutostartDefault: 'preferLocalTui' });
    expect(project(withoutPolicy)?.cliCommandPolicy).toBeUndefined();
  });

  it('reads credentials only from the supplied environment and home', async () => {
    const ambientHome = createTempDirSync('happier-auth-ambient-');
    const launchHome = createTempDirSync('happier-auth-launch-');
    try {
      vi.stubEnv('HOME', ambientHome);
      vi.stubEnv('USERPROFILE', ambientHome);
      vi.stubEnv('HAPPIER_AUTH_METADATA_KEY', 'ambient-key');
      writeFileSync(join(ambientHome, 'auth.json'), JSON.stringify({ token: 'ambient-token' }));
      const spec = createNativeAgentCliAuthSpec(metadata({
        environmentVariables: ['HAPPIER_AUTH_METADATA_KEY'], credentialPaths: ['~\\auth.json'],
      }));
      const args = { resolvedPath: '/unused', processEnv: {
        HOME: launchHome, USERPROFILE: launchHome, HAPPIER_AUTH_METADATA_KEY: undefined,
      } };
      await expect(spec.detectAuthStatus?.(args)).resolves.toMatchObject({ state: 'logged_out' });
      writeFileSync(join(launchHome, 'auth.json'), JSON.stringify({ token: 'launch-token' }));
      await expect(spec.detectAuthStatus?.(args)).resolves.toEqual({
        state: 'logged_in', method: 'credentials_file', source: 'file',
      });
      await expect(spec.detectAuthStatus?.({ ...args, processEnv: {
        ...args.processEnv, HAPPIER_AUTH_METADATA_KEY: 'launch-key',
      } })).resolves.toEqual({ state: 'logged_in', method: 'api_key_env', source: 'env' });
      expect(process.env.HAPPIER_AUTH_METADATA_KEY).toBe('ambient-key');
    } finally {
      removeTempDirSync(ambientHome);
      removeTempDirSync(launchHome);
    }
  });

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
