import { describe, expect, it } from 'vitest';

async function loadHandoffModule() {
  return await import(new URL('./handoffRpc.js', import.meta.url).href).catch((error) => ({ error } as const));
}

describe('session handoff schemas', () => {
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
      providerBundleTransferPublication: {
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
          providerBundle: {
            providerId: 'claude',
            remoteSessionId: 'claude_session_inline',
            transcriptBase64: 'e30K',
          },
        },
        providerBundle: {
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
          providerBundle: {
            providerId: 'claude',
            remoteSessionId: 'claude_session_inline',
            transcriptBase64: 'e30K',
          },
        },
        providerBundle: {
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

});
