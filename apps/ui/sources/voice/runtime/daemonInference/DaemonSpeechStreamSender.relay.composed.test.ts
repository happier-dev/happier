import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { waitForTestEvent } from '@/dev/testkit';
import tweetnacl from 'tweetnacl';
import { createPeerTcpTunnelApplicationSubstreamSession } from '@happier-dev/peer-transport';
import { decodePeerTcpTunnelBinaryFrameV2} from '@happier-dev/protocol/machines/peer/mediation/tunnel/v2';
import { PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2} from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import {
  PeerTcpTunnelRelayEnvelopeSchema,
  type PeerTcpTunnelRelayEnvelope} from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import { createSpeechTranscriptionApplicationAuthorityDigestV1, type VoiceMediaApplicationAuthorityV1 } from '@happier-dev/protocol/machines/peer/mediation/voiceMediaV1';
import { MACHINE_STREAM_KEY_TAG_BYTES_V1, createMachineStreamKeyAadV1, createMachineStreamKeyNonceV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import { decodeBase64 } from '@/encryption/base64';
import { sealAes256GcmBytes } from '@/encryption/aes256GcmBytes';
import {
  createPeerTcpTunnelRelayAuthorizationSigningInputV2} from '@happier-dev/protocol/machines/peer/mediation/tunnel/authorizationSchemas';
import {
  DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT, DaemonVoiceInferenceSttStreamChunkResponseSchema, DaemonVoiceInferenceSttStreamFinishResponseSchema} from '@happier-dev/protocol/daemon/voiceInference';
import { openPeerTcpTunnelRelayStream } from '@/sync/domains/machines/peer/mediation/tunnel/relayStream';
import { createVoiceInferenceSpeechStreamManager } from '../../../../../cli/src/daemon/voiceInference/streaming/voiceInferenceSpeechStreamManager';
import { dispatchDaemonVoiceInferenceSttBinaryAppend } from '../../../../../cli/src/daemon/peer/mediation/tunnel/voiceBinaryAppend';
import { createDaemonSpeechStreamSender } from './DaemonSpeechStreamSender';
import { createDaemonSpeechStreamCarrierAdapter } from './DaemonSpeechStreamCarrier';
import { createDaemonSpeechStreamTunnelTransport } from './DaemonSpeechStreamTunnelTransport';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

// Cross-app source composition stays in the documented .composed. test category.
describe('sender → Account-mode relay framing → daemon STT intake', () => {
  it.each([
    { contentMode: 'e2ee', holdNativeAdmission: false, nativeFailure: false, slowPhase: null },
    { contentMode: 'plain', holdNativeAdmission: false, nativeFailure: false, slowPhase: null },
    { contentMode: 'e2ee', holdNativeAdmission: true, nativeFailure: false, slowPhase: null },
    { contentMode: 'e2ee', holdNativeAdmission: false, nativeFailure: true, slowPhase: null },
    { contentMode: 'e2ee', holdNativeAdmission: false, nativeFailure: false, slowPhase: 'append' },
    { contentMode: 'e2ee', holdNativeAdmission: false, nativeFailure: false, slowPhase: 'finish' },
  ] as const)('preserves capture and native outcomes in the Account content mode %j', async ({ contentMode, holdNativeAdmission, nativeFailure, slowPhase }) => {
    const streamRoot = await mkdtemp(join(tmpdir(), 'happier-df66-intake-'));
    const events = new EventTarget();
    const notify = () => events.dispatchEvent(new Event('transport'));
    const subscribe = (listener: () => void) => {
      events.addEventListener('transport', listener);
      return () => events.removeEventListener('transport', listener);
    };
    const received: Uint8Array[] = [];
    const nativeAppends: Array<() => void> = [];
    const terminalReasons: string[] = [];
    const binding = { flowKind: 'voice_media' as const, routeKind: 'server_relay' as const,
      accountId: 'account', machineId: 'machine', tunnelId: 'tunnel' };
    const authority: VoiceMediaApplicationAuthorityV1 = { v: 1, applicationKind: 'speech_transcription',
      applicationAttemptId: 'request', applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('request') };
    // Every Voice payload the relay (server) can observe, per direction.
    const relayObserved = { clientToDaemon: [] as Uint8Array[], daemonToClient: [] as Uint8Array[] };
    const manager = createVoiceInferenceSpeechStreamManager({ streamRoot,
      // The native worker process is the boundary. Intake, encryption, framing,
      // sequence admission, acknowledgement and finalization stay real.
      voiceInferenceWorker: {
        transcribeAudio: async () => { throw new Error('batch STT must not run'); }, cancelStt: async () => {},
        createStreamingTranscriptionSession: async () => ({ modelPackId: 'pack',
          appendPcm16: async ({ pcm16Bytes, seq, signal }) => { received.push(new Uint8Array(pcm16Bytes));
            if (nativeFailure) throw Object.assign(new Error('native append cancelled'), { code: 'cancelled' });
            // A genuine native/process boundary can answer after the old private
            // 10s cutoff while still inside the canonical Machine operation budget.
            if (slowPhase === 'append') await delay(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS / 2, undefined, { signal: signal ?? undefined });
            if (holdNativeAdmission && pcm16Bytes.byteLength > 640) {
              await new Promise<void>(resolve => { nativeAppends.push(resolve); notify(); });
            }
            return {
            events: [{ type: 'partial', seq, text: String(seq), isEndpoint: false, confidence: null }],
          }; },
          finish: async ({ signal }) => {
            if (slowPhase === 'finish') await delay(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS / 2, undefined, { signal: signal ?? undefined });
            return { text: 'complete', language: 'en', events: [] };
          }, cancel: async () => {}, close: async () => {},
        }),
      },
    });
    let receive: ((envelope: PeerTcpTunnelRelayEnvelope) => void) | undefined;
    let holdReplies = false;
    const replies: Array<() => void> = [];
    const operations: Promise<unknown>[] = [];
    let chunkRequests = 0;
    let sentDataFrames = 0;
    const maxFrameBytes = 64 * 1024;
    const destination = { host: '127.0.0.1', port: 3000 };
    const authorizationPayload = { v: 2 as const, grantId: 'grant', accountId: binding.accountId,
      targetMachineId: binding.machineId, flowKind: binding.flowKind, routeKind: binding.routeKind,
      tunnelId: binding.tunnelId, relaySocketId: 'tab', destination, capProfileId: 'interactive', maxFrameBytes,
      applicationKind: authority.applicationKind, applicationAttemptId: authority.applicationAttemptId,
      applicationAuthorityDigest: authority.applicationAuthorityDigest,
      iat: 1, exp: 60_001, aud: 'happier-tcp-tunnel-relay-authorization' as const,
    };
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
    const relayAuthorization = { payload: authorizationPayload, signature: { keyId: 'fixture', alg: 'Ed25519' as const,
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(new TextEncoder().encode(createPeerTcpTunnelRelayAuthorizationSigningInputV2(authorizationPayload)), key.secretKey)).toString('base64url'),
    } };
    const application = createPeerTcpTunnelApplicationSubstreamSession({ tunnelId: binding.tunnelId,
      maxBinaryHeaderBytes: maxFrameBytes, maxFrameBytes, maxConcurrentSubstreams: 1,
      onTerminal: async ({ reasonCode }) => { terminalReasons.push(reasonCode); },
      sendBinaryFrame: async frame => {
        const decoded = decodePeerTcpTunnelBinaryFrameV2({ frame, maxHeaderBytes: maxFrameBytes, maxPayloadBytes: maxFrameBytes });
        expect(decoded.ok).toBe(true);
        if (decoded.ok && decoded.header.kind === 'data') relayObserved.daemonToClient.push(new Uint8Array(decoded.payload));
        if (decoded.ok && decoded.header.kind === 'data' && holdReplies) await new Promise<void>(resolve => { replies.push(resolve); notify(); });
        receive?.(PeerTcpTunnelRelayEnvelopeSchema.parse({ v: 2, scopeUserId: binding.accountId,
          sender: { kind: 'machine', machineId: binding.machineId }, recipient: { kind: 'user', socketId: 'tab' },
          encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2, frame,
        }));
      },
    });
    const stream = await openPeerTcpTunnelRelayStream({ scopeUserId: binding.accountId, relaySocketId: 'tab',
      open: { v: 1, kind: 'open', tunnelId: binding.tunnelId, targetMachineId: binding.machineId,
        routeKind: 'server_relay', destination, relayAuthorization,
        selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 },
      onEnvelope: handler => { receive = handler; return () => { receive = undefined; }; },
      send: (_event, envelope) => {
        const strict = PeerTcpTunnelRelayEnvelopeSchema.parse(envelope);
        if (strict.v !== 2) return;
        const decoded = decodePeerTcpTunnelBinaryFrameV2({ frame: strict.frame, maxHeaderBytes: maxFrameBytes, maxPayloadBytes: maxFrameBytes });
        if (!decoded.ok || decoded.header.kind !== 'data') return;
        sentDataFrames++;
        relayObserved.clientToDaemon.push(new Uint8Array(decoded.payload));
        notify();
        operations.push(application.acceptBinaryFrame(strict.frame, async ({ payload }) => {
          let response: Uint8Array | null = null;
          const handled = await dispatchDaemonVoiceInferenceSttBinaryAppend({
            header: decoded.header, payload, voiceMediaApplicationAuthority: authority,
            consumer: input => manager.appendTunnelFrame(input),
            onResponse: value => {
              if (contentMode === 'e2ee' && !(value instanceof Uint8Array)) throw new Error('sealed response required');
              response = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
            },
          });
          expect(handled).toBe(true);
          return response;
        }));
      },
    });
    const transport = createDaemonSpeechStreamTunnelTransport({ tunnelId: binding.tunnelId, stream, maxFrameBytes,
      ...(slowPhase ? {} : { responseTimeoutMs: 500 }),
      controlTransport: {
        // The RPC owner's content mode decides key issuance (registration reads it).
        startWithContentMode: async input => ({ contentMode,
          response: await manager.start(input, undefined, { issueStreamKey: contentMode === 'e2ee' }) }),
        finish: manager.finish, cancel: manager.cancel,
      },
    });
    const sender = createDaemonSpeechStreamSender({ requestId: 'request', packId: 'pack', transport: {
      ...transport,
      chunk: input => { chunkRequests++; return transport.chunk(input); },
    },
      carrierAdapter: createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: true }),
    });
    try {
      await sender.start();
      if (nativeFailure) {
        const failure = await sender.pushChunk(new Uint8Array(640)).then(() => null, (error: unknown) => error);
        expect(failure).toMatchObject({ code: 'cancelled', cause: { ok: false, errorCode: 'cancelled', diagnostic: { code: 'cancelled' } } });
        await Promise.all(operations);
        return;
      }
      if (slowPhase) {
        await expect(sender.pushChunk(new Uint8Array(640))).resolves.toMatchObject([{ type: 'partial', seq: 0 }]);
        const result = DaemonVoiceInferenceSttStreamFinishResponseSchema.parse(await sender.finish());
        expect(result).toMatchObject({ ok: true, finalText: 'complete', ackSeq: 0 });
        expect(terminalReasons).toEqual([]);
        await Promise.all(operations);
        return;
      }
      holdReplies = true;
      const expected: Uint8Array[] = [];
      const outcomes: Promise<unknown>[] = [];
      for (let frame = 0; frame < 425; frame++) {
        const pcm = new Uint8Array(640).fill(frame % 256);
        expected.push(pcm);
        outcomes.push(sender.pushChunk(pcm).then(events => events, (error: unknown) => ({ error })));
      }
      let finished = false;
      const finish = sender.finish().then(result => { finished = true; notify(); return { result }; }, (error: unknown) => { finished = true; notify(); return { error }; });
      if (holdNativeAdmission) {
        // The initial response window fills before coalesced packets are sent.
        await waitForTestEvent(subscribe, () => expect(replies.length).toBe(8));
        for (const release of replies.splice(0)) release();
        await Promise.all(outcomes.slice(0, 8));
        // Let settled response callbacks pump their next packets, then wait for
        // those asynchronous encrypted sends at the actual relay boundary.
        await new Promise<void>(resolve => setImmediate(resolve));
        await waitForTestEvent(subscribe, () => expect(sentDataFrames === chunkRequests).toBe(true));
        expect(terminalReasons).toEqual([]);
      }
      while (!finished) {
        await waitForTestEvent(subscribe, () => expect(finished || replies.length > 0 || nativeAppends.length > 0).toBe(true));
        for (const release of nativeAppends.splice(0)) release();
        for (const release of replies.splice(0)) release();
      }
      const outcome = await finish;
      expect(outcome).not.toHaveProperty('error');
      if (!('result' in outcome)) throw outcome.error;
      const result = DaemonVoiceInferenceSttStreamFinishResponseSchema.parse(outcome.result);
      expect(result).toMatchObject({ ok: true, finalText: 'complete' });
      const events = (await Promise.all(outcomes)).flat();
      expect(events.some(event => event && typeof event === 'object' && 'error' in event)).toBe(false);
      expect(Buffer.concat(received)).toEqual(Buffer.concat(expected));
      expect(received.some(pcm => pcm.byteLength > 640)).toBe(true);
      expect(relayObserved.clientToDaemon.length).toBe(sentDataFrames);
      for (const payload of relayObserved.clientToDaemon) {
        // Plain Accounts relay the exact admitted PCM; E2EE Accounts relay only
        // authenticated ciphertext of it (one tag per packet, no install frame).
        expect(contentMode === 'plain' ? received.some(pcm => Buffer.from(pcm).equals(Buffer.from(payload))) : true).toBe(true);
        if (contentMode === 'e2ee') {
          expect(received.some(pcm => pcm.byteLength + MACHINE_STREAM_KEY_TAG_BYTES_V1 === payload.byteLength)).toBe(true);
          expect(received.some(pcm => Buffer.from(payload).includes(Buffer.from(pcm.subarray(0, 32))))).toBe(false);
        }
      }
      for (const payload of relayObserved.daemonToClient) {
        const json = (() => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch { return null; } })();
        expect(json === null).toBe(contentMode === 'e2ee');
      }
      if (result.ok) DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({ ok: true, streamId: result.streamId,
        generation: result.generation, ackSeq: result.ackSeq, events });
      await Promise.all(operations);
    } finally {
      for (const release of nativeAppends.splice(0)) release();
      for (const release of replies.splice(0)) release();
      await sender.cancel(); await stream.close(); await application.close(); await manager.dispose();
      await rm(streamRoot, { recursive: true, force: true });
    }
  }, DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS * 2);
  it('refuses relay-injected plain and replayed frames for an E2EE-keyed stream before native intake', async () => {
    const streamRoot = await mkdtemp(join(tmpdir(), 'happier-stream-key-'));
    const received: Uint8Array[] = [];
    const authority: VoiceMediaApplicationAuthorityV1 = { v: 1, applicationKind: 'speech_transcription',
      applicationAttemptId: 'request', applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('request') };
    const manager = createVoiceInferenceSpeechStreamManager({ streamRoot, voiceInferenceWorker: {
      transcribeAudio: async () => { throw new Error('batch STT must not run'); }, cancelStt: async () => {},
      createStreamingTranscriptionSession: async () => ({ modelPackId: 'pack',
        appendPcm16: async ({ pcm16Bytes }) => { received.push(new Uint8Array(pcm16Bytes)); return { events: [] }; },
        finish: async () => ({ text: '', language: null, events: [] }), cancel: async () => {}, close: async () => {},
      }),
    } });
    try {
      const started = await manager.start({ requestId: 'request', packId: 'pack', language: null, streamingMode: 'runtime',
        format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT }, undefined, { issueStreamKey: true });
      if (!started.ok || !started.streamKeyBase64Url) throw new Error('E2EE start must issue a stream key');
      const stream = { streamId: started.streamId, generation: started.generation };
      const pcm = new Uint8Array(640).fill(7);
      await expect(manager.appendTunnelFrame({ ...stream, seq: 0, payloadBytes: pcm, voiceMediaApplicationAuthority: authority }))
        .rejects.toMatchObject({ code: 'invalid_stream_state' });
      const sealed = await sealAes256GcmBytes({ key: decodeBase64(started.streamKeyBase64Url, 'base64url'),
        nonce: createMachineStreamKeyNonceV1('client_to_daemon', 0), aad: createMachineStreamKeyAadV1(stream), plaintext: pcm });
      await expect(manager.appendTunnelFrame({ ...stream, seq: 0, payloadBytes: sealed, voiceMediaApplicationAuthority: authority }))
        .resolves.toBeInstanceOf(Uint8Array);
      await expect(manager.appendTunnelFrame({ ...stream, seq: 0, payloadBytes: sealed, voiceMediaApplicationAuthority: authority }))
        .rejects.toMatchObject({ code: 'invalid_stream_state' });
      expect(received.map(bytes => Buffer.from(bytes))).toEqual([Buffer.from(pcm)]);
    } finally {
      await manager.dispose();
      await rm(streamRoot, { recursive: true, force: true });
    }
  });
});
