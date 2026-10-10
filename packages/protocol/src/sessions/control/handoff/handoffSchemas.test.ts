import { describe, expect, it } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from './workspaceSyncSchemas.js';
import { SessionHandoffPrepareTargetRequestSchema, SessionHandoffStartRequestSchema } from './handoffSchemas.js';

const gitWorktreePolicyDigest = computeWorkspaceSyncPolicyDigest({
  v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [],
});

async function loadHandoffModule() {
  return await import(new URL('./handoffRpc.js', import.meta.url).href).catch((error) => ({ error } as const));
}

describe('session handoff schemas', () => {
  it('negotiates existing state only through the V3 epoch and explicit true flags', async () => {
    const mod = await loadHandoffModule();
    expect(mod).toHaveProperty('SessionHandoffCapabilityV3Schema');
    if ('error' in mod) return;
    const capability = { protocolVersion: 3, atomicTargetResume: true, targetCleanup: true, sameMachineHandoff: true, existingState: true };
    expect(mod.SessionHandoffCapabilityV3Schema.parse(capability)).toEqual(capability);
    // Current ../0.2 e087d15a2f0cce1de6de8ef0895d9c8bcc035056 handoffSchemas.ts
    // advertises the same copy policy through protocolVersion:2, not the V3 owner.
    expect(mod.SessionHandoffCapabilityV3Schema.safeParse({ ...capability, protocolVersion: 2 }).success).toBe(false);
    for (const existingState of [undefined, false, 'true', 1, null]) {
      expect(mod.SessionHandoffCapabilityV3Schema.parse({ ...capability, existingState }).existingState).toBe(false);
    }
    expect(mod.SessionHandoffCapabilityV3Schema.parse({ ...capability, extraPresentation: true })).not.toHaveProperty('extraPresentation');
  });

  it('admits existing state only with exact target identity and no transfer work', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;
    const start = {
      sessionId: 'session_1', sourceMachineId: 'source', targetMachineId: 'target',
      sessionStorageMode: 'persisted', preferredTransportStrategies: ['direct_peer'],
      stateTransfer: 'existing', workspaceAction: { kind: 'none' },
    };
    const prepare = {
      handoffId: 'handoff_1', sessionId: 'session_1', sourceMachineId: 'source', targetMachineId: 'target',
      sourceSessionStorageMode: 'persisted', negotiatedTransportStrategy: 'direct_peer', targetPath: '/repo',
      stateTransfer: 'existing', workspaceAction: { kind: 'none' },
    };
    expect(mod.SessionHandoffStartRequestSchema.parse(start)).toMatchObject({ stateTransfer: 'existing' });
    expect(mod.SessionHandoffPrepareTargetRequestSchema.parse(prepare)).toMatchObject({ sessionId: 'session_1', stateTransfer: 'existing' });
    for (const [schema, request] of [[mod.SessionHandoffStartRequestSchema, start], [mod.SessionHandoffPrepareTargetRequestSchema, prepare]] as const) {
      expect(schema.safeParse({ ...request, stateTransfer: 'unknown' }).success).toBe(false);
      expect(schema.safeParse({ ...request, workspaceAction: { kind: 'copy_once', contentPolicy: {
        v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [], policyDigest: gitWorktreePolicyDigest,
      } } }).success).toBe(false);
    }
    expect(mod.SessionHandoffPrepareTargetRequestSchema.safeParse({ ...prepare, sessionId: undefined }).success).toBe(false);
    for (const publicationKey of ['agentBundleTransferPublication', 'providerBundleTransferPublication', 'workspaceSeedTransferPublication', 'workspaceReplicationManifestTransferPublication']) {
      expect(mod.SessionHandoffPrepareTargetRequestSchema.safeParse({ ...prepare, handoffMetadataV2: {
        [publicationKey]: { transferId: 'bundle', sizeBytes: 1, manifestHash: 'hash' },
      } }).success).toBe(false);
    }
  });

  it('refuses the pinned predecessor workspace carrier instead of silently reinterpreting existing state', () => {
    // Prospective ../0.2 e087d15a2f0cce1de6de8ef0895d9c8bcc035056, current handoffSchemas.ts
    // and its carries-explicit-existing-state fixture, observed dirty Action changes 2026-10-10.
    const predecessor = {
      sessionId: 'session_1', sourceMachineId: 'source', targetMachineId: 'target',
      sessionStorageMode: 'persisted', preferredTransportStrategies: ['direct_peer'],
      stateTransfer: 'existing', workspaceTransfer: { enabled: false, conflictPolicy: 'replace_existing' },
    };
    expect(SessionHandoffStartRequestSchema.safeParse(predecessor).success).toBe(false);
  });

  it('refuses existing state in a newly allocated managed directory before either daemon phase', () => {
    const identity = { operationId: 'operation', sessionId: 'session', sourceMachineId: 'source', targetMachineId: 'target',
      stateTransfer: 'existing', workspaceAction: { kind: 'none' }, targetDirectory: { kind: 'managed' } };
    expect(SessionHandoffStartRequestSchema.safeParse({ ...identity, sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer'] }).success).toBe(false);
    expect(SessionHandoffPrepareTargetRequestSchema.safeParse({ ...identity, handoffId: 'handoff',
      sourceSessionStorageMode: 'persisted', negotiatedTransportStrategy: 'direct_peer', endpointCandidates: [] }).success).toBe(false);
  });

  it('validates read-only existing-state checks and preserves the actionable absence failure', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;
    const request = { sessionId: 'session_1', sourceMachineId: 'source', targetMachineId: 'target', targetPath: '/repo', sourceSessionStorageMode: 'persisted' };
    expect(mod.SessionHandoffExistingStateCheckRequestV3Schema.parse(request)).toEqual(request);
    expect(mod.SessionHandoffExistingStateCheckRequestV3Schema.safeParse({ ...request, stateTransfer: 'transfer' }).success).toBe(false);
    const failure = { ok: false, errorCode: 'existing_session_state_unavailable', error: 'Turn on session data transfer' };
    expect(mod.SessionHandoffExistingStateCheckResponseV3Schema.parse(failure)).toEqual(failure);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.parse(failure)).toEqual(failure);
  });

  it('requires managed target identity while accepting daemon-selected paths', () => {
    const request = {
      handoffId: 'handoff_managed', operationId: 'operation_managed', sessionId: 'session_managed',
      sourceMachineId: 'source', targetMachineId: 'target',
      negotiatedTransportStrategy: 'server_routed_stream', sourceSessionStorageMode: 'persisted',
      targetDirectory: { kind: 'managed' }, endpointCandidates: [],
    };
    expect(SessionHandoffPrepareTargetRequestSchema.safeParse(request).success).toBe(true);
    expect(SessionHandoffPrepareTargetRequestSchema.safeParse({ ...request, sessionId: undefined }).success).toBe(false);
    expect(SessionHandoffPrepareTargetRequestSchema.safeParse({ ...request, operationId: undefined }).success).toBe(false);
    expect(SessionHandoffStartRequestSchema.safeParse({ ...request, sessionStorageMode: 'persisted', preferredTransportStrategies: ['server_routed_stream'] }).success).toBe(true);
    expect(SessionHandoffStartRequestSchema.safeParse({ ...request, operationId: undefined, sessionStorageMode: 'persisted', preferredTransportStrategies: ['server_routed_stream'] }).success).toBe(false);
  });
  it('preserves every advertised endpoint in current and predecessor handoffs', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    // The prospective 0.2 source advertised 21 addresses on a multi-interface Mac.
    const endpointCandidates = Array.from({ length: 21 }, (_, index) => ({
      kind: 'http' as const,
      url: `http://10.0.0.${index + 1}:46001/machine-transfers/direct/bundle`,
      authorizationToken: 'test-token',
      expiresAt: 1,
    }));
    const publication = {
      transferId: 'agent-bundle', sizeBytes: 1, manifestHash: 'manifest-hash', endpointCandidates,
    };
    const response = {
      handoffId: 'handoff_1',
      status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing' },
      targetPath: '/repo',
      endpointCandidates,
      handoffMetadataV2: { agentBundleTransferPublication: publication },
    };
    const started = mod.SessionHandoffStartResponseSchema.parse(response);
    const predecessor = mod.SessionHandoffStartResponseSchema.parse({
      ...response,
      handoffMetadataV2: { providerBundleTransferPublication: publication },
    });
    expect(predecessor).toEqual(started);
    const prepared = mod.SessionHandoffPrepareTargetRequestSchema.parse({
      handoffId: started.handoffId,
      sourceMachineId: 'source', targetMachineId: 'target',
      negotiatedTransportStrategy: 'direct_peer', sourceSessionStorageMode: 'persisted',
      targetPath: '/target',
      endpointCandidates: started.endpointCandidates,
      handoffMetadataV2: started.handoffMetadataV2,
    });
    expect(prepared.endpointCandidates).toEqual(endpointCandidates);
    expect(prepared.handoffMetadataV2?.agentBundleTransferPublication).toEqual(publication);
    expect(mod.SessionHandoffStartResponseSchema.safeParse({
      ...response,
      endpointCandidates: [...endpointCandidates, { ...endpointCandidates[0], url: 'invalid' }],
    }).success).toBe(false);
  });

  it('binds a workspace handoff repository root to its session-relative cwd', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;
    const request = {
      handoffId: 'handoff_nested_git',
      sourceMachineId: 'source',
      targetMachineId: 'target',
      negotiatedTransportStrategy: 'direct_peer' as const,
      sourceSessionStorageMode: 'persisted' as const,
      targetPath: '/target/repo/packages/app',
      workspaceRootPath: '/target/repo',
      workspaceSessionRelativeCwd: 'packages/app',
      endpointCandidates: [],
    };
    expect(mod.SessionHandoffPrepareTargetRequestSchema.parse(request)).toEqual(request);
    expect(mod.SessionHandoffPrepareTargetRequestSchema.safeParse({
      ...request,
      workspaceSessionRelativeCwd: undefined,
    }).success).toBe(false);
  });

  it('accepts a bounded installed Agent identity in a target resume plan', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(mod.SessionHandoffPrepareTargetResponseSchema.safeParse({
      handoffId: 'handoff_external_agent',
      status: {
        handoffId: 'handoff_external_agent',
        status: 'ready_for_cutover',
        phase: 'staging_target',
        recoveryActions: [],
      },
      remoteSessionId: 'external_remote_session',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'acme.agent',
        agent: {
          providerSessionId: 'external_vendor_session',
        },
      },
      resume: {
        directory: '/repo',
        agent: 'acme.agent',
        resume: 'external_vendor_session',
        transcriptStorage: 'persisted',
        approvedNewDirectoryCreation: true,
      },
    }).success).toBe(true);
  });

  it('bounds typed native-import failures without changing the leaf import request', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    const status = {
      handoffId: 'handoff-import-conflict',
      jobId: 'prepare_handoff-import-conflict',
      status: 'reconciliation_required',
      phase: 'staging_target',
      recoveryActions: [],
      failure: {
        code: 'target_identity_conflict',
        message: 'The native target differs from the exported session.',
      },
    } as const;
    expect(mod.SessionHandoffStatusSchema.parse(status)).toEqual(status);
    expect(mod.SessionHandoffStatusSchema.safeParse({
      ...status,
      failure: {
        code: 'agent_version_unsupported',
        message: 'x'.repeat(2_001),
      },
    }).success).toBe(false);
    expect(mod.SessionHandoffStatusSchema.safeParse({
      ...status,
      failure: {
        code: 'target_import_failed',
      },
    }).success).toBe(false);

    const requestShape = mod.SessionHandoffPrepareTargetRequestSchema.parse({
      handoffId: 'handoff-import-conflict',
      sourceMachineId: 'source',
      targetMachineId: 'target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'direct',
      targetPath: '/repo',
      endpointCandidates: [],
    });
    expect(requestShape).not.toHaveProperty('attemptId');
  });

  it('types prepare-target result-get as the existing success response or a bounded handler failure', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    const conflict = {
      ok: false,
      errorCode: 'target_identity_conflict',
      error: 'The native handoff target conflicts with the exported session identity',
    } as const;
    const unsupported = {
      ok: false,
      errorCode: 'agent_version_unsupported',
      error: 'The installed Agent version cannot safely import this handoff',
    } as const;
    const notFound = {
      ok: false,
      errorCode: 'not_found',
    } as const;
    const awaitingRecovery = {
      ok: false,
      errorCode: 'awaiting_recovery',
      error: 'Prepare-target job is awaiting_recovery',
    } as const;

    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.parse(conflict)).toEqual(conflict);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.parse(unsupported)).toEqual(unsupported);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.parse(notFound)).toEqual(notFound);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.parse(awaitingRecovery)).toEqual(awaitingRecovery);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse({
      ...notFound,
      error: 'not_found does not carry terminal detail',
    }).success).toBe(false);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse({
      ok: false,
      errorCode: 'awaiting_recovery',
    }).success).toBe(false);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse({
      ...conflict,
      errorCode: 'target_import_failed',
    }).success).toBe(false);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse({
      ...conflict,
      error: 'x'.repeat(2_001),
    }).success).toBe(false);
  });

  it('keeps interrupted prepare-target Resume revision-bound and exact', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;
    const input = {
      handoffId: 'handoff-1',
      jobId: 'prepare_handoff-1',
      expectedRevision: 7,
      attemptId: 'resume-attempt-1',
    };

    expect(mod.SessionHandoffPrepareTargetResumeRequestSchema.parse(input)).toEqual(input);
    expect(mod.SessionHandoffPrepareTargetResumeRequestSchema.safeParse({
      ...input,
      sessionId: 'must-not-be-client-authority',
    }).success).toBe(false);
    expect(mod.SessionHandoffPrepareTargetResumeRequestSchema.safeParse({
      ...input,
      expectedRevision: -1,
    }).success).toBe(false);
    expect(mod.SessionHandoffPrepareTargetResumeRequestSchema.safeParse({
      ...input,
      jobId: '../prepare_handoff-1',
    }).success).toBe(false);
    expect(mod.SessionHandoffPrepareTargetResumeResponseSchema.parse({
      ok: true,
      handoffId: input.handoffId,
      jobId: input.jobId,
      transitionRevision: 8,
      status: {
        handoffId: input.handoffId,
        jobId: input.jobId,
        status: 'pending',
        phase: 'staging_target',
        recoveryActions: [],
      },
    })).toMatchObject({ ok: true, transitionRevision: 8 });
    expect(mod.SessionHandoffPrepareTargetResumeResponseSchema.parse({
      ok: false,
      error: {
        code: 'stale_revision',
        message: 'The handoff changed.',
      },
    })).toEqual({
      ok: false,
      error: {
        code: 'stale_revision',
        message: 'The handoff changed.',
      },
    });
  });

  it('preserves additive fields on prepare-target and status payloads', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    const request = mod.SessionHandoffPrepareTargetRequestSchema.parse({
      handoffId: 'handoff_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      allowServerRoutedFallback: true,
      sourceSessionStorageMode: 'persisted',
      targetSessionStorageMode: 'direct',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_1',
          authorizationToken: 'test-token',
          expiresAt: 1,
          futureEndpointField: 'keep-me',
        },
      ],
      handoffMetadataV2: {
        agentBundleTransferPublication: {
          transferId: 'session-handoff:handoff_1:provider-bundle-file',
          sizeBytes: 12,
          manifestHash: 'sha256:manifest-hash',
          endpointCandidates: [
            {
              kind: 'http',
              url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_1',
              authorizationToken: 'test-token',
              expiresAt: 1,
              futureEndpointField: 'keep-me',
            },
          ],
          futurePublicationField: 'keep-me',
        },
        futureHandoffMetadataField: 'keep-me',
      },
      workspaceAction: {
        kind: 'copy_once',
        contentPolicy: {
          v: 1,
          selection: 'git_worktree',
          extraIgnorePatterns: [],
          extraIncludePatterns: [],
          policyDigest: gitWorktreePolicyDigest,
        },
      },
      futurePrepareTargetField: 'keep-me',
    });

    expect((request as any).futurePrepareTargetField).toBe('keep-me');
    expect((request.handoffMetadataV2 as any).futureHandoffMetadataField).toBe('keep-me');
    expect((request.endpointCandidates[0] as any).futureEndpointField).toBe('keep-me');
    expect((request.handoffMetadataV2?.agentBundleTransferPublication as any).futurePublicationField).toBe('keep-me');
    expect((request.handoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates?.[0] as any).futureEndpointField).toBe('keep-me');

    const status = mod.SessionHandoffStatusSchema.parse({
      handoffId: 'handoff_1',
      status: 'ready_for_cutover',
      phase: 'staging_target',
      jobId: 'job_1',
      workspaceReplicationJobId: 'workspace-replication-job-1',
      progress: {
        updatedAtMs: 123,
        checkpoint: 'transfer_blobs',
        planned: {
          totalFiles: 12,
          totalBytes: 34,
          added: 1,
          changed: 2,
          removed: 3,
          futurePlannedField: 'keep-me',
        },
        transferred: {
          files: 4,
          bytes: 5,
          blobs: 6,
          futureTransferredField: 'keep-me',
        },
        applied: {
          files: 2,
          bytes: 3,
          futureCountsField: 'keep-me',
        },
        remaining: {
          files: 8,
          bytes: 29,
          futureCountsField: 'keep-me',
        },
        current: {
          relativePath: 'src/index.ts',
          digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          phaseDetail: 'blob-pack-0',
          futureCurrentField: 'keep-me',
        },
        resumable: true,
        warnings: ['blocking_divergence_detected'],
        futureProgressField: 'keep-me',
      },
      workspacePreflightSummary: {
        addedPathsCount: 1,
        changedPathsCount: 2,
        removedPathsCount: 3,
        totalBytes: 34,
        futureSummaryField: 'keep-me',
      },
      transportStrategy: 'direct_peer',
      recoveryActions: [],
      futureStatusField: 'keep-me',
    });

    expect((status as any).futureStatusField).toBe('keep-me');
    expect((status.progress as any).futureProgressField).toBe('keep-me');
    expect((status.progress?.planned as any).futurePlannedField).toBe('keep-me');
    expect((status.progress?.transferred as any).futureTransferredField).toBe('keep-me');
    expect((status.progress?.applied as any).futureCountsField).toBe('keep-me');
    expect((status.progress?.remaining as any).futureCountsField).toBe('keep-me');
    expect((status.progress?.current as any).futureCurrentField).toBe('keep-me');
    expect((status.workspacePreflightSummary as any).futureSummaryField).toBe('keep-me');

    const response = mod.SessionHandoffPrepareTargetResultGetResponseSchema.parse({
      handoffId: 'handoff_1',
      status: {
        handoffId: 'handoff_1',
        status: 'ready_for_cutover',
        phase: 'staging_target',
        workspaceReplicationJobId: 'workspace-replication-job-1',
        recoveryActions: [],
        futureStatusField: 'keep-me',
      },
      remoteSessionId: 'remote_session_1',
      directSource: {
        kind: 'claudeConfig',
        configDir: '/tmp/claude',
        futureDirectSourceField: 'keep-me',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'pi',
        agent: {
          resumeStrategy: 'sessionFileBySessionId',
        },
        futureRuntimeDescriptorField: 'keep-me',
      },
      resume: {
        directory: '/repo',
        agent: 'claude',
        resume: 'resume-token',
        transcriptStorage: 'persisted',
        approvedNewDirectoryCreation: true,
        futureResumeField: 'keep-me',
      },
      workspaceReplicationJobId: 'workspace-replication-job-1',
      futurePrepareTargetResultField: 'keep-me',
    });

    expect((response as any).futurePrepareTargetResultField).toBe('keep-me');
    expect((response.status as any).futureStatusField).toBe('keep-me');
    expect((response.directSource as any).futureDirectSourceField).toBe('keep-me');
    expect((response.runtimeDescriptorV1 as any).futureRuntimeDescriptorField).toBe('keep-me');
    expect((response.resume as any).futureResumeField).toBe('keep-me');
  }, 30_000);

  it('exports the handoff schema surface', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(typeof mod.SessionHandoffStartRequestSchema).toBe('object');
    expect(typeof mod.SessionHandoffPrepareTargetRequestSchema).toBe('object');
    expect(typeof mod.SessionHandoffPrepareTargetResultGetRequestSchema).toBe('object');
    expect(typeof mod.SessionHandoffPrepareTargetResultGetResponseSchema).toBe('object');
    expect(typeof mod.SessionHandoffStatusSchema).toBe('object');
    expect(typeof mod.SessionHandoffProgressCheckpointSchema).toBe('object');
    expect(typeof mod.SessionHandoffProgressWarningCodeSchema).toBe('object');
    expect(mod.SESSION_HANDOFF_PROGRESS_TIMELINES_V1).toEqual({
      minimal: [
        'stage_target',
        'import_session',
        'finalize',
      ],
      full: [
        'plan',
        'transfer_blobs',
        'stage_target',
        'apply',
        'import_session',
        'finalize',
      ],
      full_with_source_scan: [
        'scan_source',
        'plan',
        'transfer_blobs',
        'stage_target',
        'apply',
        'import_session',
        'finalize',
      ],
    });
    expect(mod.SESSION_HANDOFF_PROGRESS_FULL_TIMELINE).toEqual([
      'plan',
      'transfer_blobs',
      'stage_target',
      'apply',
      'import_session',
      'finalize',
    ]);
    expect(mod.SESSION_HANDOFF_PROGRESS_FULL_TIMELINE_WITH_SOURCE_SCAN).toEqual([
      'scan_source',
      'plan',
      'transfer_blobs',
      'stage_target',
      'apply',
      'import_session',
      'finalize',
    ]);
    expect(typeof mod.resolveSessionHandoffProgressTimeline).toBe('function');
    expect(typeof mod.SessionHandoffMetadataV2Schema).toBe('object');
    expect(typeof mod.TransferEndpointCandidateSchema).toBe('object');
    expect(typeof mod.TransferStreamEnvelopeSchema).toBe('object');

    // The retired workspace transfer/replication corridor is not part of the public handoff surface.
    expect(mod).not.toHaveProperty('SessionHandoffWorkspaceTransferSchema');
    expect(mod).not.toHaveProperty('SessionHandoffWorkspaceTransferStrategySchema');
    expect(mod).not.toHaveProperty('SessionHandoffConflictPolicySchema');

    // Legacy inline transferred-bundles payloads/artifacts are not part of the steady-state V2 protocol surface.
    expect(mod).not.toHaveProperty('SessionHandoffTransferredPayloadSchema');
    expect(mod).not.toHaveProperty('SessionHandoffTransferredWorkspaceArtifactsSchema');
  }, 30_000);

  it('validates start, status, and transfer payloads', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    const startParsed = mod.SessionHandoffStartRequestSchema.safeParse({
      sessionId: 'sess_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      workspaceAction: {
        kind: 'copy_once',
        contentPolicy: {
          v: 1,
          selection: 'git_worktree',
          extraIgnorePatterns: [],
          extraIncludePatterns: [],
          policyDigest: gitWorktreePolicyDigest,
        },
      },
    });
    expect(startParsed.success).toBe(true);
    if (!startParsed.success) return;
    expect(startParsed.data.workspaceAction).toEqual({
      kind: 'copy_once',
      contentPolicy: {
        v: 1,
        selection: 'git_worktree',
        extraIgnorePatterns: [],
        extraIncludePatterns: [],
        policyDigest: gitWorktreePolicyDigest,
      },
    });

        expect(
      mod.SessionHandoffStatusSchema.safeParse({
        handoffId: 'handoff_1',
        status: 'pending',
        phase: 'preparing',
        jobId: 'job_1',
        progress: {
          updatedAtMs: 123,
          checkpoint: 'transfer_blobs',
          planned: {
            totalFiles: 12,
            totalBytes: 34,
            added: 1,
            changed: 2,
            removed: 3,
          },
          transferred: {
            files: 4,
            bytes: 5,
            blobs: 6,
          },
          applied: {
            files: 2,
            bytes: 3,
          },
          remaining: {
            files: 8,
            bytes: 29,
          },
          current: {
            relativePath: 'src/index.ts',
            digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            phaseDetail: 'blob-pack-0',
          },
          resumable: true,
          warnings: ['blocking_divergence_detected'],
        },
        workspacePreflightSummary: {
          addedPathsCount: 1,
          changedPathsCount: 2,
          removedPathsCount: 3,
          totalBytes: 34,
        },
        recoveryActions: [],
      }).success,
    ).toBe(true);

    // Retired workspace replication strategies are not admitted as handoff transport strategies.
    expect(
      mod.SessionHandoffStatusSchema.safeParse({
        handoffId: 'handoff_2',
        status: 'ready_for_cutover',
        phase: 'staging_target',
        transportStrategy: 'transfer_snapshot',
        recoveryActions: [],
      }).success,
    ).toBe(false);

    // The retired reverse-root handoff-back commit fields are not part of the current commit request.
    expect(
      mod.SessionHandoffCommitRequestSchema.safeParse({
        handoffId: 'handoff_2',
        mode: 'source_cleanup',
        workspaceReplicationReverseSourceRootPath: '/repo/source',
        workspaceReplicationReverseTargetRootPath: '/repo/target',
      }).success,
    ).toBe(false);

    expect(mod.resolveSessionHandoffProgressTimeline('scan_source')).toEqual([
      'scan_source',
      'plan',
      'transfer_blobs',
      'stage_target',
      'apply',
      'import_session',
      'finalize',
    ]);
    expect(mod.resolveSessionHandoffProgressTimeline('plan')).toEqual([
      'plan',
      'transfer_blobs',
      'stage_target',
      'apply',
      'import_session',
      'finalize',
    ]);
    expect(mod.resolveSessionHandoffProgressTimeline('import_session')).toEqual([
      'stage_target',
      'import_session',
      'finalize',
    ]);
    expect(mod.resolveSessionHandoffProgressTimeline('finalize')).toEqual([
      'plan',
      'transfer_blobs',
      'stage_target',
      'apply',
      'import_session',
      'finalize',
    ]);

    const handoffMetadataV2 = {
      agentBundleTransferPublication: {
        transferId: 'session-handoff:handoff_1:provider-bundle-file',
        sizeBytes: 12,
        manifestHash: 'sha256:manifest-hash',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_1',
            authorizationToken: 'test-token',
            expiresAt: 1,
          },
        ],
      },
    };
    expect(mod.SessionHandoffMetadataV2Schema.safeParse(handoffMetadataV2).success).toBe(true);

    expect(
      mod.SessionHandoffStartResponseSchema.safeParse({
        handoffId: 'handoff_1',
        status: {
          handoffId: 'handoff_1',
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
        endpointCandidates: [],
        targetPath: '/repo',
        handoffMetadataV2,
      }).success,
    ).toBe(true);

    const terminalStatus = {
      handoffId: 'handoff_1',
      status: 'completed' as const,
      phase: 'finalizing' as const,
      recoveryActions: [],
    };
    expect(mod.SessionHandoffActionResultV1Schema.parse({
      handoffId: 'handoff_1',
      status: terminalStatus,
      workspace: {
        kind: 'relationship',
        relationshipId: 'relationship_1',
        created: true,
      },
      warning: { code: 'source_cleanup_failed', message: 'Source cleanup needs attention.' },
    })).toEqual({
      handoffId: 'handoff_1',
      status: terminalStatus,
      workspace: {
        kind: 'relationship',
        relationshipId: 'relationship_1',
        created: true,
      },
      warning: { code: 'source_cleanup_failed', message: 'Source cleanup needs attention.' },
    });
    expect(mod.SessionHandoffActionResultV1Schema.safeParse({
      handoffId: 'handoff_1',
      status: terminalStatus,
      workspace: { kind: 'create_relationship', relationshipId: 'relationship_1' },
    }).success).toBe(false);
    expect(mod.SessionHandoffActionResultV1Schema.safeParse({
      handoffId: 'handoff_1',
      status: terminalStatus,
      unexpected: true,
    }).success).toBe(false);
    expect(mod.SessionHandoffActionResultV1Schema.safeParse({
      handoffId: 'handoff_1',
      status: terminalStatus,
    }).success).toBe(false);

    expect(
      mod.SessionHandoffPrepareTargetRequestSchema.safeParse({
        handoffId: 'handoff_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
	        endpointCandidates: [
	          {
	            kind: 'http',
	            url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_1',
	            authorizationToken: 'test-token',
	            expiresAt: 1,
	          },
	        ],
	        handoffMetadataV2,
      }).success,
    ).toBe(true);

    expect(
      mod.SessionHandoffPrepareTargetResultGetRequestSchema.safeParse({
        handoffId: 'handoff_1',
      }).success,
    ).toBe(true);

    expect(
      mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse({
        handoffId: 'handoff_1',
        status: {
          handoffId: 'handoff_1',
          status: 'ready_for_cutover',
          phase: 'staging_target',
          workspaceReplicationJobId: 'workspace-replication-job-1',
          recoveryActions: [],
        },
        remoteSessionId: 'remote_session_1',
        directSource: {
          kind: 'claudeConfig',
          configDir: '/tmp/claude',
        },
        resume: {
          directory: '/repo',
          agent: 'claude',
          resume: 'resume-token',
          transcriptStorage: 'persisted',
          approvedNewDirectoryCreation: true,
        },
      }).success,
    ).toBe(true);

    expect(
      mod.SessionHandoffPrepareTargetResponseSchema.safeParse({
        handoffId: 'handoff_1',
        status: {
          handoffId: 'handoff_1',
          status: 'ready_for_cutover',
          phase: 'staging_target',
          recoveryActions: [],
        },
        remoteSessionId: 'remote_session_1',
        directSource: {
          kind: 'claudeConfig',
          configDir: '/tmp/claude',
        },
        resume: {
          directory: '/repo',
          agent: 'claude',
          resume: 'resume-token',
          transcriptStorage: 'persisted',
          approvedNewDirectoryCreation: true,
        },
        workspaceReplicationJobId: 'workspace-replication-job-1',
      }).success,
    ).toBe(true);

    expect(
      mod.TransferStreamEnvelopeSchema.safeParse({
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: 'aGVsbG8=',
      }).success,
    ).toBe(true);

    // Open envelopes must always include the recipient public key so the responder can encrypt
    // chunks without relying on undeployed legacy behavior.
    expect(
      mod.TransferStreamEnvelopeSchema.safeParse({
        transferId: 'transfer_1',
        kind: 'open',
        manifestHash: 'sha256:test',
      }).success,
    ).toBe(false);
    expect(
      mod.TransferStreamEnvelopeSchema.safeParse({
        transferId: 'transfer_1',
        kind: 'open',
        manifestHash: 'sha256:test',
        recipientPublicKeyBase64: 'aGVsbG8=',
      }).success,
    ).toBe(true);

    expect(
      mod.SessionHandoffStartRequestSchema.safeParse({
        sessionId: 'sess_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'create_sibling_copy',
        },
      }).success,
    ).toBe(false);

    const tooLongMachineId = 'a'.repeat(300);
    expect(
      mod.MachineTransferReceiveEnvelopeSchema.safeParse({
        sourceMachineId: tooLongMachineId,
        targetMachineId: 'machine_target',
        envelope: {
          transferId: 'transfer_1',
          kind: 'ack',
          nextSequence: 0,
        },
      }).success,
    ).toBe(false);
  }, 30_000);

  it('rejects oversized handoff status fields (bounded progress payload)', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.SessionHandoffStatusSchema.safeParse({
        handoffId: 'handoff_1',
        status: 'pending',
        phase: 'preparing',
        progress: {
          updatedAtMs: 123,
          checkpoint: 'transfer_blobs',
          planned: {},
          transferred: {},
          current: {
            relativePath: 'x'.repeat(10_000),
          },
          resumable: true,
        },
        recoveryActions: [],
      }).success,
    ).toBe(false);

    expect(
      mod.SessionHandoffStatusSchema.safeParse({
        handoffId: 'handoff_1',
        status: 'pending',
        phase: 'preparing',
        progress: {
          updatedAtMs: 123,
          checkpoint: 'transfer_blobs',
          planned: {},
          transferred: {},
          resumable: true,
          warnings: Array.from({ length: 200 }, () => 'blocking_divergence_detected'),
        },
        recoveryActions: [],
      }).success,
    ).toBe(false);
  });

  it('normalizes the prospective predecessor bundle publication without admitting conflicting owners', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    const publication = {
      transferId: 'session-handoff:handoff_predecessor_1:provider-bundle',
      sizeBytes: 123,
      manifestHash: 'sha256:predecessor-manifest',
      futurePublicationField: {
        alpha: 1,
        beta: 2,
      },
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/predecessor-bundle',
          authorizationToken: 'predecessor-token',
          expiresAt: 123_456,
        },
      ],
    } as const;

    const predecessorOnly = mod.SessionHandoffMetadataV2Schema.parse({
      providerBundleTransferPublication: publication,
      futureHandoffMetadataField: 'keep-me',
    });
    expect(predecessorOnly).toEqual({
      agentBundleTransferPublication: publication,
      futureHandoffMetadataField: 'keep-me',
    });

    const canonicalOnly = mod.SessionHandoffMetadataV2Schema.parse({
      agentBundleTransferPublication: publication,
    });
    expect(canonicalOnly).toEqual({
      agentBundleTransferPublication: publication,
    });

    const equalDual = mod.SessionHandoffMetadataV2Schema.parse({
      providerBundleTransferPublication: {
        manifestHash: publication.manifestHash,
        sizeBytes: publication.sizeBytes,
        transferId: publication.transferId,
        futurePublicationField: {
          beta: 2,
          alpha: 1,
        },
        endpointCandidates: publication.endpointCandidates,
      },
      agentBundleTransferPublication: publication,
    });
    expect(equalDual).toEqual(canonicalOnly);

    expect(mod.SessionHandoffMetadataV2Schema.safeParse({
      providerBundleTransferPublication: publication,
      agentBundleTransferPublication: {
        ...publication,
        transferId: 'session-handoff:handoff_predecessor_1:conflicting-agent-bundle',
      },
    }).success).toBe(false);
  });

  it('accepts absolute transfer endpoint URLs with matching schemes', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

	    expect(
	      mod.TransferEndpointCandidateSchema.safeParse({
	        kind: 'http',
	        url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_1',
	        authorizationToken: 'token',
	        expiresAt: 1,
	      }).success,
	    ).toBe(true);

	    expect(
	      mod.TransferEndpointCandidateSchema.safeParse({
	        kind: 'https',
	        url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_1',
	        expiresAt: 1,
	      }).success,
	    ).toBe(false);
	  });

  it('rejects oversized transfer ids and open payloads', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.TransferStreamEnvelopeSchema.safeParse({
        transferId: 'x'.repeat(10_000),
        kind: 'open',
        manifestHash: 'sha256:test',
        recipientPublicKeyBase64: Buffer.alloc(32, 1).toString('base64'),
      }).success,
    ).toBe(false);

    expect(
      mod.TransferStreamEnvelopeSchema.safeParse({
        transferId: 'transfer_1',
        kind: 'open',
        manifestHash: 'sha256:test',
        recipientPublicKeyBase64: Buffer.alloc(32, 1).toString('base64'),
        openPayloadBase64: 'a'.repeat(2_000_000),
      }).success,
    ).toBe(false);

    expect(
      mod.TransferStreamEnvelopeSchema.safeParse({
        transferId: 'transfer_1',
        kind: 'open',
        manifestHash: 'sha256:test',
        // Invalid base64 (we need stable protocol rejection rather than leaking decode errors later).
        recipientPublicKeyBase64: '*not-base64*',
      }).success,
    ).toBe(false);

  });

  it('rejects legacy inline prepare-target transfer fields', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.SessionHandoffPrepareTargetRequestSchema.safeParse({
        handoffId: 'handoff_legacy',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        workspaceManifestHash: 'sha256:legacy',
        transferredPayload: {
          agentBundle: {
            providerId: 'claude',
            remoteSessionId: 'claude_session_inline',
            transcriptBase64: 'e30K',
          },
        },
        agentBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_inline',
          transcriptBase64: 'e30K',
        },
        workspaceArtifacts: {
          manifest: {
            entries: [],
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects legacy inline start-response transfer fields', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.SessionHandoffStartResponseSchema.safeParse({
        handoffId: 'handoff_legacy',
        status: {
          handoffId: 'handoff_legacy',
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
        endpointCandidates: [],
        targetPath: '/repo',
        transferredPayload: {
          agentBundle: {
            providerId: 'claude',
            remoteSessionId: 'claude_session_inline',
            transcriptBase64: 'e30K',
          },
        },
        agentBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_inline',
          transcriptBase64: 'e30K',
        },
        workspaceArtifacts: {
          manifest: {
            entries: [],
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects legacy experimentalCodexAcp in resume payloads (no undeployed compatibility)', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse({
        handoffId: 'handoff_codex_legacy_resume',
        status: {
          handoffId: 'handoff_codex_legacy_resume',
          status: 'ready_for_cutover',
          phase: 'staging_target',
          recoveryActions: [],
        },
        remoteSessionId: 'codex_session_legacy_resume',
        directSource: {
          kind: 'codexHome',
          home: 'user',
        },
        resume: {
          directory: '/repo',
          agent: 'codex',
          resume: 'codex_session_legacy_resume',
          transcriptStorage: 'persisted',
          approvedNewDirectoryCreation: true,
          experimentalCodexAcp: true,
        },
      }).success,
    ).toBe(false);
  });

  it('accepts bounded Agent identities in resume payloads', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    const buildPayload = (agent: string) => ({
      handoffId: 'handoff_provider_surface',
      status: {
        handoffId: 'handoff_provider_surface',
        status: 'ready_for_cutover',
        phase: 'staging_target',
        recoveryActions: [],
      },
      remoteSessionId: 'remote_session_provider_surface',
      directSource: {
        kind: 'ohMyPiAgentDir',
        agentDir: '/tmp/ohmypi',
      },
      resume: {
        directory: '/repo',
        agent,
        resume: 'resume-token',
        transcriptStorage: 'persisted',
        approvedNewDirectoryCreation: true,
      },
    });

    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(buildPayload('pi')).success).toBe(true);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(buildPayload('ohMyPi')).success).toBe(true);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(buildPayload('plugin_backend')).success).toBe(true);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(buildPayload(' plugin_backend')).success).toBe(false);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(buildPayload('')).success).toBe(false);
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(buildPayload('a'.repeat(600))).success).toBe(false);
  });

  it('keeps provider-minted handoff identities byte-exact and refuses a blank one', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    // Bytes an Agent minted. Surrounding whitespace, the embedded newline and
    // the `/`, `+`, `=` punctuation are all part of the identity Happier hands
    // back to its issuer, so the handoff wire must carry them unchanged.
    const providerMintedId = '  provider\nses/AB+cd==  ';
    const buildPayload = (providerSessionId: string) => ({
      handoffId: 'handoff_opaque_identity',
      status: {
        handoffId: 'handoff_opaque_identity',
        status: 'ready_for_cutover',
        phase: 'staging_target',
        recoveryActions: [],
      },
      remoteSessionId: providerSessionId,
      directSource: {
        kind: 'claudeConfig',
        configDir: '/tmp/claude',
      },
      resume: {
        directory: '/repo',
        agent: 'claude',
        resume: providerSessionId,
        transcriptStorage: 'persisted',
        approvedNewDirectoryCreation: true,
      },
    });

    const prepared = mod.SessionHandoffPrepareTargetResponseSchema.parse(
      buildPayload(providerMintedId),
    );
    expect(prepared.remoteSessionId).toBe(providerMintedId);
    expect(prepared.resume?.resume).toBe(providerMintedId);

    const fetched = mod.SessionHandoffPrepareTargetResultGetSuccessResponseSchema.parse(
      buildPayload(providerMintedId),
    );
    expect(fetched.remoteSessionId).toBe(providerMintedId);
    expect(fetched.resume.resume).toBe(providerMintedId);

    // An all-whitespace value is not an identity. `min(1)` admitted it; the
    // opaque-identifier owner is the only judgement made about these bytes.
    for (const blank of ['   ', '\n', ' \t ']) {
      expect(mod.SessionHandoffPrepareTargetResponseSchema.safeParse({
        ...buildPayload(providerMintedId),
        remoteSessionId: blank,
      }).success).toBe(false);
      expect(mod.SessionHandoffPrepareTargetResponseSchema.safeParse({
        ...buildPayload(blank),
        remoteSessionId: providerMintedId,
      }).success).toBe(false);
      expect(mod.SessionHandoffPrepareTargetResultGetSuccessResponseSchema.safeParse({
        ...buildPayload(providerMintedId),
        remoteSessionId: blank,
      }).success).toBe(false);
    }
  });

  it('validates runtimeDescriptorV1 as a schema-owned field', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse({
        handoffId: 'handoff_runtime_descriptor',
        status: {
          handoffId: 'handoff_runtime_descriptor',
          status: 'ready_for_cutover',
          phase: 'staging_target',
          recoveryActions: [],
        },
        remoteSessionId: 'remote_session_runtime_descriptor',
        directSource: {
          kind: 'claudeConfig',
          configDir: '/tmp/claude',
        },
        runtimeDescriptorV1: {
          agentId: 'pi',
        },
        resume: {
          directory: '/repo',
          agent: 'claude',
          resume: 'resume-token',
          transcriptStorage: 'persisted',
          approvedNewDirectoryCreation: true,
        },
      }).success,
    ).toBe(false);
  });

});
