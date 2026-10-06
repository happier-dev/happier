import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import {
  deriveSessionCreationTagV1,
  SessionCreationCorrespondenceV1Schema,
} from '@happier-dev/protocol';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import { createSpawnNewSessionLifecycleActionHandler } from './createSpawnNewSessionLifecycleActionHandler';

describe('createSpawnNewSessionLifecycleActionHandler', () => {
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

    await expect(handler({
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
    })).resolves.toEqual({ type: 'success', sessionId: 'session-created' });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionCreationTag,
      sessionCreationCorrespondence,
      profileId: 'profile-shared',
      secretReferenceOverlay,
      initialTitle: 'Atomic initial title',
    }));
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
