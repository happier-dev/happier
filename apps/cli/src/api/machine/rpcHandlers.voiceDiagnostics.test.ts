import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VoiceSpeechDiagnosticArtifactDownloadChunkResponseV1Schema,
  VoiceSpeechDiagnosticArtifactDownloadCloseResponseV1Schema,
  VoiceSpeechDiagnosticArtifactDownloadInitResponseV1Schema,
  VoiceSpeechDiagnosticsDeleteAllResponseV1Schema,
  VoiceSpeechDiagnosticsRevokeCaptureResponseV1Schema,
  VoiceSpeechDiagnosticsStatusResponseV1Schema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';
import { createVoiceDiagnosticsController } from '@/daemon/voiceDiagnostics/controller';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';

import { registerMachineVoiceDiagnosticsRpcHandlers } from './rpcHandlers.voiceDiagnostics';

const TEST_SCOPE = 'voice-diagnostics-real-fs';
const PCM_SHA256 = '792aa8f917004907319ab714f9815727464751220899023313dfe69d28ae60c3';

function createDeterministicPcm16(): Buffer {
  const pcm = Buffer.alloc(512 * 2);
  for (let index = 0; index < 512; index += 1) {
    pcm.writeInt16LE(((index * 257) % 65_536) - 32_768, index * 2);
  }
  return pcm;
}

function createRealFilesystemRuntime(home: string, logs: string[]) {
  const diagnostics = createVoiceDiagnosticsController({ happyHomeDir: home });
  const rpcHandlerManager = new RpcHandlerManager({
    scopePrefix: TEST_SCOPE,
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy',
    encryptionMode: 'plain',
    logger: (message, data) => logs.push(JSON.stringify([message, data])),
  });
  const registration = registerMachineVoiceDiagnosticsRpcHandlers({ rpcHandlerManager, diagnostics });
  return {
    diagnostics,
    registration,
    request: async (method: string, params: unknown): Promise<unknown> => await rpcHandlerManager.handleRequest({
      method: `${TEST_SCOPE}:${method}`,
      params,
    }),
  };
}

describe('registerMachineVoiceDiagnosticsRpcHandlers', () => {
  it('proves the opt-in, bounded, restart-safe real-filesystem lifecycle through the production RPC manager', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-diagnostics-real-fs-'));
    const logs: string[] = [];
    const pcm = createDeterministicPcm16();
    const authorizationA = '11111111-1111-4111-8111-111111111111';
    const authorizationB = '22222222-2222-4222-8222-222222222222';
    const authorizationC = '33333333-3333-4333-8333-333333333333';
    const settings = {
      v: 1 as const,
      enabled: true,
      consentVersion: 1 as const,
      captureSttInput: true,
      captureTtsOutput: false,
      maxAgeMs: 300_000,
      maxFiles: 2,
      maxBytes: 2_048,
      maxDurationMs: 1_000,
    };
    let runtime = createRealFilesystemRuntime(home, logs);
    try {
      expect(pcm.byteLength).toBe(1_024);
      expect(createHash('sha256').update(pcm).digest('hex')).toBe(PCM_SHA256);

      await expect(runtime.diagnostics.capture({
        direction: 'stt_input', format: 'pcm16', bytes: pcm, durationMs: 32,
        sessionId: 'session-secret', providerId: 'provider-secret', attemptId: 'attempt-disabled',
        authorizationId: authorizationA,
      })).resolves.toBeNull();
      expect(VoiceSpeechDiagnosticsStatusResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS,
        {},
      )).artifacts).toEqual([]);

      const configured = VoiceSpeechDiagnosticsStatusResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE,
        { settings },
      ));
      expect(configured).toMatchObject({
        ok: true,
        root: join(home, 'voice', 'diagnostics', 'v1'),
        backupPolicy: { storage: 'private_cache', automaticSync: 'not_implemented' },
      });
      if (process.platform !== 'win32') {
        expect((await stat(configured.root)).mode & 0o777).toBe(0o700);
      }

      const capture = async (authorizationId: string, attemptId: string) => await runtime.diagnostics.capture({
        direction: 'stt_input', format: 'pcm16', bytes: pcm, durationMs: 32,
        sessionId: 'session-secret', providerId: 'provider-secret', attemptId, authorizationId,
      });
      await expect(capture(authorizationA, 'attempt-a')).resolves.not.toBeNull();
      await expect(capture(authorizationB, 'attempt-b')).resolves.not.toBeNull();
      expect(VoiceSpeechDiagnosticsRevokeCaptureResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE,
        { authorizationId: authorizationA },
      ))).toEqual({ ok: true });
      await expect(capture(authorizationA, 'attempt-revoked')).resolves.toBeNull();
      await expect(capture(authorizationC, 'attempt-c')).resolves.not.toBeNull();

      let status = VoiceSpeechDiagnosticsStatusResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS,
        {},
      ));
      expect(status.artifacts).toHaveLength(2);
      expect(status.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0)).toBe(2_048);
      expect(status.artifacts.every((artifact) => artifact.byteLength === pcm.byteLength)).toBe(true);
      expect(status.health).toEqual({
        captureFailure: false,
        cleanup: { status: 'healthy', code: null, ownedEntryCount: 4 },
      });

      await expect(runtime.diagnostics.capture({
        direction: 'stt_input', format: 'pcm16', bytes: Buffer.alloc(settings.maxBytes + 1), durationMs: 32,
        sessionId: 'session-secret', providerId: 'provider-secret', attemptId: 'attempt-over-limit',
        authorizationId: authorizationC,
      })).resolves.toBeNull();
      status = VoiceSpeechDiagnosticsStatusResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS,
        {},
      ));
      expect(status).toMatchObject({
        artifacts: [{ byteLength: 1_024 }, { byteLength: 1_024 }],
        health: { captureFailure: true },
      });
      await expect(capture(authorizationC, 'attempt-recovery')).resolves.not.toBeNull();

      status = VoiceSpeechDiagnosticsStatusResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS,
        {},
      ));
      const expiredArtifact = await runtime.diagnostics.resolveArtifactForExport(status.artifacts[0]!.id);
      expect(expiredArtifact).not.toBeNull();
      const expiredMetadata = JSON.parse(await readFile(expiredArtifact!.metadataPath, 'utf8')) as Record<string, unknown>;
      await writeFile(expiredArtifact!.metadataPath, `${JSON.stringify({
        ...expiredMetadata,
        createdAtMs: Date.now() - settings.maxAgeMs - 1_000,
      }, null, 2)}\n`);
      await writeFile(join(configured.root, 'deadbeef.wav'), pcm);
      await writeFile(
        join(configured.root, 'cafebabe.pcm16.tmp-44444444-4444-4444-8444-444444444444'),
        pcm,
      );

      await runtime.registration.dispose();
      runtime = createRealFilesystemRuntime(home, logs);
      VoiceSpeechDiagnosticsStatusResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE,
        { settings },
      ));
      status = VoiceSpeechDiagnosticsStatusResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS,
        {},
      ));
      expect(status.artifacts).toHaveLength(1);
      expect(await readdir(configured.root)).toEqual(expect.not.arrayContaining([
        'deadbeef.wav',
        'cafebabe.pcm16.tmp-44444444-4444-4444-8444-444444444444',
      ]));

      // Session opt-out is intentionally process-local: a fresh daemon process
      // accepts the same request authorization when the account setting permits it.
      await expect(capture(authorizationA, 'attempt-after-restart')).resolves.not.toBeNull();
      status = VoiceSpeechDiagnosticsStatusResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS,
        {},
      ));
      expect(status.artifacts).toHaveLength(2);
      const exportArtifact = status.artifacts.at(-1)!;
      const recipient = createTransferRecipientKeyPair();
      const rejectedExport = VoiceSpeechDiagnosticArtifactDownloadInitResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_INIT,
        {
          artifactId: '../../etc/passwd',
          intent: 'user_confirmed_export',
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        },
      ));
      expect(rejectedExport).toMatchObject({ success: false, errorCode: 'invalid_parameters' });

      const init = VoiceSpeechDiagnosticArtifactDownloadInitResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_INIT,
        {
          artifactId: exportArtifact.id,
          intent: 'user_confirmed_export',
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        },
      ));
      if (!init.success) throw new Error(`diagnostics export init failed: ${init.error}`);
      expect(init).toMatchObject({ sizeBytes: pcm.byteLength, name: expect.stringMatching(/^voice-diagnostic-\d+-stt_input\.pcm16$/) });
      const chunk = VoiceSpeechDiagnosticArtifactDownloadChunkResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_CHUNK,
        { downloadId: init.downloadId, index: 0 },
      ));
      if (!chunk.success) throw new Error(`diagnostics export chunk failed: ${chunk.error}`);
      const exportedPcm = Buffer.from(decryptEncryptedTransferChunkEnvelope({
        transferId: init.downloadId,
        sequence: 0,
        payloadBase64: chunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
        recipientSecretKeySeed: recipient.recipientSecretKeySeed,
      }));
      expect(exportedPcm).toEqual(pcm);
      expect(createHash('sha256').update(exportedPcm).digest('hex')).toBe(PCM_SHA256);
      expect(VoiceSpeechDiagnosticArtifactDownloadCloseResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_FINALIZE,
        { downloadId: init.downloadId },
      ))).toEqual({ success: true });

      await writeFile(join(configured.root, 'operator-note.txt'), 'preserve');
      const pending = VoiceSpeechDiagnosticArtifactDownloadInitResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_INIT,
        {
          artifactId: exportArtifact.id,
          intent: 'user_confirmed_export',
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        },
      ));
      if (!pending.success) throw new Error(`diagnostics pending export init failed: ${pending.error}`);
      expect(VoiceSpeechDiagnosticsDeleteAllResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_DELETE_ALL,
        {},
      ))).toEqual({ ok: true });
      expect(VoiceSpeechDiagnosticArtifactDownloadChunkResponseV1Schema.parse(await runtime.request(
        RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_CHUNK,
        { downloadId: pending.downloadId, index: 0 },
      ))).toMatchObject({ success: false, errorCode: 'transfer_not_found' });
      expect((await readdir(configured.root)).sort()).toEqual(['CACHEDIR.TAG', 'operator-note.txt']);

      const serializedLogs = logs.join('\n');
      expect(serializedLogs).not.toContain('session-secret');
      expect(serializedLogs).not.toContain('provider-secret');
      expect(serializedLogs).not.toContain('attempt-after-restart');
      expect(serializedLogs).not.toContain(PCM_SHA256);
    } finally {
      await runtime.registration.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('exports only a confirmed committed artifact through the encrypted one-time transfer lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'voice-diagnostics-rpc-'));
    const audioPath = join(root, 'artifact.webm');
    await writeFile(audioPath, 'private-audio');
    const handlers = new Map<string, (value: unknown) => Promise<any>>();
    const registration = registerMachineVoiceDiagnosticsRpcHandlers({
      rpcHandlerManager: { registerHandler: (method: string, handler: any) => handlers.set(method, handler) } as any,
      diagnostics: {
        root,
        configure: vi.fn(), capture: vi.fn(), captureFile: vi.fn(), deleteAll: vi.fn(),
        status: vi.fn(),
        resolveArtifactForExport: async (artifactId: string) => artifactId === 'abcdef12-dead-beef' ? ({
          id: artifactId, createdAtMs: 42, direction: 'stt_input' as const, format: 'webm' as const,
          durationMs: null, byteLength: 13, audioPath, metadataPath: join(root, 'artifact.json'),
        }) : null,
        revokeCaptureAuthorization: vi.fn(),
      },
    });
    try {
      const recipient = createTransferRecipientKeyPair();
      const initMethod = handlers.get(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_INIT)!;
      expect(await initMethod({
        artifactId: '../../private', intent: 'user_confirmed_export',
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      })).toMatchObject({ success: false, errorCode: 'invalid_parameters' });
      expect(await initMethod({
        artifactId: 'abcdef12-dead-beef', recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      })).toMatchObject({ success: false, errorCode: 'invalid_parameters' });
      expect(await initMethod({
        artifactId: 'abcdef12-dead-beef', intent: 'user_confirmed_export', recipientPublicKeyBase64: 'a'.repeat(44),
      })).toMatchObject({ success: false, errorCode: 'invalid_parameters' });

      const init = await initMethod({
        artifactId: 'abcdef12-dead-beef', intent: 'user_confirmed_export',
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(init).toMatchObject({ success: true, sizeBytes: 13, name: 'voice-diagnostic-42-stt_input.webm' });
      const chunk = await handlers.get(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_CHUNK)!({
        downloadId: init.downloadId, index: 0,
      });
      expect(Buffer.from(decryptEncryptedTransferChunkEnvelope({
        transferId: init.downloadId,
        sequence: 0,
        payloadBase64: chunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
        recipientSecretKeySeed: recipient.recipientSecretKeySeed,
      })).toString('utf8')).toBe('private-audio');
      expect(await handlers.get(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_FINALIZE)!({
        downloadId: init.downloadId,
      })).toEqual({ success: true });

      const second = await initMethod({
        artifactId: 'abcdef12-dead-beef', intent: 'user_confirmed_export',
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      await handlers.get(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_DELETE_ALL)!({});
      expect(await handlers.get(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_CHUNK)!({
        downloadId: second.downloadId, index: 0,
      })).toMatchObject({ success: false, errorCode: 'transfer_not_found' });
    } finally {
      await registration.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates configuration and exposes status/delete without returning artifact paths', async () => {
    const handlers = new Map<string, (value: unknown) => Promise<unknown>>();
    const configure = vi.fn(async () => {});
    const deleteAll = vi.fn(async () => {});
    registerMachineVoiceDiagnosticsRpcHandlers({
      rpcHandlerManager: { registerHandler: (method: string, handler: any) => handlers.set(method, handler) } as any,
      diagnostics: {
        root: '/private/voice/diagnostics/v1',
        configure,
        status: async () => ({
          settings: {
            v: 1 as const, enabled: false, consentVersion: null,
            captureSttInput: false, captureTtsOutput: false,
            maxAgeMs: 86_400_000, maxFiles: 20, maxBytes: 104_857_600, maxDurationMs: 300_000,
          },
          artifacts: [{
            id: 'artifact-1', createdAtMs: 1, direction: 'stt_input' as const,
            format: 'webm' as const, durationMs: null, byteLength: 42,
          }],
          health: {
            captureFailure: false,
            cleanup: { status: 'healthy' as const, code: null, ownedEntryCount: 2 },
          },
          backupPolicy: { status: 'best_effort' as const, storage: 'private_cache' as const, mechanism: 'cachedir_tag' as const, automaticSync: 'not_implemented' as const },
        }),
        deleteAll,
        capture: vi.fn(),
        captureFile: vi.fn(),
        resolveArtifactForExport: vi.fn(),
        revokeCaptureAuthorization: vi.fn(),
      },
    });

    const invalid = await handlers.get(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE)?.({ settings: { enabled: true } });
    expect(invalid).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(configure).not.toHaveBeenCalled();

    const status = await handlers.get(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS)?.({});
    expect(status).toMatchObject({ ok: true, root: '/private/voice/diagnostics/v1' });
    expect(JSON.stringify(status)).not.toContain('audioPath');

    await handlers.get(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_DELETE_ALL)?.({});
    expect(deleteAll).toHaveBeenCalledOnce();
  });

  it('normalizes storage failures instead of rejecting the RPC handler', async () => {
    const handlers = new Map<string, (value: unknown) => Promise<unknown>>();
    registerMachineVoiceDiagnosticsRpcHandlers({
      rpcHandlerManager: { registerHandler: (method: string, handler: any) => handlers.set(method, handler) } as any,
      diagnostics: {
        root: '/private/voice/diagnostics/v1',
        configure: async () => { throw new Error('disk unavailable'); },
        status: async () => { throw new Error('disk unavailable'); },
        deleteAll: async () => { throw new Error('disk unavailable'); },
        capture: vi.fn(), captureFile: vi.fn(),
        resolveArtifactForExport: vi.fn(),
        revokeCaptureAuthorization: vi.fn(),
      },
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS)?.({}))
      .resolves.toMatchObject({ ok: false, errorCode: 'internal_error' });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_DELETE_ALL)?.({}))
      .resolves.toMatchObject({ ok: false, errorCode: 'internal_error' });
  });
});
