import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { isVoiceQaDebugRuntime } from '@/voice/qa/voiceQaDebugRuntime';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';

const MAX_FIXTURE_BYTES = 4 * 1024 * 1024;

type VoiceQaOutputFixtureFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type VoiceQaOutputFixturePlayback = Readonly<{
  play: (url: string) => Promise<void>;
  stop: () => void;
}>;

function isWav(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12
    && bytes[0] === 82
    && bytes[1] === 73
    && bytes[2] === 70
    && bytes[3] === 70
    && bytes[8] === 87
    && bytes[9] === 65
    && bytes[10] === 86
    && bytes[11] === 69;
}

function normalizeFixtureUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('voice_qa_output_fixture_url_invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('voice_qa_output_fixture_url_invalid');
  }
  return parsed.toString();
}

async function readBoundedFixtureBytes(response: Response): Promise<ArrayBuffer> {
  const rawDeclaredLength = response.headers.get('content-length');
  const declaredLength = rawDeclaredLength === null ? null : Number(rawDeclaredLength);
  if (declaredLength !== null && (!Number.isFinite(declaredLength) || declaredLength < 0)) {
    throw new Error('voice_qa_output_fixture_size_invalid');
  }
  if (declaredLength !== null && declaredLength > MAX_FIXTURE_BYTES) {
    throw new Error('voice_qa_output_fixture_too_large');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    // Without a stream, the only way to preserve the hard memory bound is to
    // require an honest declared size before using the all-at-once API.
    if (declaredLength === null) {
      throw new Error('voice_qa_output_fixture_size_unknown');
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_FIXTURE_BYTES) {
      throw new Error('voice_qa_output_fixture_too_large');
    }
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new Error('voice_qa_output_fixture_read_failed');
      }
      if (totalBytes + next.value.byteLength > MAX_FIXTURE_BYTES) {
        throw new Error('voice_qa_output_fixture_too_large');
      }
      chunks.push(next.value.slice());
      totalBytes += next.value.byteLength;
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

export function createVoiceQaOutputFixturePlayback(options?: Readonly<{
  fetch?: VoiceQaOutputFixtureFetch;
}>): VoiceQaOutputFixturePlayback {
  const fetchImpl = options?.fetch ?? runtimeFetch;
  let activePlaybackController: ReturnType<typeof createVoicePlaybackController> | null = null;

  return {
    play: async (rawUrl) => {
      if (!isVoiceQaDebugRuntime()) {
        throw new Error('voice_qa_output_fixture_unavailable');
      }
      const url = normalizeFixtureUrl(rawUrl);
      activePlaybackController?.interrupt();
      const playbackController = createVoicePlaybackController();
      activePlaybackController = playbackController;

      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'error',
        });
        if (!response.ok) {
          throw new Error('voice_qa_output_fixture_fetch_failed');
        }
        const bytes = await readBoundedFixtureBytes(response);
        if (!isWav(new Uint8Array(bytes))) {
          throw new Error('voice_qa_output_fixture_invalid_wav');
        }
        if (activePlaybackController !== playbackController) return;

        await playAudioBytesWithStopper({
          bytes,
          format: 'wav',
          registerPlaybackStopper: playbackController.registerStopper,
        });
      } finally {
        if (activePlaybackController === playbackController) {
          activePlaybackController = null;
        }
      }
    },
    stop: () => {
      const playbackController = activePlaybackController;
      activePlaybackController = null;
      playbackController?.interrupt();
    },
  };
}

export const voiceQaOutputFixturePlayback = createVoiceQaOutputFixturePlayback();
