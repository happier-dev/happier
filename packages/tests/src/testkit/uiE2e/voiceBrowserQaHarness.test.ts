import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  installVoiceMediaInstrumentation,
  matchesVoiceMediaCaptureIdentity,
  readVoiceBrowserQaDaemonSttManifestEvidence,
  startVoiceQaBoundaryServer,
} from './voiceBrowserQaHarness';

describe('installVoiceMediaInstrumentation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a delayed second capture when validating a Dictation capture identity', () => {
    expect(matchesVoiceMediaCaptureIdentity({
      callsBeforeCapture: 7,
      capturedAdmissionAtMs: 1_000,
      currentCalls: 8,
      observedAdmissionAtMs: 1_000,
    })).toBe(true);
    expect(matchesVoiceMediaCaptureIdentity({
      callsBeforeCapture: 7,
      capturedAdmissionAtMs: 1_000,
      currentCalls: 9,
      observedAdmissionAtMs: 1_000,
    })).toBe(false);
    expect(matchesVoiceMediaCaptureIdentity({
      callsBeforeCapture: 7,
      capturedAdmissionAtMs: 1_000,
      currentCalls: 8,
      observedAdmissionAtMs: 2_000,
    })).toBe(false);
  });

  it('never lets best-effort level instrumentation reject a valid production media stream', async () => {
    const track = {
      readyState: 'live',
      stop: vi.fn(),
    };
    const stream = {
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    let admitStream: (value: MediaStream) => void;
    const originalGetUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      admitStream = resolve;
    }));

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
    vi.stubGlobal('performance', { now: vi.fn(() => 12_345) });
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

    const requestedStream = navigator.mediaDevices.getUserMedia({ audio: true });
    expect((windowLike as typeof windowLike & {
      __happierVoiceMediaQa?: { lastGetUserMediaAdmissionAtMs: number | null };
    }).__happierVoiceMediaQa?.lastGetUserMediaAdmissionAtMs).toBeNull();
    admitStream!(stream);
    await expect(requestedStream).resolves.toBe(stream);
    expect((windowLike as typeof windowLike & {
      __happierVoiceMediaQa?: { lastGetUserMediaAdmissionAtMs: number | null };
    }).__happierVoiceMediaQa?.lastGetUserMediaAdmissionAtMs).toBe(12_345);
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

  it('records the first stopped track timestamp for the most recently admitted capture', async () => {
    const track = {
      readyState: 'live',
      stop: vi.fn(() => {
        track.readyState = 'ended';
      }),
    };
    const stream = {
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    const windowLike = {
      fetch: vi.fn(),
      AudioContext: undefined,
    };
    vi.stubGlobal('window', windowLike);
    vi.stubGlobal('performance', { now: vi.fn(() => 12_345) });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => stream),
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

    await expect(navigator.mediaDevices.getUserMedia({ audio: true })).resolves.toBe(stream);
    track.stop();

    expect((windowLike as typeof windowLike & {
      __happierVoiceMediaQa?: {
        lastGetUserMediaAdmissionAtMs: number | null;
        lastCaptureFirstTrackStopAtMs: number | null;
      };
    }).__happierVoiceMediaQa).toMatchObject({
      lastGetUserMediaAdmissionAtMs: 12_345,
      lastCaptureFirstTrackStopAtMs: 12_345,
    });
  });

  it('does not attribute a stale capture stop to the current capture boundary', async () => {
    const createTrack = () => {
      const track = {
        readyState: 'live',
        stop: vi.fn(() => {
          track.readyState = 'ended';
        }),
      };
      return track;
    };
    const firstTrack = createTrack();
    const secondTrack = createTrack();
    const firstStream = { getAudioTracks: () => [firstTrack] } as unknown as MediaStream;
    const secondStream = { getAudioTracks: () => [secondTrack] } as unknown as MediaStream;
    const windowLike = {
      fetch: vi.fn(),
      AudioContext: undefined,
    };
    vi.stubGlobal('window', windowLike);
    vi.stubGlobal('performance', {
      now: vi.fn()
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(2_000)
        .mockReturnValueOnce(3_000),
    });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn()
          .mockResolvedValueOnce(firstStream)
          .mockResolvedValueOnce(secondStream),
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

    await navigator.mediaDevices.getUserMedia({ audio: true });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    firstTrack.stop();
    expect((windowLike as typeof windowLike & {
      __happierVoiceMediaQa?: { lastCaptureFirstTrackStopAtMs: number | null };
    }).__happierVoiceMediaQa?.lastCaptureFirstTrackStopAtMs).toBeNull();

    secondTrack.stop();
    expect((windowLike as typeof windowLike & {
      __happierVoiceMediaQa?: { lastCaptureFirstTrackStopAtMs: number | null };
    }).__happierVoiceMediaQa?.lastCaptureFirstTrackStopAtMs).toBe(3_000);
  });

  it('returns a blob-fetch response before best-effort clone diagnostics settle', async () => {
    let rejectDiagnosticBlob: ((reason: unknown) => void) | null = null;
    const diagnosticBlob = new Promise<Blob>((_resolve, reject) => {
      rejectDiagnosticBlob = reject;
    });
    const response = {
      ok: true,
      clone: vi.fn(() => ({
        blob: vi.fn(() => diagnosticBlob),
      })),
    } as unknown as Response;
    const windowLike = {
      fetch: vi.fn(async () => response),
      AudioContext: undefined,
    };
    vi.stubGlobal('window', windowLike);
    vi.stubGlobal('navigator', { mediaDevices: undefined });

    const initScripts: Array<() => void> = [];
    const page = {
      addInitScript: vi.fn(async (script: () => void) => {
        initScripts.push(script);
      }),
    } as unknown as Page; // Genuine Playwright boundary fixture; the init script itself remains real.

    await installVoiceMediaInstrumentation(page);
    initScripts[0]?.();

    let returnedResponse: Response | null = null;
    const wrappedFetch = window.fetch('blob:voice-qa-recording').then((received) => {
      returnedResponse = received;
      return received;
    });
    await vi.waitFor(() => {
      expect(returnedResponse).toBe(response);
    });
    // The Promise executor runs synchronously and installs this boundary hook.
    rejectDiagnosticBlob!(new Error('diagnostic blob read failed'));
    await expect(wrappedFetch).resolves.toBe(response);
    await vi.waitFor(() => {
      expect((windowLike as typeof windowLike & {
        __happierVoiceMediaQa?: {
          blobFetches: Array<{ ok: boolean; size: number | null; type: string | null }>;
        };
      }).__happierVoiceMediaQa?.blobFetches).toEqual([{
        ok: false,
        size: null,
        type: null,
      }]);
    });
  });

  it('tracks create, revoke, and active counts for object URLs it owns', async () => {
    const ownedUrl = 'blob:voice-qa-recording';
    const createObjectURL = vi.fn(() => ownedUrl);
    const revokeObjectURL = vi.fn();
    const windowLike = { fetch: vi.fn() };
    vi.stubGlobal('window', windowLike);
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('navigator', { mediaDevices: undefined });

    const initScripts: Array<() => void> = [];
    const page = {
      addInitScript: vi.fn(async (script: () => void) => {
        initScripts.push(script);
      }),
    } as unknown as Page; // Genuine Playwright boundary fixture; the init script itself remains real.

    await installVoiceMediaInstrumentation(page);
    initScripts[0]?.();

    URL.createObjectURL(new Blob(['fixture-audio']));
    URL.revokeObjectURL('blob:not-owned-by-voice-qa');
    URL.revokeObjectURL(ownedUrl);
    URL.revokeObjectURL(ownedUrl);

    expect((windowLike as typeof windowLike & {
      __happierVoiceMediaQa?: {
        objectUrlCreates: number;
        objectUrlRevokes: number;
        activeObjectUrls: number;
      };
    }).__happierVoiceMediaQa).toMatchObject({
      objectUrlCreates: 1,
      objectUrlRevokes: 1,
      activeObjectUrls: 0,
    });
    expect(revokeObjectURL).toHaveBeenNthCalledWith(1, 'blob:not-owned-by-voice-qa');
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, ownedUrl);
    expect(revokeObjectURL).toHaveBeenNthCalledWith(3, ownedUrl);
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
  it('returns an explicit deterministic transcription sequence without a runtime control endpoint', async () => {
    const server = await startVoiceQaBoundaryServer({
      transcriptionTexts: ['UCX_VOICE_OFF', 'UCX_VOICE_READ_A'],
    });
    try {
      const transcribe = async () => await fetch(`${server.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=voice-qa' },
        body: '--voice-qa\r\nfixture-audio\r\n--voice-qa--\r\n',
      });

      await expect((await transcribe()).json()).resolves.toEqual({ text: 'UCX_VOICE_OFF' });
      await expect((await transcribe()).json()).resolves.toEqual({ text: 'UCX_VOICE_READ_A' });
      // A capture retry stays deterministic without adding a mutable test route.
      await expect((await transcribe()).json()).resolves.toEqual({ text: 'UCX_VOICE_READ_A' });
    } finally {
      await server.stop();
    }
  });

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
