import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

import { resolvePreflightSessionControlsProbeEnvironment } from './preflightSessionControlsProbeEnvironment';

describe('resolvePreflightSessionControlsProbeEnvironment', () => {
  it('materializes connected-service auth into the env used by provider preflight probes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-preflight-env-'));
    const baseDir = join(root, 'materialized');
    const activeServerDir = join(root, 'server');
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        idToken: 'id-token',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    if (credentials.encryption.type !== 'legacy') throw new Error('test expects legacy credentials');
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        if (params.serviceId !== 'openai-codex' || params.profileId !== 'work') return null;
        return {
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const resolved = await resolvePreflightSessionControlsProbeEnvironment({
      agentId: 'codex',
      probeKind: 'models',
      cwd,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      credentials,
      api,
      accountSettings: {},
      activeServerDir,
      baseDir,
      processEnv: { HOME: join(root, 'home') },
    });

    expect(resolved.env.CODEX_HOME).toContain(join('codex', 'codex-home'));
    const authJson = JSON.parse(await readFile(join(resolved.env.CODEX_HOME!, 'auth.json'), 'utf8')) as Record<string, unknown>;
    expect(authJson).toMatchObject({
      OPENAI_API_KEY: null,
    });
    expect(JSON.stringify(authJson)).toContain('access-token');
  });

  it('fails typed instead of performing raw group CAS when the daemon switch owner is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-preflight-group-owner-'));
    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async () => {
      throw new Error('raw CAS must remain unreachable');
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        v: 1 as const,
        serviceId: 'openai-codex' as const,
        groupId: 'codex-main',
        displayName: 'Codex main',
        policy: { v: 1 as const, strategy: 'least_limited' as const, autoSwitch: true },
        activeProfileId: 'primary',
        generation: 5,
        state: {},
        createdAt: 1,
        updatedAt: 2,
        members: [
          {
            v: 1 as const,
            serviceId: 'openai-codex' as const,
            groupId: 'codex-main',
            profileId: 'primary',
            priority: 1,
            enabled: true,
            state: { quotaExhaustedUntilMs: 5_000 },
            createdAt: 1,
            updatedAt: 2,
          },
          {
            v: 1 as const,
            serviceId: 'openai-codex' as const,
            groupId: 'codex-main',
            profileId: 'backup',
            priority: 2,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'needs_reauth' as const },
          { profileId: 'backup', status: 'connected' as const },
        ],
      })),
      updateConnectedServiceAuthGroupActiveProfile,
    } as unknown as ApiClient;

    await expect(resolvePreflightSessionControlsProbeEnvironment({
      agentId: 'codex',
      probeKind: 'models',
      cwd: root,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
            profileId: 'primary',
          },
        },
      },
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      api,
      activeServerDir: join(root, 'server'),
      baseDir: join(root, 'materialized'),
      processEnv: { HOME: join(root, 'home') },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceAuthGroupSwitchCoordinatorUnavailableError',
      kind: 'switch_coordinator_unavailable',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
    });
    expect(updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
  });
});
