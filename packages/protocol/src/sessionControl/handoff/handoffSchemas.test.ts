import { describe, expect, expectTypeOf, it } from 'vitest';

import * as handoffSchemasModule from './handoffSchemas.js';
import {
    type SessionHandoffPrepareTargetRequest,
    type SessionHandoffProviderBundle,
    type SessionHandoffStartResponse,
    SessionHandoffAbortRequestSchema,
    SessionHandoffCommitRequestSchema,
    SessionHandoffPrepareTargetRequestSchema,
    SessionHandoffPrepareTargetResponseSchema,
    SessionHandoffStartRequestSchema,
  SessionHandoffStartResponseSchema,
  SessionHandoffStatusSchema,
  SessionHandoffTransferredPayloadSchema,
  TransferChunkEnvelopeSchema,
  TransferEndpointCandidateSchema,
} from './handoffSchemas.js';
import { TransferStreamEnvelopeSchema } from './transferStream.js';

type PrepareTargetRequestHasWorkspaceManifestHash =
  'workspaceManifestHash' extends keyof SessionHandoffPrepareTargetRequest ? true : false;
type PrepareTargetRequestHasProviderBundle =
  'providerBundle' extends keyof SessionHandoffPrepareTargetRequest ? true : false;
type PrepareTargetRequestHasWorkspaceArtifacts =
  'workspaceArtifacts' extends keyof SessionHandoffPrepareTargetRequest ? true : false;
type PrepareTargetRequestHasTransferredPayload =
  'transferredPayload' extends keyof SessionHandoffPrepareTargetRequest ? true : false;
type StartResponseHasProviderBundle =
  'providerBundle' extends keyof SessionHandoffStartResponse ? true : false;
type StartResponseHasWorkspaceArtifacts =
  'workspaceArtifacts' extends keyof SessionHandoffStartResponse ? true : false;
type StartResponseHasTransferredPayload =
  'transferredPayload' extends keyof SessionHandoffStartResponse ? true : false;

describe('session handoff schemas', () => {
  it('keeps the exported provider-bundle type canonical while wire parsing stays backwards compatible', () => {
    expectTypeOf<SessionHandoffProviderBundle>().not.toHaveProperty('codexBackendMode');
  });

  it('does not export legacy inline transferred-payload carrier helpers', () => {
    expect('createSessionHandoffTransferredPayloadCarrier' in handoffSchemasModule).toBe(false);
    expect('extractSessionHandoffTransferredPayload' in handoffSchemasModule).toBe(false);
    expect('extractCanonicalSessionHandoffTransferredPayload' in handoffSchemasModule).toBe(false);
    expect('extractSessionHandoffDirectPeerTransferredPayload' in handoffSchemasModule).toBe(false);
  });

  it('keeps the exported prepare-target request type canonical while still accepting legacy manifest-hash input', () => {
    expectTypeOf<PrepareTargetRequestHasWorkspaceManifestHash>().toEqualTypeOf<false>();
    expectTypeOf<PrepareTargetRequestHasProviderBundle>().toEqualTypeOf<false>();
    expectTypeOf<PrepareTargetRequestHasWorkspaceArtifacts>().toEqualTypeOf<false>();
    expectTypeOf<PrepareTargetRequestHasTransferredPayload>().toEqualTypeOf<false>();

    const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse({
      handoffId: 'handoff_prepare_legacy_manifest_hash',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      workspaceManifestHash: 'sha256:legacy-manifest-hash',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).not.toHaveProperty('workspaceManifestHash');
    expect(parsed.data).not.toHaveProperty('providerBundle');
    expect(parsed.data).not.toHaveProperty('workspaceArtifacts');
  });

  it('accepts a start request with direct-peer strategy preference', () => {
    const parsed = SessionHandoffStartRequestSchema.safeParse({
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

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.workspaceTransfer : null).toEqual({
      enabled: true,
      strategy: 'transfer_snapshot',
      conflictPolicy: 'create_sibling_copy',
      includeIgnoredMode: 'include_selected',
      ignoredIncludeGlobs: ['dist/**'],
    });
  });

  it('accepts a start request with a pre-resolved transport strategy', () => {
    const parsed = SessionHandoffStartRequestSchema.safeParse({
      sessionId: 'sess_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'server_routed_stream',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a prepare-target request with a negotiated transport strategy', () => {
    const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse({
      handoffId: 'handoff_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      allowServerRoutedFallback: false,
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      workspaceTransfer: {
        enabled: true,
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
      workspaceManifestHash: 'sha256:abc',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.workspaceTransfer : null).toEqual({
      enabled: true,
      strategy: 'transfer_snapshot',
      conflictPolicy: 'create_sibling_copy',
      includeIgnoredMode: 'exclude',
      ignoredIncludeGlobs: [],
    });
  });

  it('accepts a direct-peer prepare-target request that is artifacts-first via endpoint candidates', () => {
    const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse({
      handoffId: 'handoff_direct_peer_candidates',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_direct_peer_candidates',
          authorizationToken: 'test-token',
          expiresAt: 1,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('strips legacy direct-peer prepare-target requests with top-level workspace artifacts', () => {
    const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse({
      handoffId: 'handoff_direct_peer_legacy_workspace_artifacts_only',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_direct_peer_legacy_workspace_artifacts_only?token=test-token',
          expiresAt: 1,
        },
      ],
      workspaceArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobs: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            contentBase64: 'aGVsbG8K',
          },
        ],
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).not.toHaveProperty('workspaceArtifacts');
  });

  it('strips prepare-target requests with inline transferred bundles', () => {
    const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse({
      handoffId: 'handoff_inline_artifacts',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      workspaceArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobs: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            contentBase64: 'aGVsbG8K',
          },
        ],
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).not.toHaveProperty('workspaceArtifacts');
  });

  it('accepts a server-routed prepare-target request without inline bundles', () => {
    const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse({
      handoffId: 'handoff_2',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a direct-peer prepare-target request without endpoint candidates at the schema boundary', () => {
    const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse({
      handoffId: 'handoff_invalid_direct_peer',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data.endpointCandidates).toEqual([]);
  });

  it('accepts start and prepare responses with provider handoff data', () => {
    expectTypeOf<StartResponseHasProviderBundle>().toEqualTypeOf<false>();
    expectTypeOf<StartResponseHasWorkspaceArtifacts>().toEqualTypeOf<false>();
    expectTypeOf<StartResponseHasTransferredPayload>().toEqualTypeOf<false>();

    expect(
      SessionHandoffStartResponseSchema.safeParse({
        handoffId: 'handoff_1',
        status: {
          handoffId: 'handoff_1',
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
        endpointCandidates: [],
        targetPath: '/repo',
      }).success,
    ).toBe(true);

    expect(
      SessionHandoffPrepareTargetResponseSchema.safeParse({
        handoffId: 'handoff_1',
        status: {
          handoffId: 'handoff_1',
          status: 'ready_for_cutover',
          phase: 'staging_target',
          recoveryActions: [],
          transportStrategy: 'server_routed_stream',
        },
        remoteSessionId: 'claude_session_1',
        directSource: {
          kind: 'claudeConfig',
          configDir: null,
          projectId: null,
        },
        resume: {
          directory: '/repo',
          agent: 'claude',
          resume: 'claude_session_1',
          transcriptStorage: 'direct',
          approvedNewDirectoryCreation: true,
        },
      }).success,
    ).toBe(true);
  });

  it('strips inline workspace artifacts metadata from legacy start responses', () => {
    const parsed = SessionHandoffStartResponseSchema.safeParse({
        handoffId: 'handoff_git_metadata',
        status: {
          handoffId: 'handoff_git_metadata',
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
        endpointCandidates: [],
        targetPath: '/repo',
        workspaceArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobs: [
            {
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              contentBase64: 'aGVsbG8K',
            },
          ],
          sourceControllerMetadata: {
            provider: 'git',
            branchName: 'feature/handoff',
          },
        },
      });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).not.toHaveProperty('workspaceArtifacts');
  });

  it('accepts codex handoff payloads that only carry canonical affinity/backend data', () => {
    expect(
      SessionHandoffStartResponseSchema.safeParse({
        handoffId: 'handoff_codex',
        status: {
          handoffId: 'handoff_codex',
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
        endpointCandidates: [],
        targetPath: '/repo',
        providerBundle: {
          providerId: 'codex',
          remoteSessionId: 'codex_session_1',
          affinity: {
            backendMode: 'appServer',
          },
          files: [
            {
              relativePath: 'sessions/2026/03/08/rollout-thread_1.jsonl',
              contentBase64: 'e30K',
            },
          ],
        },
      }).success,
    ).toBe(true);

    expect(
      SessionHandoffPrepareTargetResponseSchema.safeParse({
        handoffId: 'handoff_codex',
        status: {
          handoffId: 'handoff_codex',
          status: 'ready_for_cutover',
          phase: 'staging_target',
          recoveryActions: [],
          transportStrategy: 'direct_peer',
        },
        remoteSessionId: 'codex_session_1',
        directSource: {
          kind: 'codexHome',
          home: 'user',
        },
        resume: {
          directory: '/repo',
          agent: 'codex',
          resume: 'codex_session_1',
          transcriptStorage: 'direct',
          approvedNewDirectoryCreation: true,
          codexBackendMode: 'appServer',
        },
      }).success,
    ).toBe(true);
  });

  it('accepts codex handoff payloads that carry connected-service source affinity and runtime descriptor state', () => {
    expect(
      SessionHandoffTransferredPayloadSchema.safeParse({
        providerBundle: {
          providerId: 'codex',
          remoteSessionId: 'codex_session_connected',
          affinity: {
            backendMode: 'appServer',
            source: {
              kind: 'codexHome',
              home: 'connectedService',
              connectedServiceId: 'openai-codex',
            },
            runtimeDescriptor: {
              v: 1,
              providerId: 'codex',
              provider: {
                backendMode: 'appServer',
                vendorSessionId: 'codex_session_connected',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
              },
            },
          },
          files: [
            {
              relativePath: 'sessions/2026/03/08/rollout-thread_connected.jsonl',
              contentBase64: 'e30K',
            },
          ],
        },
      }).success,
    ).toBe(true);

    expect(
      SessionHandoffPrepareTargetResponseSchema.safeParse({
        handoffId: 'handoff_codex_connected',
        status: {
          handoffId: 'handoff_codex_connected',
          status: 'ready_for_cutover',
          phase: 'staging_target',
          recoveryActions: [],
          transportStrategy: 'direct_peer',
        },
        remoteSessionId: 'codex_session_connected',
        directSource: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'codex_session_connected',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
          },
        },
        resume: {
          directory: '/repo',
          agent: 'codex',
          resume: 'codex_session_connected',
          transcriptStorage: 'direct',
          approvedNewDirectoryCreation: true,
          codexBackendMode: 'appServer',
        },
      }).success,
    ).toBe(true);
  });

  it('normalizes legacy codex handoff resume payloads onto canonical codexBackendMode', () => {
    const parsed = SessionHandoffPrepareTargetResponseSchema.safeParse({
        handoffId: 'handoff_codex_legacy',
        status: {
          handoffId: 'handoff_codex_legacy',
          status: 'ready_for_cutover',
          phase: 'staging_target',
          recoveryActions: [],
          transportStrategy: 'server_routed_stream',
        },
        remoteSessionId: 'codex_session_legacy',
        directSource: {
          kind: 'codexHome',
          home: 'user',
        },
        resume: {
          directory: '/repo',
          agent: 'codex',
          resume: 'codex_session_legacy',
          transcriptStorage: 'direct',
          approvedNewDirectoryCreation: true,
          experimentalCodexAcp: true,
        },
      });

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.resume.codexBackendMode : null).toBe('acp');
    expect(parsed.success ? parsed.data.resume : null).not.toHaveProperty('experimentalCodexAcp');
  });

  it('accepts a start response without inline bundles for server-routed transfer', () => {
    expect(
      SessionHandoffStartResponseSchema.safeParse({
        handoffId: 'handoff_2',
        status: {
          handoffId: 'handoff_2',
          status: 'pending',
          phase: 'preparing',
          transportStrategy: 'server_routed_stream',
          recoveryActions: [],
        },
        endpointCandidates: [],
        targetPath: '/repo',
      }).success,
    ).toBe(true);
  });

  it('accepts a transferred payload that carries replication-native workspace artifacts', () => {
    expect(
      SessionHandoffTransferredPayloadSchema.safeParse({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        workspaceArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'bin/run.sh',
                kind: 'file',
                digest: 'sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e',
                sizeBytes: 18,
                executable: true,
              },
            ],
            fingerprint: 'sha256:3a8f2e64472d2b617f6ee5c178037f4d77460c6f9f23f15d4f4648f1154700f2',
          },
          blobs: [
            {
              digest: 'sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e',
              contentBase64: 'IyEvYmluL3NoCmVjaG8gaGkK',
            },
          ],
        },
      }).success,
    ).toBe(true);
  });


  it('accepts transferred workspace artifacts when only a sparse blob subset is carried', () => {
    expect(
      SessionHandoffTransferredPayloadSchema.safeParse({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        workspaceArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'bin/run.sh',
                kind: 'file',
                digest: 'sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e',
                sizeBytes: 18,
                executable: true,
              },
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
              {
                relativePath: 'docs/empty.txt',
                kind: 'file',
                digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                sizeBytes: 0,
                executable: false,
              },
            ],
            fingerprint: 'sha256:3a8f2e64472d2b617f6ee5c178037f4d77460c6f9f23f15d4f4648f1154700f2',
          },
          blobs: [
            {
              digest: 'sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e',
              contentBase64: 'IyEvYmluL3NoCmVjaG8gaGkK',
            },
            {
              digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              contentBase64: '',
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('accepts commit and abort requests', () => {
    expect(SessionHandoffCommitRequestSchema.safeParse({ handoffId: 'handoff_1' }).success).toBe(true);
    expect(
      SessionHandoffAbortRequestSchema.safeParse({
        handoffId: 'handoff_1',
        reason: 'target_unreachable',
      }).success,
    ).toBe(true);
  });

  it('accepts status payloads with recovery actions', () => {
    const parsed = SessionHandoffStatusSchema.safeParse({
      handoffId: 'handoff_1',
      status: 'awaiting_recovery',
      phase: 'cutover',
      transportStrategy: 'server_routed_stream',
      recoveryActions: ['restart_on_source', 'keep_stopped'],
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts transport endpoint candidates and transfer chunks', () => {
    expect(
      TransferEndpointCandidateSchema.safeParse({
        kind: 'tcp',
        url: 'tcp://127.0.0.1:31337',
        expiresAt: 1,
      }).success,
    ).toBe(true);

    expect(
      TransferEndpointCandidateSchema.safeParse({
        kind: 'http',
        url: 'http://127.0.0.1:31337/machine-transfers/direct/transfer_1',
        authorizationToken: 'token_1',
        expiresAt: 1,
      }).success,
    ).toBe(true);

    expect(
      TransferEndpointCandidateSchema.safeParse({
        kind: 'rns',
        path: '/machine-transfers/direct/transfer_1?token=token_1',
        expiresAt: 1,
      }).success,
    ).toBe(false);

    expect(
      TransferEndpointCandidateSchema.safeParse({
        kind: 'http',
        url: 'tcp://127.0.0.1:31337',
        expiresAt: 1,
      }).success,
    ).toBe(false);

    expect(
      TransferEndpointCandidateSchema.safeParse({
        kind: 'tcp',
        url: '/machine-transfers/direct/transfer_1?token=token_1',
        expiresAt: 1,
      }).success,
    ).toBe(false);

    expect(
      TransferChunkEnvelopeSchema.safeParse({
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      }).success,
    ).toBe(true);

    expect(
      TransferStreamEnvelopeSchema.safeParse({
        transferId: 'transfer_1',
        kind: 'open',
        manifestHash: 'sha256:manifest',
        recipientPublicKeyBase64: 'YQ==',
      }).success,
    ).toBe(true);

    expect(
      TransferChunkEnvelopeSchema.safeParse({
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
        encryptedDataKeyEnvelopeBase64: 'Yg==',
      }).success,
    ).toBe(true);
  });

  it('strips legacy codex start-response provider payloads with codexBackendMode', () => {
    const parsed = SessionHandoffStartResponseSchema.safeParse({
        handoffId: 'handoff_codex_legacy_bundle',
        status: {
          handoffId: 'handoff_codex_legacy_bundle',
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
        endpointCandidates: [],
        targetPath: '/repo',
        providerBundle: {
          providerId: 'codex',
          remoteSessionId: 'codex_session_legacy_bundle',
          codexBackendMode: 'appServer',
          files: [
            {
              relativePath: 'sessions/2026/03/08/rollout-thread_legacy.jsonl',
              contentBase64: 'e30K',
            },
          ],
        },
      });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).not.toHaveProperty('providerBundle');
  });

  it('strips legacy start-response inline fields', () => {
    const parsed = SessionHandoffStartResponseSchema.safeParse({
      handoffId: 'handoff_start_legacy_inline_payload',
      status: {
        handoffId: 'handoff_start_legacy_inline_payload',
        status: 'pending',
        phase: 'preparing',
        recoveryActions: [],
      },
      endpointCandidates: [],
      targetPath: '/repo',
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      workspaceArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobs: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            contentBase64: 'aGVsbG8K',
          },
        ],
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).not.toHaveProperty('providerBundle');
    expect(parsed.data).not.toHaveProperty('workspaceArtifacts');
    expect(parsed.data).not.toHaveProperty('transferredPayload');
  });
});
