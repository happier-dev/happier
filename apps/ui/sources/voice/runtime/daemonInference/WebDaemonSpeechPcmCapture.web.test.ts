import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebDaemonSpeechPcmCapture } from './WebDaemonSpeechPcmCapture.web';

type TestAudioProcessEvent = ReturnType<typeof createAudioProcessEvent>;

type TestScriptProcessorNode = Readonly<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}> & {
  onaudioprocess: null | ((event: TestAudioProcessEvent) => void);
};

type TestWorkletNode = Readonly<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  port: {
    close: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    onmessage: null | ((event: { data: unknown }) => void);
  };
}>;

type TestVisibilityDocument = Readonly<{
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  emitVisible: () => void;
}> & {
  visibilityState: DocumentVisibilityState;
};

function toInt16Values(bytes: Uint8Array): readonly number[] {
  const buffer = Buffer.from(bytes);
  const values: number[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += 2) {
    values.push(buffer.readInt16LE(offset));
  }
  return values;
}

function createAudioProcessEvent(samples: readonly number[], sampleRate = 16_000) {
  const data = Float32Array.from(samples);
  return {
    inputBuffer: {
      sampleRate,
      numberOfChannels: 1,
      getChannelData: () => data,
    },
    outputBuffer: {
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(data.length),
    },
  };
}

function createScriptProcessorNode(): TestScriptProcessorNode {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null,
  };
}

function createWorkletNode(): TestWorkletNode {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: {
      close: vi.fn(),
      postMessage: vi.fn(),
      onmessage: null,
    },
  };
}

function createAudioContext(options: {
  workletAvailable?: boolean;
  processor?: TestScriptProcessorNode;
  workletAddModule?: ReturnType<typeof vi.fn>;
  initialState?: AudioContextState;
} = {}) {
  const source = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const processor = options.processor ?? createScriptProcessorNode();
  const audioContext = {
    destination: {},
    sampleRate: 16_000,
    state: options.initialState ?? 'running',
    resume: vi.fn(async () => {
      audioContext.state = 'running';
    }),
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor),
    ...(options.workletAvailable
      ? {
          audioWorklet: {
            addModule: options.workletAddModule ?? vi.fn(async () => {}),
          },
        }
      : {}),
  };
  return { audioContext, source, processor };
}

function createMicSession(options: {
  audioContext: unknown;
  stream?: MediaStream;
  isMuted?: () => boolean;
}) {
  const stream = options.stream ?? ({ getAudioTracks: vi.fn(() => [{ kind: 'audio' }]) } as unknown as MediaStream);
  return {
    ensureActive: vi.fn(async () => {}),
    setMuted: vi.fn(),
    isMuted: vi.fn(options.isMuted ?? (() => false)),
    teardown: vi.fn(async () => {}),
    getStream: vi.fn(() => stream),
    getAudioContext: vi.fn(() => options.audioContext as AudioContext),
  };
}

function installWorkletNodeMock(workletNode = createWorkletNode()) {
  const createdNodes: TestWorkletNode[] = [];
  const AudioWorkletNodeMock = vi.fn(function AudioWorkletNode() {
    createdNodes.push(workletNode);
    return workletNode;
  });
  vi.stubGlobal('AudioWorkletNode', AudioWorkletNodeMock);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:web-daemon-speech-pcm-worklet'),
    revokeObjectURL: vi.fn(),
  });
  return { AudioWorkletNodeMock, createdNodes, workletNode };
}

function emitWorkletPcm(node: TestWorkletNode, bytes: Uint8Array): void {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  node.port.onmessage?.({ data: { type: 'pcm16le', bytes: copy, level: 0.25 } });
}

function installVisibilityDocumentMock(): TestVisibilityDocument {
  let listener: (() => void) | null = null;
  const documentLike: TestVisibilityDocument = {
    visibilityState: 'visible',
    addEventListener: vi.fn((eventName: string, cb: EventListenerOrEventListenerObject) => {
      if (eventName === 'visibilitychange' && typeof cb === 'function') {
        listener = cb as () => void;
      }
    }),
    removeEventListener: vi.fn((eventName: string, cb: EventListenerOrEventListenerObject) => {
      if (eventName === 'visibilitychange' && cb === listener) {
        listener = null;
      }
    }),
    emitVisible: () => {
      documentLike.visibilityState = 'visible';
      listener?.();
    },
  };
  vi.stubGlobal('document', documentLike);
  return documentLike;
}

describe('createWebDaemonSpeechPcmCapture', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the microphone acquisition stage in the Voice machine error', async () => {
    const { audioContext } = createAudioContext();
    const micSession = createMicSession({ audioContext });
    micSession.ensureActive.mockRejectedValueOnce(new Error('permission denied'));
    const onError = vi.fn();
    const capture = createWebDaemonSpeechPcmCapture({
      micSession,
      onAudioStarted: vi.fn(),
      onChunk: vi.fn(),
      onError,
    });

    await capture.start();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'daemon_streaming_stt_web_mic_acquisition_failed',
    }));
  });

  it('prefers AudioWorklet capture when the browser supports it', async () => {
    const workletAddModule = vi.fn(async () => {});
    const { audioContext, source } = createAudioContext({ workletAvailable: true, workletAddModule });
    const { AudioWorkletNodeMock, workletNode } = installWorkletNodeMock();
    const micSession = createMicSession({ audioContext });
    const onChunk = vi.fn(async (_chunk: Uint8Array) => {});
    const onAudioStarted = vi.fn();
    const capture = createWebDaemonSpeechPcmCapture({
      micSession,
      onAudioStarted,
      onChunk,
      processorBufferSize: 4,
    });

    await capture.start();
    const expected = new Uint8Array(640);
    expected[2] = 1;
    emitWorkletPcm(workletNode, expected);
    await capture.waitForDrain();
    await capture.stop();

    expect(workletAddModule).toHaveBeenCalledTimes(1);
    expect(AudioWorkletNodeMock).toHaveBeenCalledWith(audioContext, expect.any(String), expect.any(Object));
    expect(audioContext.createScriptProcessor).not.toHaveBeenCalled();
    expect(source.connect).toHaveBeenCalledWith(workletNode);
    expect(workletNode.connect).toHaveBeenCalledWith(audioContext.destination);
    expect(onAudioStarted).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(expected);
  });

  it('falls back to ScriptProcessor when AudioWorklet is unavailable', async () => {
    const processor = createScriptProcessorNode();
    const { audioContext, source } = createAudioContext({ processor });
    const micSession = createMicSession({ audioContext });
    const onChunk = vi.fn(async (_chunk: Uint8Array) => {});
    const onAudioStarted = vi.fn();
    const onError = vi.fn();
    const capture = createWebDaemonSpeechPcmCapture({
      micSession,
      onAudioStarted,
      onChunk,
      onError,
      processorBufferSize: 4,
    });

    await capture.start();
    const samples = Array.from({ length: 320 }, (_, index) => [-1, 0, 1, 0.5][index % 4]!);
    processor.onaudioprocess?.(createAudioProcessEvent(samples));
    await capture.waitForDrain();
    await capture.stop();

    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(micSession.getStream).toHaveBeenCalledTimes(1);
    expect(audioContext.createScriptProcessor).toHaveBeenCalledWith(4, 1, 1);
    expect(source.connect).toHaveBeenCalledWith(processor);
    expect(onAudioStarted).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledTimes(1);
    const firstChunk = onChunk.mock.calls[0]?.[0];
    if (!(firstChunk instanceof Uint8Array)) {
      throw new Error('expected PCM capture to emit PCM bytes');
    }
    expect(toInt16Values(firstChunk)).toHaveLength(320);
    expect(toInt16Values(firstChunk).slice(0, 4)).toEqual([-32768, 0, 32767, 16384]);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(processor.disconnect).toHaveBeenCalledTimes(1);
    expect(micSession.teardown).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('resumes a suspended AudioContext before capture starts', async () => {
    const { audioContext } = createAudioContext({ workletAvailable: true, initialState: 'suspended' });
    installWorkletNodeMock();
    const capture = createWebDaemonSpeechPcmCapture({
      micSession: createMicSession({ audioContext }),
      onAudioStarted: vi.fn(),
      onChunk: vi.fn(async (_chunk: Uint8Array) => {}),
    });

    await capture.start();

    expect(audioContext.resume).toHaveBeenCalledTimes(1);
    await capture.stop();
  });

  it('retries AudioContext resume when the tab becomes visible again', async () => {
    const documentLike = installVisibilityDocumentMock();
    const { audioContext } = createAudioContext({ workletAvailable: true, initialState: 'running' });
    installWorkletNodeMock();
    const capture = createWebDaemonSpeechPcmCapture({
      micSession: createMicSession({ audioContext }),
      onAudioStarted: vi.fn(),
      onChunk: vi.fn(async (_chunk: Uint8Array) => {}),
    });

    await capture.start();
    audioContext.resume.mockClear();
    audioContext.state = 'suspended';

    documentLike.emitVisible();
    await Promise.resolve();

    expect(audioContext.resume).toHaveBeenCalledTimes(1);
    await capture.stop();
    expect(documentLike.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    audioContext.resume.mockClear();
    audioContext.state = 'suspended';
    documentLike.emitVisible();
    await Promise.resolve();
    expect(audioContext.resume).not.toHaveBeenCalled();
  });

  it('drops muted worklet frames without marking audio started or sending PCM', async () => {
    let muted = true;
    const { audioContext } = createAudioContext({ workletAvailable: true });
    const { workletNode } = installWorkletNodeMock();
    const onAudioStarted = vi.fn();
    const onChunk = vi.fn(async (_chunk: Uint8Array) => {});
    const capture = createWebDaemonSpeechPcmCapture({
      micSession: createMicSession({ audioContext, isMuted: () => muted }),
      onAudioStarted,
      onChunk,
    });

    await capture.start();
    const mutedChunk = new Uint8Array(640);
    mutedChunk[0] = 1;
    emitWorkletPcm(workletNode, mutedChunk);
    await capture.waitForDrain();
    expect(onAudioStarted).not.toHaveBeenCalled();
    expect(onChunk).not.toHaveBeenCalled();

    muted = false;
    const audibleChunk = new Uint8Array(640);
    audibleChunk[0] = 2;
    emitWorkletPcm(workletNode, audibleChunk);
    await capture.waitForDrain();

    expect(onAudioStarted).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(audibleChunk);
  });

  it('stops fallback streaming on abort and ignores later audio process callbacks', async () => {
    const processor = createScriptProcessorNode();
    const { audioContext, source } = createAudioContext({ processor });
    const abortController = new AbortController();
    const onChunk = vi.fn(async (_chunk: Uint8Array) => {});
    const capture = createWebDaemonSpeechPcmCapture({
      micSession: createMicSession({ audioContext }),
      onAudioStarted: vi.fn(),
      onChunk,
      signal: abortController.signal,
    });

    await capture.start();
    abortController.abort();
    processor.onaudioprocess?.(createAudioProcessEvent([0.25]));
    await capture.waitForDrain();

    expect(capture.isActive()).toBe(false);
    expect(processor.onaudioprocess).toBeNull();
    expect(processor.disconnect).toHaveBeenCalledTimes(1);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('cleans up AudioWorklet capture on abort and stop is idempotent', async () => {
    const documentLike = installVisibilityDocumentMock();
    const { audioContext, source } = createAudioContext({ workletAvailable: true });
    const { workletNode } = installWorkletNodeMock();
    const abortController = new AbortController();
    const onChunk = vi.fn(async (_chunk: Uint8Array) => {});
    const micSession = createMicSession({ audioContext });
    const capture = createWebDaemonSpeechPcmCapture({
      micSession,
      onAudioStarted: vi.fn(),
      onChunk,
      signal: abortController.signal,
    });

    await capture.start();
    abortController.abort();
    emitWorkletPcm(workletNode, new Uint8Array([1, 0]));
    await capture.waitForDrain();
    await capture.stop();

    expect(capture.isActive()).toBe(false);
    expect(workletNode.port.onmessage).toBeNull();
    expect(workletNode.port.close).toHaveBeenCalledTimes(1);
    expect(workletNode.disconnect).toHaveBeenCalledTimes(1);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:web-daemon-speech-pcm-worklet');
    expect(documentLike.removeEventListener).toHaveBeenCalledTimes(1);
    expect(micSession.teardown).not.toHaveBeenCalled();
    expect(onChunk).not.toHaveBeenCalled();
  });
});
