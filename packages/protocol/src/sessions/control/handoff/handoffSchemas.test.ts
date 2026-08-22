import { describe, expect, it } from 'vitest';

async function loadHandoffModule() {
  return await import(new URL('./handoffRpc.js', import.meta.url).href).catch((error) => ({ error } as const));
}

describe('session handoff schemas', () => {
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
        workspaceReplicationSourceRootPath: '/repo',
        workspaceReplicationHandoffBackTargetRootPath: '/repo-target',
        workspaceReplicationManifestTransferPublication: {
          transferId: 'transfer_manifest_1',
          futureManifestPublicationField: 'keep-me',
        },
        workspaceReplicationSourceControllerMetadata: {
          provider: 'git',
        },
        futureHandoffMetadataField: 'keep-me',
      },
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'include_selected',
        ignoredIncludeGlobs: ['dist/**'],
        futureWorkspaceTransferField: 'keep-me',
      },
      futurePrepareTargetField: 'keep-me',
    });

    expect((request as any).futurePrepareTargetField).toBe('keep-me');
    expect((request.handoffMetadataV2 as any).futureHandoffMetadataField).toBe('keep-me');
    expect((request.workspaceTransfer as any).futureWorkspaceTransferField).toBe('keep-me');
    expect((request.endpointCandidates[0] as any).futureEndpointField).toBe('keep-me');
    expect((request.handoffMetadataV2?.agentBundleTransferPublication as any).futurePublicationField).toBe('keep-me');
    expect((request.handoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates?.[0] as any).futureEndpointField).toBe('keep-me');
    expect((request.handoffMetadataV2?.workspaceReplicationManifestTransferPublication as any).futureManifestPublicationField).toBe('keep-me');

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
      transportStrategy: 'transfer_snapshot',
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
    expect(typeof mod.SessionHandoffWorkspaceTransferSchema).toBe('object');

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
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'include_selected',
        ignoredIncludeGlobs: ['dist/**'],
      },
    });
    expect(startParsed.success).toBe(true);
    if (!startParsed.success) return;
    expect(startParsed.data.workspaceTransfer).toEqual({
      enabled: true,
      strategy: 'transfer_snapshot',
      conflictPolicy: 'create_sibling_copy',
      includeIgnoredMode: 'include_selected',
      ignoredIncludeGlobs: ['dist/**'],
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

    expect(
      mod.SessionHandoffStatusSchema.safeParse({
        handoffId: 'handoff_2',
        status: 'ready_for_cutover',
        phase: 'staging_target',
        transportStrategy: 'transfer_snapshot',
        recoveryActions: [],
      }).success,
    ).toBe(true);

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
      workspaceReplicationSourceRootPath: '/repo',
      workspaceReplicationHandoffBackTargetRootPath: '/repo-target',
      workspaceReplicationManifestTransferPublication: {
        transferId: 'transfer_manifest_1',
      },
      workspaceReplicationSourceControllerMetadata: {
        provider: 'git',
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

  it('rejects oversized source controller metadata headers (no large JSON in handoffMetadataV2)', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.SessionHandoffMetadataV2Schema.safeParse({
        workspaceReplicationSourceControllerMetadata: {
          key: 'x'.repeat(200_000),
        },
      }).success,
    ).toBe(false);
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

  it('rejects unbounded transfer metadata (ids, candidate lists, open payloads)', async () => {
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

    expect(
      mod.SessionHandoffPrepareTargetRequestSchema.safeParse({
        handoffId: 'handoff_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        endpointCandidates: Array.from({ length: 200 }, (_, index) => ({
          kind: 'http',
          url: `http://127.0.0.1:46001/machine-transfers/direct/transfer_${index}`,
          expiresAt: 1,
        })),
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
    expect(mod.SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(buildPayload('a'.repeat(129))).success).toBe(false);
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
