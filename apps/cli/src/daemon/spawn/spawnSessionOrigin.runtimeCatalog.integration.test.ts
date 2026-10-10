import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, snapshotSessionRolesAtSpawnV1, type SessionRolesV1 } from '@happier-dev/protocol';
import { ApiClient } from '@/api/api';
import type { Metadata } from '@/api/types';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { reloadConfiguration } from '@/configuration';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import { getOrCreateSessionByTag } from '@/session/transport/http/sessionsHttp';
import { readSessionCreateOriginFromEnv } from '@/session/shared/sessionCreateOrigin';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';

const originEnvKey = 'HAPPIER_SESSION_CREATE_ORIGIN_V1_JSON';
const origin = { originKind: 'run_step' as const, originRunId: 'workflow-run-1', workDepth: 7 };
const credentials = { token: 'origin-transport-token', encryption: null } as const;
const rolesEnvKey = 'HAPPIER_SESSION_CREATE_ROLES_V1_JSON';
const initialSessionRolesV1: SessionRolesV1 = {
  ...snapshotSessionRolesAtSpawnV1({
    leadSessionId: 'lead-1', notes: 'Keep the agreed boundary',
    roles: { builder: { roleId: 'builder', name: 'Builder', instructions: 'Resolved lead instructions',
      engine: { agentTargetKey: 'agent:codex', modelId: 'worker-model', effort: 'high' },
      runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'encouraged', enabled: true } },
  }),
  roleId: 'builder',
};
const runnerMetadata = {
  path: '/repo', host: 'test', homeDir: '/test-home', happyHomeDir: '/test-home/happier',
  happyLibDir: '/test-lib', happyToolsDir: '/test-tools',
} satisfies Metadata;

describe('host-stamped Session creation facts transport', () => {
  beforeEach(() => {
    vi.stubEnv('HAPPIER_SERVER_URL', 'http://origin.example.test');
    reloadConfiguration();
    // Only HTTP is replaced. Encryption policy, metadata composition and all
    // create/spawn/startup logic remain the real production path.
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/v1/account/profile')) {
        return Response.json({ id: 'account-1' });
      }
      if (url.endsWith('/v1/features')) {
        return Response.json({ features: {}, capabilities: {
          accountStoredContentCompatibility: {
            v: 1, minimumProtocolVersion: 2,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1',
          },
          encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
        } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
    } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    reloadConfiguration();
  });

  it.each([
    origin,
    { originKind: 'session' as const, originSessionId: 'lead-1', workDepth: 0 },
  ])('preserves flat facts across daemon ingress and runner creation: %j', async (facts) => {
    const options = SpawnDaemonSessionRequestSchema.parse({ directory: '/repo', ...facts });
    const prepared = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: { [originEnvKey]: JSON.stringify({ workDepth: 99 }) },
      daemonSpawnHooks: { augmentEnv: () => ({ [originEnvKey]: JSON.stringify({ workDepth: 100 }) }) },
      processEnv: {},
      logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
    });
    if (!prepared.ok) throw new Error(prepared.errorMessage);
    expect(JSON.parse(prepared.extraEnvForChild[originEnvKey]!)).toEqual(facts);
    const childEnv = buildSpawnChildProcessEnv({
      processEnv: { [originEnvKey]: JSON.stringify({ workDepth: 101 }) },
      extraEnv: prepared.extraEnvForChild,
      unsetEnvKeys: prepared.unsetEnvKeys,
    });
    expect(JSON.parse(childEnv[originEnvKey]!)).toEqual(facts);
    vi.stubEnv(originEnvKey, childEnv[originEnvKey]!);
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('observed-create-boundary'));
    const api = await ApiClient.create(credentials);

    await expect(initializeBackendRunSession({
      api, sessionTag: 'ordinary-origin-tag', metadata: runnerMetadata,
      state: { controlledByUser: false }, uiLogPrefix: '[test]',
      startupMetadataOverrides: { permissionModeOverride: { mode: 'default', updatedAt: 1 } },
    })).rejects.toThrow('observed-create-boundary');

    expect(post.mock.calls[0]?.[1]).toMatchObject(facts);
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('origin');
  });

  it('rejects inconsistent origin columns before daemon admission', () => {
    for (const invalid of [
      { originKind: 'none', originSessionId: 'lead-1' },
      { originKind: 'session', originRunId: 'run-1' },
      { originKind: 'run_step', originSessionId: 'lead-1' },
      { originKind: 'execution_run', originSessionId: 'lead-1', workDepth: -1 },
      { originKind: 'session', originSessionId: 'lead-1', workDepth: 1.5 },
      { origin: { kind: 'session', sessionId: 'lead-1' } },
    ]) {
      expect(SpawnDaemonSessionRequestSchema.safeParse({ directory: '/repo', ...invalid }).success).toBe(false);
    }
    expect(SpawnDaemonSessionRequestSchema.parse({ directory: '/repo' })).not.toHaveProperty('originKind');
  });

  it('fails closed on malformed or inconsistent runner creation carriers', () => {
    expect(() => readSessionCreateOriginFromEnv({ [originEnvKey]: '{' })).toThrow();
    expect(() => readSessionCreateOriginFromEnv({ [originEnvKey]: JSON.stringify({ originKind: 'run_step' }) })).toThrow();
  });

  it('does not inherit creation facts from profiles, hooks or the parent process', async () => {
    const prepared = await resolveSpawnChildEnvironment({
      options: { directory: '/repo' },
      profileEnvironmentVariables: { [originEnvKey]: JSON.stringify(origin) },
      daemonSpawnHooks: { augmentEnv: () => ({ [originEnvKey]: JSON.stringify(origin) }) },
      processEnv: { [originEnvKey]: JSON.stringify(origin) },
      logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
    });
    if (!prepared.ok) throw new Error(prepared.errorMessage);
    expect(prepared.extraEnvForChild).not.toHaveProperty(originEnvKey);
    expect(buildSpawnChildProcessEnv({
      processEnv: { [originEnvKey]: JSON.stringify(origin) },
      extraEnv: prepared.extraEnvForChild,
      unsetEnvKeys: prepared.unsetEnvKeys,
    })).not.toHaveProperty(originEnvKey);
  });

  it('carries the same facts through the replay-seeded HTTP creator', async () => {
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('observed-create-boundary'));
    await expect(getOrCreateSessionByTag({
      credentials, tag: 'replay-origin-tag', metadata: {}, agentState: null, ...origin,
    })).rejects.toThrow('observed-create-boundary');
    expect(post.mock.calls[0]?.[1]).toMatchObject(origin);
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('origin');
  });

  it('carries host facts from the canonical spawned-session creator to daemon admission', async () => {
    let admitted: unknown;
    await expect(createSpawnedSession({
      credentials, directory: '/repo', ...origin,
      directTransport: {
        spawn: async (request: unknown) => { admitted = request; throw new Error('observed-spawn-boundary'); },
        resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
      },
    })).rejects.toThrow('observed-spawn-boundary');
    expect(admitted).toMatchObject(origin);
  });

  it('carries an explicit lead through protected daemon environment into the same child create request', async () => {
    const relationEnvKey = 'HAPPIER_SESSION_CREATE_REPORTS_TO_V1_JSON';
    const reportsTo = { sessionId: 'lead-1' };
    const prepared = await resolveSpawnChildEnvironment({
      options: SpawnDaemonSessionRequestSchema.parse({ directory: '/repo', reportsTo }),
      profileEnvironmentVariables: { [relationEnvKey]: JSON.stringify({ sessionId: 'spoofed-profile' }) },
      daemonSpawnHooks: { augmentEnv: () => ({ [relationEnvKey]: JSON.stringify({ sessionId: 'spoofed-hook' }) }) },
      processEnv: {}, logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
    });
    if (!prepared.ok) throw new Error(prepared.errorMessage);
    expect(JSON.parse(prepared.extraEnvForChild[relationEnvKey]!)).toEqual(reportsTo);
    vi.stubEnv(relationEnvKey, prepared.extraEnvForChild[relationEnvKey]!);
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('observed-create-boundary'));
    const api = await ApiClient.create(credentials);
    await expect(initializeBackendRunSession({
      api, sessionTag: 'worker-relation-tag', metadata: runnerMetadata,
      state: { controlledByUser: false }, uiLogPrefix: '[test]',
      startupMetadataOverrides: { permissionModeOverride: { mode: 'default', updatedAt: 1 } },
    })).rejects.toThrow('observed-create-boundary');
    expect(post.mock.calls[0]?.[1]).toMatchObject({ reportsTo });
  });

  it('persists the complete host role snapshot with the selected worker role before runner startup returns', async () => {
    const prepared = await resolveSpawnChildEnvironment({
      options: SpawnDaemonSessionRequestSchema.parse({ directory: '/repo', initialSessionRolesV1 }),
      profileEnvironmentVariables: { [rolesEnvKey]: JSON.stringify({ roleId: 'orchestrator' }) },
      daemonSpawnHooks: { augmentEnv: () => ({ [rolesEnvKey]: JSON.stringify({ roleId: 'orchestrator' }) }) },
      processEnv: {}, logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
    });
    if (!prepared.ok) throw new Error(prepared.errorMessage);
    const childEnv = buildSpawnChildProcessEnv({
      processEnv: { [rolesEnvKey]: JSON.stringify({ roleId: 'orchestrator' }) },
      extraEnv: prepared.extraEnvForChild,
    });
    expect(JSON.parse(childEnv[rolesEnvKey]!)).toEqual(initialSessionRolesV1);
    vi.stubEnv(rolesEnvKey, childEnv[rolesEnvKey]!);
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('observed-create-boundary'));
    const api = await ApiClient.create(credentials);
    await expect(initializeBackendRunSession({
      api, sessionTag: 'worker-roles-tag', metadata: { ...runnerMetadata,
        work: { sessionWorkflowActivityHeadlineV1: { v: 1, backendId: 'codex', updatedAt: 1, activeRuns: [] } } },
      state: { controlledByUser: false }, uiLogPrefix: '[test]',
      startupMetadataOverrides: { permissionModeOverride: { mode: 'default', updatedAt: 1 } },
    })).rejects.toThrow('observed-create-boundary');
    const input = post.mock.calls[0]?.[1] as { ownerMetadata: { t: 'plain'; v: unknown }; sharedMetadata: { ciphertext: string } };
    expect(input.ownerMetadata).toMatchObject({ t: 'plain', v: { work: {
      sessionWorkflowActivityHeadlineV1: { v: 1, backendId: 'codex', updatedAt: 1, activeRuns: [] },
      sessionRolesV1: initialSessionRolesV1,
    } } });
    expect(JSON.parse(input.sharedMetadata.ciphertext)).not.toHaveProperty('work');
    expect(input).not.toHaveProperty('initialSessionRolesV1');
    expect(initialSessionRolesV1).not.toHaveProperty('memoryDocRef');
  });

  it('carries host roles through the canonical spawn creator but refuses them on an existing-session attach', async () => {
    let admitted: unknown;
    await expect(createSpawnedSession({
      credentials, directory: '/repo', initialSessionRolesV1,
      directTransport: {
        spawn: async (request) => { admitted = request; throw new Error('observed-spawn-boundary'); },
        resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
      },
    })).rejects.toThrow('observed-spawn-boundary');
    expect(admitted).toMatchObject({ initialSessionRolesV1 });
    expect(SpawnDaemonSessionRequestSchema.safeParse({ directory: '/repo', existingSessionId: 'existing', initialSessionRolesV1 }).success).toBe(false);
    expect(SpawnDaemonSessionRequestSchema.safeParse({ directory: '/repo', initialSessionRolesV1: { ...initialSessionRolesV1, inventedAuthority: true } }).success).toBe(false);
  });

  it.each(['runner', 'replay'] as const)('creates a worker without lead Session context at the %s HTTP creator', async (creator) => {
    const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } };
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('observed-create-boundary'));
    const api = await ApiClient.create(credentials);
      vi.mocked(axios.get).mockResolvedValueOnce({ status: 200, data: currentness });
      const metadata = { ...runnerMetadata, work: { sessionRolesV1: initialSessionRolesV1 } };
      const create = creator === 'runner'
        ? api.getOrCreateSession({ tag: 'worker-create', metadata, state: null })
        : getOrCreateSessionByTag({ credentials, tag: 'worker-create', metadata, agentState: null });
      await expect(create).rejects.toThrow('observed-create-boundary');
      const input = post.mock.calls.at(-1)?.[1];
      expect(input).toMatchObject({ ownerMetadata: { t: 'plain', v: { work: { sessionRolesV1: {
        roleId: 'builder', sessionRoles: initialSessionRolesV1.sessionRoles, notes: initialSessionRolesV1.notes,
      } } } } });
      expect(input).not.toHaveProperty('ownerMetadata.v.work.sessionRolesV1.memoryDocRef');
      expect(input).not.toHaveProperty('ownerMetadata.v.work.promptStack');
  });

  it('does not inherit role creation content from profile, hook or parent process', async () => {
    const prepared = await resolveSpawnChildEnvironment({
      options: { directory: '/repo' }, profileEnvironmentVariables: { [rolesEnvKey]: JSON.stringify(initialSessionRolesV1) },
      daemonSpawnHooks: { augmentEnv: () => ({ [rolesEnvKey]: JSON.stringify(initialSessionRolesV1) }) },
      processEnv: { [rolesEnvKey]: JSON.stringify(initialSessionRolesV1) },
      logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
    });
    if (!prepared.ok) throw new Error(prepared.errorMessage);
    expect(buildSpawnChildProcessEnv({ processEnv: { [rolesEnvKey]: JSON.stringify(initialSessionRolesV1) },
      extraEnv: prepared.extraEnvForChild })).not.toHaveProperty(rolesEnvKey);
    vi.stubEnv(rolesEnvKey, '{');
    const api = await ApiClient.create(credentials);
    const post = vi.spyOn(axios, 'post');
    await expect(initializeBackendRunSession({
      api, sessionTag: 'malformed-roles-tag', metadata: runnerMetadata,
      state: { controlledByUser: false }, uiLogPrefix: '[test]',
      startupMetadataOverrides: { permissionModeOverride: { mode: 'default', updatedAt: 1 } },
    })).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});
