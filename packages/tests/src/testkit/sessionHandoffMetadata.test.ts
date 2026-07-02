import { describe, expect, it } from 'vitest';

import {
  buildPatchedSessionHandoffMetadata,
  resolveSessionHandoffBackTargetRootPath,
} from './sessionHandoffMetadata';

describe('buildPatchedSessionHandoffMetadata', () => {
  it('refreshes the Claude handoff metadata contract for a direct session rebinding', () => {
    const updated = buildPatchedSessionHandoffMetadata(
      {
        flavor: 'claude',
        path: '/Users/source/workspace',
        host: 'source-host',
        machineId: 'machine_source',
        claudeSessionId: 'claude_old',
        claudeTranscriptPath: '/Users/source/.claude/projects/proj-old/claude_old.jsonl',
        claudeLastCheckpointId: 'checkpoint_old',
        claudeLastAssistantUuid: 'assistant_old',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'machine_source',
          remoteSessionId: 'claude_old',
          source: {
            kind: 'claudeConfig',
            configDir: '/Users/source/.claude',
            projectId: 'proj-old',
          },
          linkedAtMs: 1,
        },
        externalHistoryImportV1: {
          v: 1,
          providerId: 'claude',
          remoteSessionId: 'old_remote',
          importedAtMs: 1,
          source: {
            kind: 'claudeConfig',
            configDir: '/Users/source/.claude',
            projectId: 'proj-old',
          },
        },
      },
      {
        providerId: 'claude',
        targetMachineId: 'machine_target',
        targetWorkspaceRootPath: '/Users/target/workspace',
        sessionStorageAfter: 'direct',
        completedAtMs: 1234,
      },
    );

    expect(updated).toEqual(expect.objectContaining({
      flavor: 'claude',
      machineId: 'machine_target',
      path: '/Users/target/workspace',
      claudeSessionId: 'claude_old',
      directSessionV1: expect.objectContaining({
        providerId: 'claude',
        machineId: 'machine_target',
        remoteSessionId: 'claude_old',
        linkedAtMs: 1234,
      }),
    }));
    expect(updated.claudeTranscriptPath).toBeUndefined();
    expect(updated.claudeLastCheckpointId).toBeUndefined();
    expect(updated.claudeLastAssistantUuid).toBeUndefined();
    expect(updated.externalHistoryImportV1).toBeUndefined();
  });

  it('preserves the server-routed handoff-back root path through a direct-session rebinding round trip', () => {
    const patched = buildPatchedSessionHandoffMetadata(
      {
        flavor: 'claude',
        path: '/Users/source/workspace',
        machineId: 'machine_source',
        claudeSessionId: 'claude_old',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'machine_source',
          remoteSessionId: 'claude_old',
          source: {
            kind: 'claudeConfig',
            configDir: '/Users/source/.claude',
            projectId: 'proj-old',
          },
          linkedAtMs: 1,
        },
        handoffV1: {
          v: 1,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          providerId: 'claude',
          sessionStorageBefore: 'direct',
          sessionStorageAfter: 'direct',
          transportStrategy: 'server_routed_stream',
          completedAtMs: 1,
          sourceWorkspaceRootPath: '/Users/source/workspace',
          targetWorkspaceRootPath: '/Users/source/workspace',
        },
        workspaceReplicationSourceRootPath: '/Users/source/workspace',
        workspaceReplicationHandoffBackTargetRootPath: '/Users/source/workspace',
      },
      {
        providerId: 'claude',
        targetMachineId: 'machine_target',
        targetWorkspaceRootPath: '/Users/target/workspace',
        sessionStorageAfter: 'direct',
        completedAtMs: 1234,
      },
    );

    expect(patched.workspaceReplicationHandoffBackTargetRootPath).toBe('/Users/source/workspace');
    expect(resolveSessionHandoffBackTargetRootPath({
      metadata: patched,
      requestedTargetMachineId: 'machine_source',
    })).toBe('/Users/source/workspace');
  });

  it('canonicalizes nested legacy direct-session runtime descriptors onto runtimeDescriptorV1', () => {
    const patched = buildPatchedSessionHandoffMetadata(
      {
        flavor: 'codex',
        path: '/Users/source/workspace',
        machineId: 'machine_source',
        codexSessionId: 'thread_old',
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine_source',
          remoteSessionId: 'thread_old',
          source: {
            kind: 'codexHome',
            home: 'user',
          },
          linkedAtMs: 1,
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              providerSessionId: 'thread_old',
            },
          },
        },
      },
      {
        providerId: 'codex',
        targetMachineId: 'machine_target',
        targetWorkspaceRootPath: '/Users/target/workspace',
        sessionStorageAfter: 'direct',
        completedAtMs: 1234,
      },
    );

    expect(patched.directSessionV1).toEqual(expect.objectContaining({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread_old',
        },
      },
    }));
    expect(patched.directSessionV1).not.toHaveProperty('agentRuntimeDescriptorV1');
  });
});

describe('resolveSessionHandoffBackTargetRootPath', () => {
  it('prefers the explicit workspace replication handoff-back root path when valid', () => {
    expect(resolveSessionHandoffBackTargetRootPath({
      metadata: {
        workspaceReplicationHandoffBackTargetRootPath: '/Users/source/workspace',
        handoffV1: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRootPath: '/Users/source/legacy',
        },
      },
      requestedTargetMachineId: 'machine_source',
    })).toBe('/Users/source/workspace');
  });

  it('falls back to the prior source workspace root when the requested target machine matches the prior source machine', () => {
    expect(resolveSessionHandoffBackTargetRootPath({
      metadata: {
        handoffV1: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRootPath: '/Users/source/workspace',
        },
      },
      requestedTargetMachineId: 'machine_source',
    })).toBe('/Users/source/workspace');
  });

  it('fails closed when the explicit or fallback workspace roots are invalid or target the wrong machine', () => {
    expect(resolveSessionHandoffBackTargetRootPath({
      metadata: {
        workspaceReplicationHandoffBackTargetRootPath: '../relative-path',
        handoffV1: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRootPath: '/Users/source/workspace',
        },
      },
      requestedTargetMachineId: 'machine_other',
    })).toBeNull();

    expect(resolveSessionHandoffBackTargetRootPath({
      metadata: {
        workspaceReplicationHandoffBackTargetRootPath: '/Users/source/../workspace',
        handoffV1: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRootPath: '/Users/source/../workspace',
        },
      },
      requestedTargetMachineId: 'machine_source',
    })).toBeNull();
  });
});
