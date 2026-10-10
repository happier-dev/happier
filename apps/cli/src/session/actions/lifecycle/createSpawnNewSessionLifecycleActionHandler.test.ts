import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { ensureSessionDirectory } from '@/daemon/startup/ensureSessionDirectory';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    getLogPath: () => '/tmp/happier-spawn-test.log',
  },
}));

import { createSpawnNewSessionLifecycleActionHandler } from './createSpawnNewSessionLifecycleActionHandler';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { buildSpawnChildProcessEnv } from '@/daemon/spawn/buildSpawnChildProcessEnv';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';

describe('createSpawnNewSessionLifecycleActionHandler', () => {
  it.each([false, true])('accepts the canonical Agent target without a legacy backend target (model selection: %s)', async withModel => {
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const modelSelection = { v: 1 as const, updatedAt: 1791524847849,
      ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' } };
    // Physical Session runner launch is the boundary. Request admission remains real.
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({ type: 'success' as const, sessionId: 'agent-session' }));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    expect(await handler({ directory: '/home/ubuntu', agentTarget, ...(withModel ? { modelSelection } : {}) }))
      .toMatchObject({ type: 'success', sessionId: 'agent-session' });
    expect(spawnSession.mock.calls[0]?.[0]).toMatchObject({ agentTarget, ...(withModel ? { modelSelection } : {}) });
    expect(spawnSession.mock.calls[0]?.[0].backendTarget).toBeUndefined();
  });

  it('rejects a model selected for another canonical Agent before runner launch', async () => {
    const spawnSession = vi.fn();
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    expect(await handler({ directory: '/home/ubuntu',
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: null, modelId: 'gpt-5' } },
    })).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('keeps legacy backend model admission normalized by the same spawn schema', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({ type: 'success' as const, sessionId: 'legacy-session' }));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    expect(await handler({ directory: '/home/ubuntu',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      modelId: ' claude-haiku-4-5 ', modelUpdatedAt: 1,
    })).toMatchObject({ type: 'success', sessionId: 'legacy-session' });
    expect(spawnSession.mock.calls[0]?.[0]).toMatchObject({
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.claude/claude',
        providerConnectionId: null, modelId: 'claude-haiku-4-5' } },
    });
  });

  it('does not launch an admitted foreign requester with the custodian Account', async () => {
    const launched: SpawnSessionOptions[] = [];
    // Process launch is the boundary; Machine admission has already been verified by RPC transport.
    const handler = createSpawnNewSessionLifecycleActionHandler({ serverId: 'home', spawnSession: async (options) => {
      launched.push(options);
      return { type: 'success', sessionId: 'wrong-owner-session' };
    } });
    expect(await handler({ directory: '/repo', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } }, {
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true,
    })).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE });
    expect(launched).toEqual([]);
  });

  it('stamps requester attribution only from current admitted owner context, not author fields', async () => {
    let launched: SpawnSessionOptions | undefined;
    const handler = createSpawnNewSessionLifecycleActionHandler({ serverId: 'home', spawnSession: async (options) => {
      launched = options;
      return { type: 'success', sessionId: 'owner-session' };
    } });
    const machineAdmission = { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'machine',
      installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const input = { directory: '/repo', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } };
    expect(await handler(input, { machineAdmission, verifyMachineAdmissionCurrent: async () => true }))
      .toMatchObject({ type: 'success', sessionId: 'owner-session' });
    expect(launched).toMatchObject({ requesterWorkAttributionV1: {
      serverId: 'home', accountId: 'alice', machineId: 'machine', installationId: 'installation',
    } });
    launched = undefined;
    expect(await handler(input, { machineAdmission, verifyMachineAdmissionCurrent: async () => false }))
      .toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE });
    expect(launched).toBeUndefined();
    expect(await handler({ ...input, requesterWorkAttributionV1: { serverId: 'home', accountId: 'bob',
      machineId: 'machine', installationId: 'installation' } })).toMatchObject({
      type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(await handler({ ...input, requesterSessionRuntimeContext: { credentials: { token: 'authored' } } }))
      .toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
  });

  it('creates a Bot through admitted daemon spawn controls before Agent startup without an instruction document', async () => {
    const identity = { bot: { kind: 'bot' }, createdAsBot: true };
    let initialMetadata: unknown;
    // A configured test Agent avoids probing a host-installed CLI. Process launch
    // is the boundary; admission, child env and metadata creation stay real.
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession: async (options) => {
      const environment = await resolveSpawnChildEnvironment({
        options, processEnv: {}, profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      if (!environment.ok) throw new Error(environment.errorMessage);
      const childEnvironment = buildSpawnChildProcessEnv({ processEnv: {}, extraEnv: environment.extraEnvForChild });
      initialMetadata = createSessionMetadata({
        flavor: 'test-agent', machineId: 'machine-1', directory: options.directory,
        launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: childEnvironment }),
      }).metadata;
      return { type: 'success', sessionId: 'bot-session' };
    } });
    const createdBot = await handler({ directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'test-agent', configuredBackendId: 'test-agent', sourceKind: 'configured' },
      identity, memoryEnabled: false });
    expect(createdBot, JSON.stringify(createdBot)).toMatchObject({
      type: 'success', sessionId: 'bot-session',
    });
    expect(initialMetadata).toMatchObject({ ...identity, work: { memoryEnabled: false } });
    expect(initialMetadata).not.toHaveProperty('work.memoryDocRef');
    expect(await handler({ directory: '/tmp/project', identity, existingSessionId: 'retained-session' })).toMatchObject({
      type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
  });
  it('materializes fresh managed allocations without ordinary directory approval', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-managed-spawn-'));
    try {
      const directories = createManagedSessionDirectories({ activeServerDir });
      const sessionCreationTag = deriveSessionCreationTagV1({
        callerCreationNamespace: 'user', creationKey: 'managed-first-send',
      });
      const allocation = directories.prepareForCreation({ sessionCreationTag });
      // Process launch is the boundary; directory admission uses the real owners.
      const handler = createSpawnNewSessionLifecycleActionHandler({
        spawnSession: async (options) => {
          const prepared = options.directoryKind === 'managed'
            ? await directories.prepareForSpawn(options)
            : await ensureSessionDirectory({
              directory: options.directory,
              approvedNewDirectoryCreation: options.approvedNewDirectoryCreation ?? false,
            });
          if (!prepared.ok) return 'response' in prepared ? prepared.response : {
            type: 'error', errorCode: prepared.errorCode, errorMessage: 'Managed allocation unavailable',
          };
          return { type: 'success', sessionId: 'managed-created' };
        },
      });
      await expect(handler({
        directory: allocation.directory,
        directoryKind: 'managed',
        sessionCreationTag,
        approvedNewDirectoryCreation: false,
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      })).resolves.toEqual({ type: 'success', sessionId: 'managed-created' });
      await expect(access(allocation.directory)).resolves.toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
  it('acknowledges a cancellation signal before spawning a process', async () => {
    const spawnSession = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });

    await expect(handler({
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    }, { signal: controller.signal })).resolves.toEqual({
      type: 'error',
      errorCode: 'cancelled',
      errorMessage: 'cancelled',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('preserves accepted spawn identity for method-specific RPC projection', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      spawnNonce: 'spawn-nonce-1',
      sessionIdStatus: 'pending',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });

    await expect(handler({
      directory: '/tmp/project',
      spawnNonce: 'spawn-nonce-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    })).resolves.toEqual({
      type: 'success',
      spawnNonce: 'spawn-nonce-1',
      sessionIdStatus: 'pending',
    });
  });

  it('validates and forwards the canonical Team credential binding to the daemon spawn owner', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-created',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    const teamCredentialBinding = {
      v: 1 as const,
      slot: { kind: 'provider_model' as const },
      resourceId: 'resource-1',
      expectedResourceRevision: 3,
      deliveryMode: 'brokered' as const,
    };

    await expect(handler({
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      teamCredentialBindings: [teamCredentialBinding],
    })).resolves.toEqual({ type: 'success', sessionId: 'session-created' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ teamCredentialBindings: [teamCredentialBinding] }));

    await expect(handler({
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      teamCredentialBindings: [{ ...teamCredentialBinding, unexpected: true }],
    })).resolves.toEqual(expect.objectContaining({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    }));
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('forwards the admitted creation identity, immutable recipe, and initial title to the daemon owner', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-created',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-1',
    });
    const secretReferenceOverlay = {
      v: 1 as const,
      bindings: {
        ANTHROPIC_API_KEY: {
          ref: 'happier:shared-secret:v1:shared-anthropic',
          revision: 7,
        },
      },
    };
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-exact', directory: { kind: 'path', path: '/tmp/project' } },
        organization: { folderId: 'folder-original', tagIds: ['tag-original'] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: 'profile-shared',
        identity: { bot: { kind: 'bot' }, createdAsBot: true },
        memoryEnabled: false,
        secretReferenceOverlay,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });

    const createdSession = await handler({
      directory: '/tmp/project',
      machineId: 'machine-exact',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      sessionCreationTag,
      sessionCreationCorrespondence,
      initialTitle: 'Atomic initial title',
    });
    expect(createdSession, JSON.stringify(createdSession)).toEqual({ type: 'success', sessionId: 'session-created' });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionCreationTag,
      sessionCreationCorrespondence,
      profileId: 'profile-shared',
      secretReferenceOverlay,
      initialTitle: 'Atomic initial title',
      identity: { bot: { kind: 'bot' }, createdAsBot: true },
      memoryEnabled: false,
    }));
    await expect(handler({ directory: '/tmp/project', sessionCreationTag,
      sessionCreationCorrespondence, memoryEnabled: true })).resolves.toMatchObject({
      type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    // A retained birth recipe is retry evidence, not authority to reset an attached Session.
    await expect(handler({ directory: '/tmp/project', existingSessionId: 'retained-session',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionCreationTag, sessionCreationCorrespondence })).resolves.toMatchObject({ type: 'success' });
    expect(spawnSession.mock.calls.at(-1)?.[0]).not.toHaveProperty('identity');
    expect(spawnSession.mock.calls.at(-1)?.[0]).not.toHaveProperty('memoryEnabled');
  });

  it('fails closed before spawn when duplicate launch references disagree with immutable correspondence', async () => {
    const spawnSession = vi.fn();
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-conflict',
    });
    const correspondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-exact', directory: { kind: 'path', path: '/tmp/project' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: 'profile-original',
        secretReferenceOverlay: {
          v: 1,
          bindings: {
            OPENAI_API_KEY: {
              ref: 'happier:shared-secret:v1:original',
              revision: 3,
            },
          },
        },
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        mcpSelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });

    for (const conflicting of [
      {
        profileId: 'profile-other',
        secretReferenceOverlay: correspondence.recipe.secretReferenceOverlay,
      },
      {
        profileId: correspondence.recipe.profileId,
        secretReferenceOverlay: {
          v: 1 as const,
          bindings: {
            OPENAI_API_KEY: {
              ref: 'happier:shared-secret:v1:other',
              revision: 4,
            },
          },
        },
      },
    ]) {
      await expect(handler({
        directory: '/tmp/project',
        backendTarget: {
          kind: 'backend',
          backendId: 'review-bot',
          configuredBackendId: 'review-bot',
          sourceKind: 'configured',
        },
        sessionCreationTag,
        sessionCreationCorrespondence: correspondence,
        ...conflicting,
      })).resolves.toMatchObject({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      });
    }

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('rejects a malformed launch overlay before invoking the daemon spawn owner', async () => {
    const spawnSession = vi.fn();
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });

    await expect(handler({
      directory: '/tmp/project',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      profileId: 'profile-shared',
      secretReferenceOverlay: {
        v: 1,
        bindings: {
          OPENAI_API_KEY: {
            ref: 'not-a-canonical-reference',
            revision: 1,
          },
        },
      },
    })).resolves.toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('keeps private spawn request and result identities out of persistent diagnostics', async () => {
    const privateDirectory = '/Users/private-user/work/client-project';
    const privateMachineId = 'machine-private-identity';
    const privateProfileId = 'profile-private-identity';
    const privateBackendId = 'backend-private-identity';
    const privateEnvironmentKey = 'PRIVATE_CUSTOMER_TOKEN';
    const privateEnvironmentValue = 'private-environment-value';
    const privateSessionId = 'session-private-identity';
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: privateSessionId,
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });

    await handler({
      directory: privateDirectory,
      machineId: privateMachineId,
      profileId: privateProfileId,
      backendTarget: {
        kind: 'backend',
        backendId: privateBackendId,
        configuredBackendId: privateBackendId,
        sourceKind: 'configured',
      },
      environmentVariables: {
        [privateEnvironmentKey]: privateEnvironmentValue,
      },
    });

    const diagnostics = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    for (const privateFact of [
      privateDirectory,
      privateMachineId,
      privateProfileId,
      privateBackendId,
      privateEnvironmentKey,
      privateEnvironmentValue,
      privateSessionId,
    ]) {
      expect(diagnostics).not.toContain(privateFact);
    }
    expect(logger.debug).toHaveBeenCalledWith(
      '[API MACHINE] Session spawn succeeded',
    );
  });

  it('derives a stable fresh-spawn nonce from the caller session id when none is provided', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-1',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    const input = {
      directory: '/tmp/project',
      sessionId: 'pending-session-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    } as const;

    await handler(input);
    await handler(input);

    const firstSpawnNonce = spawnSession.mock.calls[0]?.[0].spawnNonce;
    const secondSpawnNonce = spawnSession.mock.calls[1]?.[0].spawnNonce;
    expect(firstSpawnNonce).toEqual(expect.any(String));
    expect(firstSpawnNonce).toBe(secondSpawnNonce);
  });

  it('carries current Codex selection through runtimeDescriptorV1 only', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-1',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });

    const result = await handler({
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'acp' },
      },
    });

    expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
    const spawnOptions = spawnSession.mock.calls[0]?.[0];
    expect(spawnOptions?.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'codex',
      agent: { backendMode: 'acp' },
    });
    expect(spawnOptions).not.toHaveProperty('backendMode');
    expect(spawnOptions).not.toHaveProperty('codexBackendMode');
  });

  it('preserves exact opaque execution-authorization request-id bytes', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-1',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });

    await handler({
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      executionAuthorization: {
        provenance: 'user_request',
        requestId: ' request-1 ',
      },
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      executionAuthorization: {
        provenance: 'user_request',
        requestId: ' request-1 ',
      },
    }));
  });

  it('strictly parses, freezes, and forwards global Voice startup instructions for fresh spawn', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-voice',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    const agentSessionStartupInstructionsV1 = {
      v: 1,
      id: 'happier.global_voice_agent',
      revision: 2,
      instructions: 'Global Voice startup instructions.',
    } as const;

    await expect(handler({
      directory: '/tmp/voice',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      agentSessionStartupInstructionsV1,
    })).resolves.toEqual({ type: 'success', sessionId: 'session-voice' });

    const forwarded = spawnSession.mock.calls[0]?.[0].agentSessionStartupInstructionsV1;
    expect(forwarded).toEqual(agentSessionStartupInstructionsV1);
    expect(forwarded).not.toBe(agentSessionStartupInstructionsV1);
    expect(Object.isFrozen(forwarded)).toBe(true);
  });

  it('rejects malformed startup instructions without forwarding or exposing their text', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-voice',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    const privateInstructionText = 'PRIVATE STARTUP INSTRUCTION SENTINEL';

    const result = await handler({
      directory: '/tmp/voice',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      agentSessionStartupInstructionsV1: {
        v: 1,
        id: 'happier.global_voice_agent',
        revision: 2,
        instructions: privateInstructionText,
        unexpected: true,
      },
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Invalid agent session startup instructions',
    });
    expect(JSON.stringify(result)).not.toContain(privateInstructionText);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('forwards startup instructions for the supported resume-session path', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({
      type: 'success',
      sessionId: 'session-voice',
    } as const));
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession });
    const agentSessionStartupInstructionsV1 = {
      v: 1,
      id: 'happier.global_voice_agent',
      revision: 2,
      instructions: 'Global Voice startup instructions.',
    } as const;

    await expect(handler({
      type: 'resume-session',
      sessionId: 'session-voice',
      directory: '/tmp/voice',
      agentSessionStartupInstructionsV1,
    })).resolves.toEqual({ type: 'success' });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'session-voice',
      agentSessionStartupInstructionsV1,
    }));
  });

  it('recreates a missing managed resume folder only with explicit request consent', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-resume-consent-'));
    try {
      const directories = createManagedSessionDirectories({ activeServerDir });
      const allocation = await directories.materializeForFreshSpawn({ sessionCreationTag: 'creation:resume-consent' });
      await directories.bind({ allocationId: allocation.allocationId, sessionId: 'managed-session' });
      await rm(allocation.directory, { recursive: true });
      // The process boundary consumes the real directory owner's preparation.
      const handler = createSpawnNewSessionLifecycleActionHandler({
        spawnSession: async (options) => {
          const prepared = await directories.prepareForSpawn(options);
          return prepared.ok
            ? { type: 'success', sessionId: 'managed-session' }
            : { type: 'error', errorCode: prepared.errorCode, errorMessage: 'Managed folder missing' };
        },
      });
      for (const approvedNewDirectoryCreation of [undefined, false]) {
        await expect(handler({
          type: 'resume-session',
          sessionId: 'managed-session',
          directory: allocation.directory,
          ...(approvedNewDirectoryCreation === undefined ? {} : { approvedNewDirectoryCreation }),
        })).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING });
        await expect(access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(handler({
        type: 'resume-session',
        sessionId: 'managed-session',
        directory: allocation.directory,
        approvedNewDirectoryCreation: true,
      })).resolves.toEqual({ type: 'success' });
      await expect(access(allocation.directory)).resolves.toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
