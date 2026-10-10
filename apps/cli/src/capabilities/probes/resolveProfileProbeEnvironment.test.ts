import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { resolveProfileProbeEnvironment } from './resolveProfileProbeEnvironment';
const predecessorCatalog = { status: 'ready' as const, source: 'legacy' as const, authority: 'inactive' as const, control: null,
  controlRevision: 'absent' as const, referenceGuardRevision: 'absent' as const, diagnostics: [], records: [] };

describe('resolveProfileProbeEnvironment', () => {
  afterEach(() => vi.restoreAllMocks());
  it('probes the destination Profile row rather than a retained Settings definition', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 1 } };
      throw new Error(`Unexpected profile probe HTTP path: ${path}`);
    });
    const request = {
      agentId: 'codex', profileId: 'work', accountSettings: { profiles: [{ v: 2, id: 'work', name: 'Stale',
        extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'stale' }], createdAt: 1, updatedAt: 1 }] },
      credentials: { token: 'token', encryption: null }, processEnv: {},
      profileCatalog: { status: 'ready' as const, source: 'destination' as const, authority: 'active' as const, controlRevision: 1,
        control: { revision: 1, record: { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 1, migratedLogicalRevision: 1, inventory: [] } },
        referenceGuardRevision: 4, diagnostics: [], records: [{ revision: 4,
        record: { v: 1 as const, id: 'work', enabled: true, promptStack: [], secretBindings: {},
          definition: { kind: 'inline' as const, profile: { v: 2 as const, id: 'work', name: 'Work',
            extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'destination' }],
            defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
            createdAt: 1, updatedAt: 1 } } } }] },
    };
    await expect(resolveProfileProbeEnvironment(request)).resolves.toEqual({ cacheKey: 'work',
      env: { TEAM_FLAG: 'destination', HAPPIER_SESSION_PROFILE_ID: 'work' } });
    await expect(resolveProfileProbeEnvironment({ ...request,
      profileCatalog: { ...request.profileCatalog, records: request.profileCatalog.records.map((row) => ({
        ...row, record: { ...row.record, enabled: false },
      })) },
    })).rejects.toThrow();
  });

  it('materializes a one-launch strict saved-secret reference for an otherwise unbound profile requirement', async () => {
    // Account HTTP transport is the system boundary; profile parsing and secret materialization stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
      throw new Error(`Unexpected account request: ${path}`);
    });
    const recoverySecret = new Uint8Array(32).fill(7);
    const settingsKey = deriveSettingsSecretsKeyV1(deriveAccountMachineKeyFromRecoverySecret(recoverySecret));
    const encryptedValue = encryptSecretStringV1('selected-secret', settingsKey, (length) => new Uint8Array(length).fill(3));
    const request = {
      agentId: 'codex', profileId: 'work',
      profileCatalog: predecessorCatalog,
      accountSettings: {
        profiles: [{ id: 'work', name: 'Work', environmentVariables: [{ name: 'OPENAI_API_KEY', value: '${PROFILE_KEY}' }],
          envVarRequirements: [{ name: 'PROFILE_KEY', kind: 'secret', required: true }],
          compatibilityByTargetKey: { 'agent:codex': true }, defaultEnabled: true, isBuiltIn: false }],
        secrets: [{ id: 'selected-key', name: 'Selected key', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue } }],
      },
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: recoverySecret } },
      processEnv: { HOME: '/home/alice' },
      secretReferenceOverlay: { v: 1 as const, bindings: { PROFILE_KEY: { ref: 'selected-key' } } },
    };
    await expect(resolveProfileProbeEnvironment(request)).resolves.toEqual({ cacheKey: 'work', env: {
      HAPPIER_SESSION_PROFILE_ID: 'work', OPENAI_API_KEY: 'selected-secret', PROFILE_KEY: 'selected-secret',
    } });
  });

  it('materializes the selected profile variables and Saved Secrets for every probe backend', async () => {
    // The current reader also observes Account mode and authoring memory. Keep
    // those owners real and provide only the exact Home HTTP responses.
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      expect(options?.headers?.Authorization).toBe('Bearer token');
      const path = new URL(String(url)).pathname;
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (path === '/v1/account/authoring-memory/lastUsedProfile') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 1 } };
      throw new Error(`Unexpected profile probe HTTP path: ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
      throw new Error('A profile preflight with no legacy authoring memory must not write');
    });
    const recoverySecret = new Uint8Array(32).fill(7);
    const settingsKey = deriveSettingsSecretsKeyV1(
      deriveAccountMachineKeyFromRecoverySecret(recoverySecret),
    );
    const encryptedValue = encryptSecretStringV1(
      'profile-api-key',
      settingsKey,
      (length) => new Uint8Array(length).fill(3),
    );

    const accountSettings = {
        profiles: [{
          id: 'work',
          name: 'Work',
          environmentVariables: [
            { name: 'CODEX_HOME', value: '/profiles/work/codex' },
            { name: 'OPENAI_API_KEY', value: '${PROFILE_OPENAI_API_KEY}' },
          ],
          envVarRequirements: [{ name: 'PROFILE_OPENAI_API_KEY', kind: 'secret', required: true }],
          compatibilityByTargetKey: { 'agent:codex': true },
          defaultEnabled: true,
          isBuiltIn: false,
        }],
        secrets: [{
          id: 'personal-profile-key',
          name: 'Profile API key',
          kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, encryptedValue },
        }],
        secretBindingsByProfileId: {
          work: { PROFILE_OPENAI_API_KEY: 'personal-profile-key' },
        },
      };
    const credentials = {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: recoverySecret },
      };
    const expected = {
      cacheKey: 'work',
      env: {
        CODEX_HOME: '/profiles/work/codex',
        HAPPIER_SESSION_PROFILE_ID: 'work',
        OPENAI_API_KEY: 'profile-api-key',
        PROFILE_OPENAI_API_KEY: 'profile-api-key',
      },
    };

    for (const agentId of ['codex', 'acme.review/reviewer']) {
      await expect(resolveProfileProbeEnvironment({
        agentId,
        profileId: 'work',
        accountSettings,
        profileCatalog: predecessorCatalog,
        credentials,
        processEnv: { HOME: '/home/alice' },
      })).resolves.toEqual(expected);
    }
    expect(post).not.toHaveBeenCalled();
  });
});
