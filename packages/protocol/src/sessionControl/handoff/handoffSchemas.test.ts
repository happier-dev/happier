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
    expect(typeof mod.SessionHandoffProviderBundleSchema).toBe('object');
    expect(typeof mod.SessionHandoffTransferredWorkspaceArtifactsSchema).toBe('object');
    expect(typeof mod.TransferEndpointCandidateSchema).toBe('object');
    expect(typeof mod.TransferStreamEnvelopeSchema).toBe('object');
    expect(typeof mod.SessionHandoffWorkspaceTransferSchema).toBe('object');
  });

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
            url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_1?token=test-token',
            authorizationToken: 'test-token',
            expiresAt: 1,
          },
        ],
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
      mod.SessionHandoffProviderBundleSchema.safeParse({
        providerId: 'claude',
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      }).success,
    ).toBe(true);

    expect(
      mod.SessionHandoffTransferredWorkspaceArtifactsSchema.safeParse({
        manifest: {
          entries: [],
        },
        blobs: [
          {
            digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            contentBase64: 'aGVsbG8K',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      mod.SessionHandoffTransferredWorkspaceArtifactsSchema.safeParse({
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              sizeBytes: 6,
              executable: false,
            },
          ],
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
  });

  it('accepts absolute transfer endpoint URLs with matching schemes', async () => {
    const mod = await loadHandoffModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(
      mod.TransferEndpointCandidateSchema.safeParse({
        kind: 'http',
        url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_1',
        authorizationToken: 'token',
        expiresAt: 1,
      }).success,
    ).toBe(true);

    expect(
      mod.TransferEndpointCandidateSchema.safeParse({
        kind: 'https',
        url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_1',
        expiresAt: 1,
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
});
