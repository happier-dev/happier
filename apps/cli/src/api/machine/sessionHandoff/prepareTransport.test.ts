import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createSessionHandoffAgentBundlePayloadSource } from '../../../session/handoff/agentBundle/file';
import { buildSessionHandoffAgentBundleTransferId } from '../../../session/handoff/agentBundle/transferPublication';
import { resolvePrepareAgentBundle } from './prepareTransport';
import { createMachineTransferRouteCache } from '../../../machines/transfer/transferRouteCache';

describe('resolvePrepareAgentBundle', () => {
  it('keeps finite session-bundle transport independent from the workspace machine carrier', async () => {
    const admission = vi.fn(async () => undefined);
    const existingAgentBundle = { agentId: 'claude', remoteSessionId: 'session-source' };

    await expect(resolvePrepareAgentBundle({
      request: {
        handoffId: 'handoff-finite-transfer',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        endpointCandidates: [],
      },
      actualTransportStrategy: 'server_routed_stream',
      existingAgentBundle,
      receivedAgentBundlePath: '/tmp/unused-agent-bundle.bin',
      // Compatibility-shaped extras deliberately exercise the old admission
      // path. The finite bundle owner must ignore them: only the workspace
      // sync adapter may consume happier/machine/1 for Mutagen bytes.
      machineCarrierRequired: true,
      machineCarrierAdmission: admission,
    } as Parameters<typeof resolvePrepareAgentBundle>[0] & {
      machineCarrierRequired: boolean;
      machineCarrierAdmission: typeof admission;
    })).resolves.toBe(existingAgentBundle);
    expect(admission).not.toHaveBeenCalled();
  });

  it('keeps a received binary agent bundle available until its file slices are consumed', async () => {
    const sourceDirectory = await mkdtemp(join(os.tmpdir(), 'happier-agent-bundle-source-'));
    const targetDirectory = await mkdtemp(join(os.tmpdir(), 'happier-agent-bundle-target-'));
    const sourceTranscriptPath = join(sourceDirectory, 'transcript.jsonl');
    const receivedBundlePath = join(targetDirectory, 'received-agent-bundle.bin');
    const transcript = Buffer.from('{"type":"session_meta"}\n{"type":"response_item"}\n', 'utf8');
    await writeFile(sourceTranscriptPath, transcript);
    const payloadSource = await createSessionHandoffAgentBundlePayloadSource({
      agentId: 'claude',
      remoteSessionId: 'claude_session_binary',
      transcriptFile: {
        t: 'happier.handoff.file.v1',
        filePath: sourceTranscriptPath,
        offsetBytes: 0,
        sizeBytes: transcript.length,
      },
    });
    if (payloadSource.kind !== 'file') throw new Error('Expected a file-backed agent bundle');
    const handoffId = 'handoff_binary_agent_bundle';
    const transferId = buildSessionHandoffAgentBundleTransferId(handoffId);
    const onProgress = vi.fn();
    const transferRouteCache = createMachineTransferRouteCache({ serverId: 'source-server' });
    const endpointCandidates = [{
      kind: 'http' as const,
      url: `http://127.0.0.1:46001/machine-transfers/direct/${Buffer.from(transferId).toString('base64url')}`,
      authorizationToken: 'test-token',
      expiresAt: Date.now() + 30_000,
    }];
    transferRouteCache.recordDirectPeerRouteUnavailable({ remoteMachineId: 'machine_source', endpointCandidates }, 'previously unavailable');

    try {
      const bundle = await resolvePrepareAgentBundle({
        request: {
          handoffId,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
        },
        actualTransportStrategy: 'direct_peer',
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId,
            sizeBytes: payloadSource.sizeBytes,
            manifestHash: payloadSource.manifestHash,
            endpointCandidates,
          },
        },
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile: vi.fn(async ({ destinationPath, onProgress: reportProgress }) => {
            await copyFile(payloadSource.filePath, destinationPath);
            await reportProgress?.(payloadSource.sizeBytes);
            return { destinationPath };
          }),
          clearPublishedTransfer: vi.fn(),
        },
        receivedAgentBundlePath: receivedBundlePath,
        transferRouteCache,
        onProgress,
      } as Parameters<typeof resolvePrepareAgentBundle>[0] & { receivedAgentBundlePath: string });

      expect(bundle?.agentId).toBe('claude');
      expect(onProgress).toHaveBeenLastCalledWith(payloadSource.sizeBytes);
      if (!bundle || bundle.agentId !== 'claude' || !bundle.transcriptFile) {
        throw new Error('Expected a file-backed Claude agent bundle');
      }
      const transcriptFile = bundle.transcriptFile;
      if (
        typeof transcriptFile !== 'object'
        || transcriptFile === null
        || Array.isArray(transcriptFile)
      ) {
        throw new Error('Expected an exact file-backed transcript slice');
      }
      const transcriptFileRecord = transcriptFile as Record<string, unknown>;
      if (
        typeof transcriptFileRecord.filePath !== 'string'
        || typeof transcriptFileRecord.offsetBytes !== 'number'
        || typeof transcriptFileRecord.sizeBytes !== 'number'
      ) {
        throw new Error('Expected an exact file-backed transcript slice');
      }
      const artifact = await readFile(transcriptFileRecord.filePath);
      expect(
        artifact.subarray(
          transcriptFileRecord.offsetBytes,
          transcriptFileRecord.offsetBytes + transcriptFileRecord.sizeBytes,
        ),
      ).toEqual(transcript);
    } finally {
      await payloadSource.dispose?.();
      await rm(sourceDirectory, { recursive: true, force: true });
      await rm(targetDirectory, { recursive: true, force: true });
    }
  });
});
