import {
  DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES,
  DaemonVoiceSpeechDownloadAbortResponseSchema,
  DaemonVoiceSpeechDownloadChunkResponseSchema,
  DaemonVoiceSpeechDownloadFinalizeResponseSchema,
  DaemonVoiceSpeechSynthesizeResponseSchema,
  DaemonVoiceSpeechTranscribeResponseSchema,
  DaemonVoiceSpeechTranscribeUploadAbortResponseSchema,
  DaemonVoiceSpeechTranscribeUploadChunkResponseSchema,
  DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema,
  DaemonVoiceSpeechTranscribeUploadInitResponseSchema,
  VoiceProviderCatalogResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { LocalUploadSource } from '@/sync/runtime/files/localUploadSourceReader';
import { openLocalUploadSourceReader } from '@/sync/runtime/files/localUploadSourceReader';
import { createTransferRecipientKeyPair, downloadInChunks, uploadInChunks } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/chunkTransferClient';
import { randomUUID } from '@/platform/randomUUID';
import type { VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';

import {
  createSelectedVoiceMachineClient,
  parseCredentialResponse,
  type SelectedVoiceMachineClientDeps,
  VoiceCredentialClientError,
} from './selectedMachineClient';

function getSpeechTarget(entry: VoiceProviderRegistryEntry) {
  if (entry.kind !== 'voice.speech-engine.v1') {
    throw new VoiceCredentialClientError('provider_unavailable');
  }
  if (entry.declaration?.kind !== 'speech') {
    throw new VoiceCredentialClientError('provider_unavailable');
  }
  return Object.freeze({
    ref: Object.freeze({
      pluginId: entry.pluginId,
      localId: entry.declaration.id,
    }),
  });
}

export class BundledSpeechDaemonClient {
  private readonly machine;

  constructor(deps?: Partial<SelectedVoiceMachineClientDeps>) {
    this.machine = createSelectedVoiceMachineClient(deps);
  }

  async fetchCatalog(entry: VoiceProviderRegistryEntry, catalog: 'models' | 'voices', signal?: AbortSignal | null) {
    const target = getSpeechTarget(entry);
    const response = parseCredentialResponse(VoiceProviderCatalogResponseSchema, await this.machine.invoke(
      RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG,
      { target: target.ref, catalog },
      signal,
    ));
    if (!response.ok) throw new VoiceCredentialClientError('invalid_response');
    return response.items;
  }

  async transcribe(params: Readonly<{
    entry: VoiceProviderRegistryEntry;
    source: LocalUploadSource;
    mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/webm' | 'audio/ogg';
    fileName: string;
    model: string;
    language: string | null;
    signal?: AbortSignal | null;
  }>): Promise<string> {
    const target = getSpeechTarget(params.entry);
    const reader = await openLocalUploadSourceReader(params.source);
    try {
      if (!reader.sizeBytes || reader.sizeBytes > DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES) {
        throw new VoiceCredentialClientError('transfer_failed');
      }
      const uploaded = await uploadInChunks({
        totalBytes: reader.sizeBytes,
        readBytes: reader.readBytes,
        init: async () => parseCredentialResponse(DaemonVoiceSpeechTranscribeUploadInitResponseSchema, await this.machine.invoke(
          RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT,
          {
            target: target.ref,
            sizeBytes: reader.sizeBytes,
            mimeType: params.mimeType,
            fileName: params.fileName,
          },
          params.signal,
        )),
        sendChunk: async (payload) => parseCredentialResponse(DaemonVoiceSpeechTranscribeUploadChunkResponseSchema, await this.machine.invoke(
          RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK, payload, params.signal,
        )),
        finalize: async (payload) => parseCredentialResponse(DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema, await this.machine.invoke(
          RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE, payload, params.signal,
        )),
        abort: async (payload) => parseCredentialResponse(DaemonVoiceSpeechTranscribeUploadAbortResponseSchema, await this.machine.invoke(
          RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_ABORT, payload,
        )),
        signal: params.signal ?? null,
      });
      if (!uploaded.success) throw new VoiceCredentialClientError('transfer_failed');
      const response = parseCredentialResponse(DaemonVoiceSpeechTranscribeResponseSchema, await this.machine.invoke(
        RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE,
        {
          target: target.ref,
          requestId: randomUUID(),
          model: params.model,
          language: params.language,
          mimeType: params.mimeType,
          uploadId: uploaded.uploadId,
        },
        params.signal,
      ));
      if (!response.ok) throw new VoiceCredentialClientError('invalid_response');
      return response.text;
    } finally {
      await reader.close();
    }
  }

  async synthesize(params: Readonly<{
    entry: VoiceProviderRegistryEntry;
    input: string;
    model: string | null;
    voiceName: string;
    languageCode: string | null;
    format: 'mp3' | 'wav';
    speakingRate: number | null;
    pitch: number | null;
    signal?: AbortSignal | null;
  }>): Promise<Readonly<{ bytes: Uint8Array; mimeType: 'audio/mpeg' | 'audio/wav' }>> {
    const target = getSpeechTarget(params.entry);
    const recipient = createTransferRecipientKeyPair();
    const { signal, entry: _entry, ...request } = params;
    const started = parseCredentialResponse(DaemonVoiceSpeechSynthesizeResponseSchema, await this.machine.invoke(
      RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE,
      {
        target: target.ref,
        ...request,
        requestId: randomUUID(),
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      },
      signal,
    ));
    if (!started.ok) throw new VoiceCredentialClientError('invalid_response');
    const chunks: Uint8Array[] = [];
    const result = await downloadInChunks({
      init: async () => ({ success: true as const, ...started }),
      readChunk: async (payload) => parseCredentialResponse(DaemonVoiceSpeechDownloadChunkResponseSchema, await this.machine.invoke(
        RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_CHUNK, payload, signal,
      )),
      finalize: async (payload) => parseCredentialResponse(DaemonVoiceSpeechDownloadFinalizeResponseSchema, await this.machine.invoke(
        RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_FINALIZE, payload, signal,
      )),
      abort: async (payload) => parseCredentialResponse(DaemonVoiceSpeechDownloadAbortResponseSchema, await this.machine.invoke(
        RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_ABORT, payload,
      )),
      recipientSecretKeySeed: recipient.recipientSecretKeySeed,
      writeBytes: async (bytes) => { chunks.push(bytes); },
      signal: signal ?? null,
    });
    if (!result.ok) throw new VoiceCredentialClientError('transfer_failed');
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, mimeType: started.mimeType };
  }
}

export const bundledSpeechDaemonClient = new BundledSpeechDaemonClient();
