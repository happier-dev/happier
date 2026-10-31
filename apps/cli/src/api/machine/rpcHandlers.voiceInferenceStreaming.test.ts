import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createSpeechTranscriptionApplicationAuthorityDigestV1,
  DaemonVoiceInferenceSttStreamChunkRequestSchema,
  DaemonVoiceInferenceSttStreamChunkResponseSchema,
  type DaemonVoiceInferenceSttStreamEvent,
  ModelPackManifestSchema,
  FeaturesResponseSchema,
  PeerTcpTunnelRelayEnvelopeSchema,
  DaemonVoiceInferenceSttStreamStartResponseSchema,
  DaemonVoiceInferenceSttStreamStartRequestSchema,
  VoiceMediaApplicationAuthorityV1Schema,
  DaemonVoiceInferenceSttStreamFinishResponseSchema,
  DaemonVoiceInferenceSttStreamCancelResponseSchema,
  DaemonVoiceInferenceSttStreamStatusResponseSchema,
  createPeerTcpTunnelRelayAuthorizationSigningInputV2,
  createPeerApplicationAuthorityDigestV1,
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  type PeerTcpTunnelRelayEnvelope,
  type PeerTcpTunnelRelayAuthorizationV2,
  createDirectRouteGrantSigningInputV2,
  createEphemeralPeerRouteProofHandleV2,
  createPeerMachineRpcRequestHashV1,
  resolveMachineRpcRoutePolicy,
  type SignedDirectRouteGrantV2,
} from '@happier-dev/protocol';
import { PEER_MACHINE_RPC_DIRECT_PATH_V2, PeerMachineRpcDirectResponseV2Schema } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration, reloadConfiguration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resolveVoiceInferencePaths } from '@/daemon/voiceInference/voiceInferencePaths';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import type { VoiceInferenceRuntime, VoiceInferenceRuntimeTranscribeInput, VoiceInferenceStreamingTranscriptionSession as RuntimeStreamSession } from '@/daemon/voiceInference/voiceInferenceRuntimeTypes';

import { registerMachineVoiceInferenceStreamingRpcHandlers } from './rpcHandlers.voiceInferenceStreaming';
import { createVoiceDiagnosticsController } from '@/daemon/voiceDiagnostics/controller';
import { VoiceSpeechDiagnosticsSettingsV1Schema } from '@happier-dev/protocol/voice/diagnostics';

import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcHandler as Handler } from '../rpc/types';
import { registerMachinePeerTcpTunnelRelayRuntime } from '@/daemon/machine/registerMachinePeerTcpTunnelRelayRuntime';
import { openPeerTcpTunnelRelayStream } from '../../../../ui/sources/sync/domains/machines/peer/mediation/tunnel/relayStream';
import { createDaemonSpeechStreamTunnelTransport } from '../../../../ui/sources/voice/runtime/daemonInference/DaemonSpeechStreamTunnelTransport';
import { createDaemonSpeechStreamCarrierAdapter } from '../../../../ui/sources/voice/runtime/daemonInference/DaemonSpeechStreamCarrier';
import { createPeerMediationLoopbackApp } from '@/daemon/peer/mediation/loopback/server';
const originalSttMaxUploadBytes = process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES;

function speechApplicationAuthority(requestId: string) {
  return VoiceMediaApplicationAuthorityV1Schema.parse({
    v: 1,
    applicationKind: 'speech_transcription',
    applicationAttemptId: requestId,
    applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
  });
}

function createRpcHandlerManager(): RpcHandlerManager {
  return new RpcHandlerManager({
    scopePrefix: 'voice-inference-test',
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy',
    encryptionMode: 'plain',
    logger: () => {},
  });
}

function getHandler(manager: RpcHandlerManager, method: string): Handler | undefined {
  if (!manager.hasHandler(method)) return undefined;
  return async (params, context) => await manager.invokeLocal(method, params, {
    signal: context?.signal,
  });
}

const workers: VoiceInferenceWorkerHandle[] = [];
const registrations: Array<ReturnType<typeof registerMachineVoiceInferenceStreamingRpcHandlers>> = [];
const homes: string[] = [];
const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'voice-rpc-stream-home-'));
  homes.push(home);
  process.env.HAPPIER_HOME_DIR = home;
  reloadConfiguration();
  const packDir = join(resolveVoiceInferencePaths().packsRootDir, packId);
  const bytes = Buffer.from('native-stt-model-fixture');
  mkdirSync(packDir, { recursive: true });
  const manifest = ModelPackManifestSchema.parse({
    packId, kind: 'stt_sherpa', model: 'zipformer', version: '2023-02-17',
    files: [{
      path: 'model.onnx', url: 'https://example.test/model.onnx',
      sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength,
    }],
  });
  writeFileSync(join(packDir, 'pack.json'), JSON.stringify(manifest));
  writeFileSync(join(packDir, 'model.onnx'), bytes);
});

async function createWorker(runtime: Partial<VoiceInferenceRuntime>) {
  // Recognition/native stream sessions are the genuine engine boundary.
  const worker = await startVoiceInferenceWorker({
    runtimeLoader: async () => ({
      synthesizeTts: async () => { throw new Error('unused native synthesis'); },
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
      ...runtime,
    }),
  });
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  await Promise.all(registrations.splice(0).map((registration) => registration.dispose()));
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  reloadConfiguration();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (originalSttMaxUploadBytes === undefined) {
    delete process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES;
  } else {
    process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = originalSttMaxUploadBytes;
  }
});

describe('registerMachineVoiceInferenceStreamingRpcHandlers', () => {
  it('drains compatibility PCM in sequence when RPC authorization settles out of order', async () => {
    const received: number[] = [];
    const worker = await createWorker({
      createStreamingTranscriptionSession: async () => ({
        appendPcm16: async ({ seq }) => { received.push(seq); return { events: [] }; },
        finish: async () => ({ text: 'heard in order', language: 'en', events: [] }),
        cancel: async () => {}, close: async () => {},
      }),
    });
    let releaseFirst!: () => void;
    const firstAdmission = new Promise<void>(resolve => { releaseFirst = resolve; });
    let observeSecond!: () => void;
    const secondAdmission = new Promise<void>(resolve => { observeSecond = resolve; });
    // Home authorization is a real network boundary; registration, RPC decoding,
    // stream ordering, worker dispatch and strict response consumers stay real.
    const manager = new RpcHandlerManager({
      scopePrefix: 'voice-inference-test', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: async ({ params }) => {
        const chunk = DaemonVoiceInferenceSttStreamChunkRequestSchema.parse(params);
        if (chunk.seq === 0) await firstAdmission;
        else observeSecond();
        return { ok: true };
      },
    });
    registrations.push(registerMachineVoiceInferenceStreamingRpcHandlers({ rpcHandlerManager: manager, voiceInferenceWorker: worker }));
    const started = DaemonVoiceInferenceSttStreamStartResponseSchema.parse(await manager.invokeLocal(
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START,
      { requestId: 'reordered-authorization', packId, language: 'en', streamingMode: 'runtime' },
    ));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('Stream did not start');
    const append = (seq: number) => manager.handleRequest({
      method: `voice-inference-test:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK}`,
      params: DaemonVoiceInferenceSttStreamChunkRequestSchema.parse({
        streamId: started.streamId, generation: started.generation, seq, pcm16Base64: 'AAABAA==',
      }),
    });
    const first = append(0);
    const second = append(1);
    await secondAdmission;
    // Let the later admitted request reach the registered handler before the
    // network releases the first request, without imposing a product deadline.
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseFirst();
    const replies = await Promise.all([first, second]);
    expect(replies.map(reply => DaemonVoiceInferenceSttStreamChunkResponseSchema.parse(reply)))
      .toMatchObject([{ ok: true }, { ok: true }]);
    expect(received).toEqual([0, 1]);
    expect(DaemonVoiceInferenceSttStreamFinishResponseSchema.parse(await manager.invokeLocal(
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH,
      { streamId: started.streamId, generation: started.generation, finalSeq: 1 },
    ))).toMatchObject({ ok: true, finalText: 'heard in order' });
  });

  it('authenticates and drains Voice relay PCM when generic TCP relay is disabled', async () => {
    const received: Uint8Array[] = [];
    const worker = await createWorker({
      createStreamingTranscriptionSession: async () => ({
        appendPcm16: async ({ pcm16Bytes }) => { received.push(new Uint8Array(pcm16Bytes)); return { events: [] }; },
        finish: async () => ({ text: 'heard', language: 'en', events: [] }),
        cancel: async () => {}, close: async () => {},
      }),
    });
    const manager = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({ rpcHandlerManager: manager, voiceInferenceWorker: worker });
    registrations.push(registration);
    const keys = tweetnacl.sign.keyPair();
    const requestId = 'voice-only-relay';
    const payload: PeerTcpTunnelRelayAuthorizationV2['payload'] = {
      v: 2, grantId: 'voice-grant', accountId: 'voice-account', targetMachineId: 'voice-machine',
      flowKind: 'voice_media', routeKind: 'server_relay', tunnelId: 'voice-only-tunnel',
      applicationKind: 'speech_transcription', applicationAttemptId: requestId,
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
      relaySocketId: 'voice-viewer', destination: { host: '127.0.0.1', port: 3000 },
      capProfileId: 'interactive', maxFrameBytes: 65536, maxIdleMs: 30000,
      maxDurationMs: 300000, maxTotalBytes: 8388608, iat: 1000, exp: 301000,
      aud: 'happier-tcp-tunnel-relay-authorization',
    };
    const authorization: PeerTcpTunnelRelayAuthorizationV2 = { payload, signature: {
      keyId: 'voice-key', alg: 'Ed25519', valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        new TextEncoder().encode(createPeerTcpTunnelRelayAuthorizationSigningInputV2(payload)), keys.secretKey,
      )).toString('base64url'),
    } };
    const features = FeaturesResponseSchema.parse({ features: { machines: { enabled: true,
      tunnel: { enabled: true, serverRouted: { enabled: false } },
      liveStream: { enabled: true, serverRouted: { enabled: true } },
    } }, capabilities: { machines: { peerMediation: { grantSigningKeys: [{
      keyId: 'voice-key', publicKey: Buffer.from(keys.publicKey).toString('base64url'), expiresAt: 301000,
    }] } } } });
    let receiveAtDaemon: ((envelope: PeerTcpTunnelRelayEnvelope) => void | Promise<void>) | undefined;
    const clientListeners = new Set<(envelope: PeerTcpTunnelRelayEnvelope) => void>();
    const errors: unknown[] = [];
    const relay = registerMachinePeerTcpTunnelRelayRuntime({
      accountId: payload.accountId, machineId: payload.targetMachineId, serverFeatures: features, nowMs: () => 2000,
      voiceBinaryAppendConsumer: registration.appendSttStreamBinaryFrame,
      voiceBinaryTerminalConsumer: registration.cancelSttStreamForTransportLoss,
      eventPort: {
        subscribe: listener => { receiveAtDaemon = listener; return () => { receiveAtDaemon = undefined; }; },
        emit: envelope => { for (const listener of clientListeners) listener(PeerTcpTunnelRelayEnvelopeSchema.parse(envelope)); },
      },
      onHandlerError: error => { errors.push(error); },
    });
    const direct = createPeerMediationLoopbackApp({
      nowMs: () => 2000,
      expected: { accountId: payload.accountId, machineId: payload.targetMachineId,
        flowKind: 'machine_rpc', routeKind: 'loopback_direct', endpointFingerprint: 'speech-endpoint' },
      trustRoots: [{ keyId: 'voice-key', publicKey: Buffer.from(keys.publicKey).toString('base64url') }],
      rpc: { rpcHandlerManager: manager },
    });
    const invokeDirect = async (method: string, params: unknown) => {
      const proofHandle = createEphemeralPeerRouteProofHandleV2({
        randomBytes: length => new Uint8Array(length).fill(8),
      });
      try {
        const grantPayload: SignedDirectRouteGrantV2['payload'] = {
          v: 2, grantId: `speech:${method}`, accountId: payload.accountId, machineId: payload.targetMachineId,
          flowKind: 'machine_rpc', routeKind: 'loopback_direct', endpointFingerprint: 'speech-endpoint',
          scope: { kind: 'machine_rpc', rpcScopeId: method, allowedMethods: [method], maxCalls: 1, maxIdleMs: 30000 },
          iat: 1000, exp: 301000, aud: 'happier-daemon-route-grant', proofKind: 'ephemeral_ed25519',
          ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url,
        };
        const grant: SignedDirectRouteGrantV2 = { payload: grantPayload, signature: {
          keyId: 'voice-key', alg: 'Ed25519', valueBase64Url: Buffer.from(tweetnacl.sign.detached(
            new TextEncoder().encode(createDirectRouteGrantSigningInputV2(grantPayload)), keys.secretKey,
          )).toString('base64url'),
        } };
        const requestHash = createPeerMachineRpcRequestHashV1({ method, params,
          grantId: grantPayload.grantId, endpointFingerprint: 'speech-endpoint', replayKey: method });
        const response = await direct.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2, payload: {
          v: 2, requestId: method, method, params, grant, proof: proofHandle.sign(grant),
          routeKind: 'loopback_direct', flowKind: 'machine_rpc', endpointFingerprint: 'speech-endpoint',
          ...(resolveMachineRpcRoutePolicy(method).commandReceiptRequired ? { commandReceipt: {
            v: 1, issuer: 'ui', issuedAtMs: 2000, requestHash, replayKey: method,
          } } : {}),
        } });
        expect(response.statusCode).toBe(200);
        // This is the same strict consumer used before capture by productionRoute.
        // Keep the real HTTP serialization, signed route, RPC and worker beneath it.
        const parsed = PeerMachineRpcDirectResponseV2Schema.parse(response.json());
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error(parsed.reasonCode);
        return parsed.result;
      } finally { proofHandle.dispose(); }
    };
    try {
      expect(relay).not.toBeNull();
      const stream = await openPeerTcpTunnelRelayStream({
        scopeUserId: payload.accountId, relaySocketId: payload.relaySocketId,
        open: { v: 1, kind: 'open', tunnelId: payload.tunnelId, targetMachineId: payload.targetMachineId,
          routeKind: 'server_relay', destination: payload.destination,
          selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2, relayAuthorization: authorization },
        send: (_event, envelope) => { void receiveAtDaemon?.(PeerTcpTunnelRelayEnvelopeSchema.parse(envelope)); },
        onEnvelope: listener => { clientListeners.add(listener); return () => { clientListeners.delete(listener); }; },
      });
      const transport = createDaemonSpeechStreamTunnelTransport({
        tunnelId: payload.tunnelId, stream,
        peerApplicationEncryption: { v: 1, suite: 'aes-256-gcm', flowKind: 'voice_media', routeKind: 'server_relay',
          authorityDigest: createPeerApplicationAuthorityDigestV1(authorization), accountId: payload.accountId,
          machineId: payload.targetMachineId, tunnelId: payload.tunnelId, applicationKind: 'speech_transcription',
          applicationAttemptId: requestId, applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId) },
        controlTransport: {
          start: async request => DaemonVoiceInferenceSttStreamStartResponseSchema.parse(await invokeDirect(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START, request)),
          finish: async request => DaemonVoiceInferenceSttStreamFinishResponseSchema.parse(await invokeDirect(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH, request)),
          cancel: async request => DaemonVoiceInferenceSttStreamCancelResponseSchema.parse(await invokeDirect(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL, request)),
        },
      });
      const started = await transport.start(DaemonVoiceInferenceSttStreamStartRequestSchema.parse({ requestId, packId, language: 'en', streamingMode: 'runtime' }));
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      const pcm = new Uint8Array([0, 0, 255, 127, 0, 128]);
      const carrier = createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: true });
      expect(await transport.chunk({ streamId: started.streamId, generation: started.generation, seq: 0,
        carrierFrame: carrier.encodeInputAppendFrame({ streamId: started.streamId, generation: started.generation, seq: 0, pcm16Bytes: pcm }),
        compatibilityTransport: null })).toMatchObject({ ok: true, ackSeq: 0 });
      expect(received).toEqual([pcm]);
      expect(await transport.finish({ streamId: started.streamId, generation: started.generation, finalSeq: 0 }))
        .toMatchObject({ ok: true, finalText: 'heard', ackSeq: 0 });
      expect(errors).toEqual([]);
      await stream.close();
    } finally { await direct.close(); await relay?.dispose(); }
  });

  it('cancels the exact authority-bound stream once when its peer transport is lost', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const worker = await createWorker({
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
      createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
    });
    const cancelStt = vi.spyOn(worker, 'cancelStt');
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
    const requestId = 'transport-loss-request';
    const authority = {
      v: 1 as const,
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: requestId,
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
    };
    const started = await sttStreamStart?.({
      requestId,
      packId,
      language: null,
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, generation: 0 });

    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: started.streamId,
      generation: started.generation,
      voiceMediaApplicationAuthority: {
        ...authority,
        applicationAttemptId: 'another-request',
        applicationAuthorityDigest:
          createSpeechTranscriptionApplicationAuthorityDigestV1('another-request'),
      },
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: true, state: 'open' });

    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: started.streamId,
      generation: started.generation,
      voiceMediaApplicationAuthority: authority,
    })).resolves.toMatchObject({ ok: true });
    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: started.streamId,
      generation: started.generation,
      voiceMediaApplicationAuthority: authority,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('cancels the authority-bound stream when transport is lost before its first carrier frame', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const worker = await createWorker({
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
      createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
    });
    const cancelStt = vi.spyOn(worker, 'cancelStt');
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
    const requestId = 'transport-loss-before-first-frame';
    const authority = {
      v: 1 as const,
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: requestId,
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
    };
    const started = await sttStreamStart?.({
      requestId,
      packId,
      language: null,
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, generation: 0 });

    const lossResult = await registration.cancelSttStreamForTransportLoss({
      voiceMediaApplicationAuthority: authority,
    });
    if (!lossResult.ok) {
      await registration.cancelSttStreamForTransportLoss({
        streamId: started.streamId,
        generation: started.generation,
        voiceMediaApplicationAuthority: authority,
      });
    }
    expect(lossResult).toMatchObject({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
    });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('binds transport-loss cleanup to signed application authority instead of forged carrier identity', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const worker = await createWorker({
      transcribeAudio: async () => { throw new Error('unused native recognition'); },
      createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
    });
    const cancelStt = vi.spyOn(worker, 'cancelStt');
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
    const requestId = 'transport-loss-forged-carrier';
    const authority = {
      v: 1 as const,
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: requestId,
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
    };
    const started = await sttStreamStart?.({
      requestId,
      packId,
      language: null,
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, generation: 0 });

    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: 'forged-carrier-stream',
      generation: started.generation + 1,
      voiceMediaApplicationAuthority: authority,
    })).resolves.toMatchObject({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
    });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('streams daemon STT PCM chunks into a canonical wav file and transcribes through the worker on finish', async () => {
    let observedInput: VoiceInferenceRuntimeTranscribeInput | null = null;
    const transcribeAudio = vi.fn(async (input: NonNullable<typeof observedInput>) => {
      observedInput = input;
      const wav = readFileSync(input.filePath);
      expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(16_000);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
      expect(wav.readUInt32LE(40)).toBe(4);
      expect(wav.subarray(44).equals(Buffer.from([0, 0, 1, 0]))).toBe(true);
      return {
        requestId: input.requestId,
        text: 'streamed daemon transcript',
        language: input.language,
        modelPackId: input.packId,
      };
    });
    const worker = await createWorker({
      transcribeAudio,
    });
    const diagnostics = createVoiceDiagnosticsController({ happyHomeDir: configuration.happyHomeDir });
    await diagnostics.configure(VoiceSpeechDiagnosticsSettingsV1Schema.parse({
      enabled: true, consentVersion: 1, captureSttInput: true,
    }));
    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
      voiceDiagnostics: diagnostics,
    }));

    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamChunk = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK);
    const sttStreamFinish = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);
    const sttStreamStatus = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-1',
      packId,
      language: 'en',
      streamingMode: 'upload_bridge',
      diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null,
        authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    });
    expect(started).toEqual(expect.objectContaining({
      ok: true,
      requestId: 'stream-request-1',
      streamId: expect.any(String),
      generation: 0,
      ackSeq: -1,
    }));
    await expect(sttStreamChunk?.({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Base64: Buffer.from([0, 0, 1, 0]).toString('base64'),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [],
    });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      state: 'open',
    });
    await expect(sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      finalText: 'streamed daemon transcript',
      language: 'en',
      modelPackId: packId,
      events: [{ type: 'final', seq: 0, text: 'streamed daemon transcript', language: 'en', modelPackId: packId }],
    });
    expect(observedInput).toMatchObject({
      requestId: 'stream-request-1',
      inputMimeType: 'audio/wav',
      packId,
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'ui_pretranscoded_pcm16_fallback',
        systemFfmpegAllowed: false,
      },
    });
    await vi.waitFor(async () => {
      const status = await diagnostics.status();
      expect(status.health.captureFailure).toBe(false);
      expect(status.artifacts).toHaveLength(1);
      const artifact = await diagnostics.resolveArtifactForExport(status.artifacts[0]!.id);
      expect(artifact).not.toBeNull();
      expect(readFileSync(artifact!.audioPath).subarray(44)).toEqual(Buffer.from([0, 0, 1, 0]));
    });
  });

  it('accepts raw PCM16 bytes through the binary append consumer without parsing the compatibility chunk schema', async () => {
    const transcribeAudio = vi.fn(async (input: { filePath: string; requestId: string; language: string | null; packId: string | null }) => {
      const wav = readFileSync(input.filePath);
      expect(wav.readUInt32LE(40)).toBe(4);
      expect([...wav.subarray(44)]).toEqual([0, 0, 1, 0]);
      return {
        requestId: input.requestId,
        text: 'binary daemon transcript',
        language: input.language,
        modelPackId: input.packId,
      };
    });
    const worker = await createWorker({
      transcribeAudio,
    });
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamFinish = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);
    const safeParseSpy = vi.spyOn(DaemonVoiceInferenceSttStreamChunkRequestSchema, 'safeParse');

    const started = await sttStreamStart?.({
      requestId: 'stream-request-binary',
      packId,
      language: 'en',
      streamingMode: 'upload_bridge',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0, ackSeq: -1 });
    safeParseSpy.mockClear();

    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-binary'),
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0, 1, 0]),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [],
    });
    expect(safeParseSpy).not.toHaveBeenCalled();

    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-binary'),
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([9, 9, 9, 9]),
    })).resolves.toMatchObject({
      ok: true,
      ackSeq: 0,
    });
    await expect(sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toMatchObject({
      ok: true,
      ackSeq: 0,
      finalText: 'binary daemon transcript',
    });
  });

  it('emits runtime streaming partial and endpoint events before finish and final events on finish', async () => {
    const runtimeEvents: DaemonVoiceInferenceSttStreamEvent[][] = [];
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async (input) => {
        expect(input.seq).toBe(0);
        expect([...input.pcm16Bytes]).toEqual([0, 0, 1, 0]);
        const events: DaemonVoiceInferenceSttStreamEvent[] = [
          { type: 'partial', seq: input.seq, text: 'hel', isEndpoint: false, confidence: null },
          { type: 'endpoint', seq: input.seq, transcript: 'hello', reason: 'vad' },
        ];
        runtimeEvents.push(events);
        return { events };
      }),
      finish: vi.fn(async (input) => {
        expect(input.finalSeq).toBe(0);
        const events: DaemonVoiceInferenceSttStreamEvent[] = [{ type: 'final', seq: 0, text: 'hello world', language: 'en', modelPackId: packId }];
        runtimeEvents.push(events);
        return { text: 'hello world', language: 'en', events };
      }),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const transcribeAudio = vi.fn(async () => {
      throw new Error('runtime_mode_must_not_batch_transcribe');
    });
    const createStreamingTranscriptionSession = vi.fn(async () => runtimeSession);
    const worker = await createWorker({
      transcribeAudio,
      createStreamingTranscriptionSession,
    });
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamFinish = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-runtime',
      packId,
      language: 'en',
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0, ackSeq: -1 });

    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-runtime'),
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0, 1, 0]),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [
        { type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null },
        { type: 'endpoint', seq: 0, transcript: 'hello', reason: 'vad' },
      ],
    });

    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-runtime'),
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([9, 9, 9, 9]),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [],
    });

    await expect(sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      finalText: 'hello world',
      language: 'en',
      modelPackId: packId,
      events: [{ type: 'final', seq: 0, text: 'hello world', language: 'en', modelPackId: packId }],
    });

    expect(createStreamingTranscriptionSession).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'stream-request-runtime',
      packId,
      language: 'en',
    }));
    expect(runtimeSession.appendPcm16).toHaveBeenCalledTimes(1);
    expect(runtimeSession.finish).toHaveBeenCalledTimes(1);
    expect(runtimeSession.close).toHaveBeenCalledTimes(1);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(runtimeEvents.map((events) => (events[0] as { type: string }).type)).toEqual(['partial', 'final']);
  });

  it('fails closed when runtime streaming is requested but the worker cannot create a stream', async () => {
    const worker = await createWorker({
      transcribeAudio: vi.fn(async () => {
        throw new Error('unused');
      }),
    });
    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);

    await expect(sttStreamStart?.({
      requestId: 'stream-runtime-unavailable',
      packId,
      language: 'en',
      streamingMode: 'runtime',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'runtime_unavailable',
    });
  });

  it('fails closed when streaming mode is omitted at the RPC boundary', async () => {
    const worker = await createWorker({
      transcribeAudio: vi.fn(async () => {
        throw new Error('omitted_mode_must_not_upload_bridge');
      }),
    });
    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);

    await expect(sttStreamStart?.({
      requestId: 'stream-mode-omitted',
      packId,
      language: 'en',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_stream_state',
    });
  });

  it('cancels runtime streaming sessions and rejects mismatched generation appends', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const worker = await createWorker({
      transcribeAudio: vi.fn(async () => {
        throw new Error('unused');
      }),
      createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
    });
    const cancelStt = vi.spyOn(worker, 'cancelStt');
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamCancel = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL);

    const started = await sttStreamStart?.({
      requestId: 'stream-runtime-cancel',
      packId,
      language: 'en',
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });

    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-runtime-cancel'),
      streamId: started.streamId,
      generation: started.generation + 1,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });

    await expect(sttStreamCancel?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
    });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledWith('stream-runtime-cancel');
  });

  it('rejects binary append stream identity, ordering, PCM and lifecycle violations', async () => {
    const finishRelease = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    })();
    const worker = await createWorker({
      transcribeAudio: vi.fn(async () => {
        await finishRelease.promise;
        return { requestId: 'stream-request-binary-negative', text: '', language: null, modelPackId: null };
      }),
    });
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    });
    registrations.push(registration);
    const sttStreamStart = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamFinish = getHandler(mgr, RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-binary-negative',
      packId,
      language: null,
      streamingMode: 'upload_bridge',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });

    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-binary-negative'),
      streamId: 'missing-stream',
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-binary-negative'),
      streamId: started.streamId,
      generation: started.generation + 1,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-binary-negative'),
      streamId: started.streamId,
      generation: started.generation,
      seq: 1,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-binary-negative'),
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-binary-negative'),
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });

    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-binary-negative'),
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: true, ackSeq: 0 });
    const finishing = sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    });
    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-binary-negative'),
      streamId: started.streamId,
      generation: started.generation,
      seq: 1,
      pcm16Bytes: new Uint8Array([1, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    finishRelease.resolve();
    await expect(finishing).resolves.toMatchObject({ ok: true });
    await expect(registration.appendSttStreamBinaryFrame({
      voiceMediaApplicationAuthority: speechApplicationAuthority('stream-request-binary-negative'),
      streamId: started.streamId,
      generation: started.generation,
      seq: 1,
      pcm16Bytes: new Uint8Array([1, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
  });

  it.each(['upload_bridge', 'runtime'] as const)('expires abandoned %s STT streams and releases native resources', async (streamingMode) => {
    vi.useFakeTimers();
    const nativeState = { cancelled: false, closed: false };
    const worker = await createWorker({
      createStreamingTranscriptionSession: async () => ({
        appendPcm16: async () => ({ events: [] }),
        finish: async () => ({ text: '', language: null, events: [] }),
        cancel: async () => { nativeState.cancelled = true; },
        close: async () => { nativeState.closed = true; },
      }),
    });
    const mgr = createRpcHandlerManager();
    registrations.push(registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr,
      voiceInferenceWorker: worker,
    }));

    const started = DaemonVoiceInferenceSttStreamStartResponseSchema.parse(await mgr.invokeLocal(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START, {
      requestId: 'stream-request-expire',
      packId,
      language: 'en',
      streamingMode,
    }));
    if (!started.ok) throw new Error('Stream did not start');
    const address = { streamId: started.streamId, generation: started.generation };
    const chunk = { ...address, seq: 0, pcm16Base64: 'AAAAAA==' };
    expect(DaemonVoiceInferenceSttStreamChunkResponseSchema.parse(await mgr.invokeLocal(
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK, chunk,
    ))).toMatchObject({ ok: true, ackSeq: 0 });

    expect(DaemonVoiceInferenceSttStreamStatusResponseSchema.parse(await mgr.invokeLocal(
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS, address,
    ))).toMatchObject({ ok: true, state: 'open', ackSeq: 0 });
    expect(nativeState).toEqual({ cancelled: false, closed: false });

    await vi.advanceTimersByTimeAsync(configuration.filesTransferSessionTtlMs + 1);

    expect(DaemonVoiceInferenceSttStreamStatusResponseSchema.parse(await mgr.invokeLocal(
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS, address,
    ))).toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(DaemonVoiceInferenceSttStreamChunkResponseSchema.parse(await mgr.invokeLocal(
      RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK, { ...chunk, seq: 1 },
    ))).toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(nativeState).toEqual({ cancelled: streamingMode === 'runtime', closed: streamingMode === 'runtime' });
    // The expiry warning schedules the logger's independent buffered flush.
    logger.flushSync();
    expect(vi.getTimerCount()).toBe(0);
  });
});
