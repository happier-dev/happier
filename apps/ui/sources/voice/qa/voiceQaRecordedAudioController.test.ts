import { describe, expect, it, vi } from 'vitest';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { storage } from '@/sync/domains/state/storage';
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { applySettings } from '@/sync/domains/settings/settings';

import {
  readLocalConversationVoiceSettings,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

import {
  createVoiceQaRecordedAudioController,
  createRecordedAudioQaDaemonMachineResolver,
  resolveRecordedAudioQaTranscriptionMode,
} from './voiceQaRecordedAudioController';

describe('voiceQaRecordedAudioController target selection', () => {
  it('selects the explicit daemon target when every explicit target field is present', () => {
    expect(resolveRecordedAudioQaTranscriptionMode({
      sessionId: 'qa-session',
      machineId: 'qa-machine',
      basePath: '/repo',
      packId: 'qa-pack',
    })).toBe('explicit_daemon');
  });

  it('keeps the configured runtime path when the explicit target is incomplete', () => {
    expect(resolveRecordedAudioQaTranscriptionMode({
      sessionId: 'qa-session',
      machineId: 'qa-machine',
      basePath: '',
      packId: 'qa-pack',
    })).toBe('configured_runtime');
  });

  it('binds explicit daemon resolution to the requested QA machine', () => {
    const resolvers = createRecordedAudioQaDaemonMachineResolver({
      machineId: 'qa-machine',
    });

    expect(resolvers.resolveVoiceHomeDaemonMachineId()).toBe('qa-machine');
  });

  it('runs the real explicit controller branch on only the requested target without consulting ambient routing or mutating settings', async () => {
    const originalState = storage.getState();
    const sharedMetadata: Metadata = {
      path: '',
      host: '',
      v: 1,
      summary: { text: 'Shared QA session', updatedAt: 1 },
    };
    const ownerMetadataView: Metadata = {
      path: '/previous/repo',
      host: 'previous-host',
      machineId: 'previous-machine',
      name: 'Previous owner label',
    };
    const existingLayout1Session = {
      id: 'explicit-session',
      seq: 0,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadataLayoutVersion: 1,
      metadata: sharedMetadata,
      ownerMetadataView,
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
      thinking: false,
      thinkingAt: 0,
      presence: 'online',
    } satisfies Session;
    storage.getState().applySessions([existingLayout1Session]);
    const currentVoice = voiceSettingsParse(originalState.settings.voice);
    const currentConversation = readLocalConversationVoiceSettings(currentVoice);
    const ambientOnlySettings = applySettings(originalState.settings, {
      voice: writeLocalConversationVoiceSettings(
        voiceSettingsParse({ ...currentVoice, providerId: 'local_conversation' }),
        {
          ...currentConversation,
          stt: {
            ...currentConversation.stt,
            provider: 'openai_compat',
            openaiCompat: {
              ...currentConversation.stt.openaiCompat,
              baseUrl: null,
            },
          },
        },
      ),
    });
    storage.setState((state) => ({ ...state, settings: ambientOnlySettings }));
    const ambientDaemonResolver = vi.fn(() => 'ambient-machine');
    const machineRpcWithServerScope = vi.fn(async (input: { method: string; payload: Record<string, unknown> }) => {
      if (input.method === 'daemon.voiceInference.stt.upload.init') {
        const recipient = createTransferRecipientKeyPair();
        return {
          success: true,
          uploadId: 'qa-upload',
          chunkSizeBytes: 1024,
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.chunk') {
        return { success: true };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.finalize') {
        return {
          success: true,
          uploadId: 'qa-upload',
          path: '/tmp/qa-upload.wav',
          sizeBytes: 4,
          sha256: 'qa-sha',
        };
      }
      if (input.method === 'daemon.voiceInference.stt.transcribe') {
        return {
          ok: true,
          requestId: 'qa-request',
          text: 'explicit target transcript',
          language: 'en',
          modelPackId: 'explicit-pack',
        };
      }
      throw new Error(`unexpected_rpc:${input.method}`);
    });
    const controller = createVoiceQaRecordedAudioController({
      daemonClientDeps: {
        resolveVoiceHomeDaemonMachineId: ambientDaemonResolver,
        machineRpcWithServerScope: machineRpcWithServerScope as never,
        isRuntimeFeatureEnabled: async () => true,
        openLocalUploadSourceReader: async () => ({
          sizeBytes: 4,
          readBytes: async () => new Uint8Array([1, 2, 3, 4]),
          close: async () => {},
        }),
        createRequestId: () => 'qa-request',
        resolveDiagnosticsCaptureContext: () => undefined,
      },
    });

    try {
      await expect(controller.transcribe({
        sessionId: 'explicit-session',
        uri: 'blob:explicit-recording',
        packId: 'explicit-pack',
        machineId: 'explicit-machine',
        basePath: '/explicit/repo',
        webFile: new File([new Uint8Array([1, 2, 3, 4])], 'recording.wav', { type: 'audio/wav' }),
      })).resolves.toBe('explicit target transcript');

      expect(ambientDaemonResolver).not.toHaveBeenCalled();
      expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'explicit-machine',
        method: 'daemon.voiceInference.stt.transcribe',
        payload: expect.objectContaining({ packId: 'explicit-pack' }),
      }));
      expect(storage.getState().sessions['explicit-session']).toMatchObject({
        metadataLayoutVersion: 1,
        metadata: sharedMetadata,
        ownerMetadataView: {
          path: '/explicit/repo',
          host: 'voice-qa',
          machineId: 'explicit-machine',
          name: 'Recorded audio daemon STT target',
        },
      });
      expect(storage.getState().settings).toEqual(ambientOnlySettings);
    } finally {
      storage.setState(originalState, true);
    }
  });
});
