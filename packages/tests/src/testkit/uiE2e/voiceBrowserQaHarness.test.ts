import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  installVoiceMediaInstrumentation,
  readVoiceBrowserQaDaemonSttManifestEvidence,
  startVoiceQaBoundaryServer,
} from './voiceBrowserQaHarness';

describe('installVoiceMediaInstrumentation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never lets best-effort level instrumentation reject a valid production media stream', async () => {
    const track = {
      readyState: 'live',
      stop: vi.fn(),
    };
    const stream = {
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    const originalGetUserMedia = vi.fn(async () => stream);

    class FailingDiagnosticAudioContext {
      state = 'suspended';
      close = vi.fn(async () => {});
      resume = vi.fn(async () => {
        throw new Error('diagnostic context resume failed');
      });
    }

    const windowLike = {
      fetch: vi.fn(),
      AudioContext: FailingDiagnosticAudioContext,
    };
    vi.stubGlobal('window', windowLike);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: originalGetUserMedia,
      },
    });

    const initScripts: Array<() => void> = [];
    const page = {
      addInitScript: vi.fn(async (script: () => void) => {
        initScripts.push(script);
      }),
    } as unknown as Page; // Genuine Playwright boundary fixture; the init script itself remains real.

    await installVoiceMediaInstrumentation(page);
    expect(initScripts).toHaveLength(1);
    initScripts[0]?.();

    await expect(navigator.mediaDevices.getUserMedia({ audio: true })).resolves.toBe(stream);
    await vi.waitFor(() => {
      expect((windowLike as typeof windowLike & {
        __happierVoiceMediaQa?: { instrumentationErrors?: Array<{ stage: string }> };
      }).__happierVoiceMediaQa?.instrumentationErrors).toContainEqual({
        stage: 'audio_context_resume',
      });
    });
  });

  it('records the browser getUserMedia rejection without changing the production error', async () => {
    const denied = new DOMException('requested device not found', 'NotFoundError');
    const originalGetUserMedia = vi.fn(async () => {
      throw denied;
    });
    const windowLike = {
      fetch: vi.fn(),
      AudioContext: undefined,
    };
    vi.stubGlobal('window', windowLike);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: originalGetUserMedia,
      },
    });

    const initScripts: Array<() => void> = [];
    const page = {
      addInitScript: vi.fn(async (script: () => void) => {
        initScripts.push(script);
      }),
    } as unknown as Page; // Genuine Playwright boundary fixture; the init script itself remains real.

    await installVoiceMediaInstrumentation(page);
    initScripts[0]?.();

    await expect(navigator.mediaDevices.getUserMedia({ audio: true })).rejects.toBe(denied);
    expect((windowLike as typeof windowLike & {
      __happierVoiceMediaQa?: {
        getUserMediaErrors?: Array<{ name: string; message: string }>;
      };
    }).__happierVoiceMediaQa?.getUserMediaErrors).toEqual([{
      name: 'NotFoundError',
      message: 'requested device not found',
    }]);
  });
});

describe('readVoiceBrowserQaDaemonSttManifestEvidence', () => {
  it('reads the exact selected-daemon pack manifest identity used by the retry', async () => {
    const daemonHomeDir = await mkdtemp(join(tmpdir(), 'voice-browser-qa-manifest-'));
    const serverId = 'server-test';
    const packId = 'zipformer-test';
    const manifestPath = join(
      daemonHomeDir,
      'servers',
      serverId,
      'voiceInference',
      'packs',
      packId,
      'pack.json',
    );
    try {
      await mkdir(join(manifestPath, '..'), { recursive: true });
      await writeFile(manifestPath, JSON.stringify({
        packId,
        version: '2026.07.23',
        kind: 'stt_sherpa',
      }));

      await expect(readVoiceBrowserQaDaemonSttManifestEvidence({
        daemonHomeDir,
        serverId,
        packId,
      })).resolves.toEqual({
        path: manifestPath,
        present: true,
        packId,
        version: '2026.07.23',
      });
    } finally {
      await rm(daemonHomeDir, { recursive: true, force: true });
    }
  });
});

describe('startVoiceQaBoundaryServer', () => {
  it('serves bounded STT, chat, and generated-WAV TTS operations with request evidence', async () => {
    const auth = {
      stt: 'Bearer machine-stt-key',
      chat: 'Bearer machine-chat-key',
      tts: 'Bearer machine-tts-key',
    } as const;
    const server = await startVoiceQaBoundaryServer({
      requiredAuthorization: {
        transcription: auth.stt,
        chat: auth.chat,
        speech: auth.tts,
      },
    });
    try {
      const rejected = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer account-chat-decoy', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(rejected.status).toBe(401);

      const transcription = await fetch(`${server.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: {
          authorization: auth.stt,
          'content-type': 'multipart/form-data; boundary=voice-qa',
        },
        body: '--voice-qa\r\nfixture-audio\r\n--voice-qa--\r\n',
      });
      await expect(transcription.json()).resolves.toEqual({ text: 'check repository status' });

      const chat = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: auth.chat, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'voice-qa-chat',
          messages: [{ role: 'user', content: 'check repository status' }],
        }),
      });
      await expect(chat.json()).resolves.toEqual({
        choices: [{ message: { content: 'The repository status is ready.' } }],
      });

      const speech = await fetch(`${server.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { authorization: auth.tts, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'voice-qa-tts',
          voice: 'alloy',
          input: 'The repository status is ready.',
          response_format: 'wav',
        }),
      });
      expect(speech.status).toBe(200);
      expect(speech.headers.get('content-type')).toBe('audio/wav');
      expect((await speech.arrayBuffer()).byteLength).toBeGreaterThan(1_024);

      expect(server.getRequests()).toEqual([
        expect.objectContaining({
          operation: 'transcription',
          authorization: auth.stt,
          bodyByteLength: expect.any(Number),
        }),
        expect.objectContaining({
          operation: 'chat',
          authorization: auth.chat,
          bodyText: expect.stringContaining('check repository status'),
        }),
        expect.objectContaining({
          operation: 'speech',
          authorization: auth.tts,
          bodyText: expect.stringContaining('The repository status is ready.'),
        }),
      ]);
    } finally {
      await server.stop();
    }
  });
});
