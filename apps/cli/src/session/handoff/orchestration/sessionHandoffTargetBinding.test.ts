import { describe, expect, it } from 'vitest';

import { buildSessionHandoffTargetMetadata } from './sessionHandoffTargetBinding';

describe('buildSessionHandoffTargetMetadata', () => {
  it('moves the canonical session binding and preserves handoff reconciliation metadata', () => {
    const metadata = buildSessionHandoffTargetMetadata({
      metadata: {
        machineId: 'source-machine',
        path: '/source/workspace',
        flavor: 'claude',
        claudeSessionId: 'source-resume',
        codexSessionId: 'stale-other-provider-resume',
      },
      request: {
        sessionId: 'session-1',
        sourceMachineId: 'source-machine',
        targetMachineId: 'target-machine',
        sessionStorageMode: 'persisted',
        targetSessionStorageMode: 'direct',
      },
      started: {
        handoffId: 'handoff-1',
        status: {
          handoffId: 'handoff-1',
          status: 'ready_for_cutover',
          phase: 'staging_target',
          transportStrategy: 'server_routed_stream',
          recoveryActions: [],
        },
        endpointCandidates: [],
        targetPath: '/source/workspace',
        handoffMetadataV2: { workspaceReplicationSourceRootPath: '/source/workspace' },
      },
      prepared: {
        handoffId: 'handoff-1',
        status: { handoffId: 'handoff-1', status: 'ready_for_cutover', phase: 'staging_target', recoveryActions: [] },
        remoteSessionId: 'target-resume',
        directSource: { kind: 'claudeConfig', configDir: '/target/.claude' },
        resume: {
          directory: '/target/workspace',
          agent: 'claude',
          resume: 'target-resume',
          transcriptStorage: 'direct',
          approvedNewDirectoryCreation: true,
        },
      },
      completedAtMs: 123,
    });

    expect(metadata).toMatchObject({
      machineId: 'target-machine',
      path: '/target/workspace',
      claudeSessionId: 'target-resume',
      directSessionV1: {
        machineId: 'target-machine',
        remoteSessionId: 'target-resume',
      },
      handoffV1: {
        sourceMachineId: 'source-machine',
        targetMachineId: 'target-machine',
        sourceWorkspaceRootPath: '/source/workspace',
        targetWorkspaceRootPath: '/target/workspace',
      },
    });
    expect(metadata).not.toHaveProperty('codexSessionId');
    expect(metadata).not.toHaveProperty('externalHistoryImportV1');
  });
});
