import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebPcmCapture } from './WebPcmCapture.web';

type ProcessEvent = Readonly<{
  inputBuffer: Readonly<{ sampleRate: number; numberOfChannels: number; getChannelData(channel: number): Float32Array }>;
  outputBuffer: Readonly<{ numberOfChannels: number; getChannelData(channel: number): Float32Array }>;
}>;

function createProcessor() {
  return {
    connect: vi.fn(), disconnect: vi.fn(),
    onaudioprocess: null as ((event: ProcessEvent) => void) | null,
  };
}

function createTrack() {
  const listeners = new Set<() => void>();
  return {
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
    end: () => { for (const listener of listeners) listener(); },
  };
}

function createContext(input: Readonly<{
  sampleRate?: number;
  state?: string;
  worklet?: boolean;
  addModule?: ReturnType<typeof vi.fn>;
}> = {}) {
  const processor = createProcessor();
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    sampleRate: input.sampleRate ?? 48_000,
    state: input.state ?? 'running',
    destination: {},
    resume: vi.fn(async () => { context.state = 'running'; }),
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor),
    ...(input.worklet ? { audioWorklet: { addModule: input.addModule ?? vi.fn(async () => {}) } } : {}),
  };
  return { context, processor, source };
}

function processEvent(samples: Float32Array, sampleRate = 48_000): ProcessEvent {
  return {
    inputBuffer: { sampleRate, numberOfChannels: 1, getChannelData: () => samples },
    outputBuffer: { numberOfChannels: 1, getChannelData: () => new Float32Array(samples.length) },
  };
}

function createMic(context: unknown, track = createTrack()) {
  const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
  return {
    mic: {
      ensureActive: vi.fn(async () => {}), isMuted: vi.fn(() => false),
      getStream: vi.fn<() => MediaStream | null>(() => stream),
      getAudioContext: vi.fn<() => AudioContext | null>(() => context as AudioContext),
    },
    track,
  };
}

function installWorklet() {
  const node = {
    connect: vi.fn(), disconnect: vi.fn(),
    port: { close: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null },
  };
  const constructor = vi.fn(function AudioWorkletNode() { return node; });
  vi.stubGlobal('AudioWorkletNode', constructor);
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:web-pcm'), revokeObjectURL: vi.fn() });
  return { node, constructor };
}

describe('WebPcmCapture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prefers AudioWorklet and never constructs the deprecated fallback when available', async () => {
    const { context } = createContext({ worklet: true });
    const { node } = installWorklet();
    const { mic } = createMic(context);
    const onChunk = vi.fn(async () => {});
    const capture = createWebPcmCapture({
      mic, format: { sampleRate: 24_000, channels: 1, encoding: 'pcm16le' }, chunkMs: 20,
      fallback: 'allow_script_processor', onChunk,
    });
    await capture.start();
    node.port.onmessage?.({ data: { type: 'pcm16le', bytes: new Uint8Array(960).buffer, level: 0.4 } });
    await capture.waitForDrain();
    expect(context.createScriptProcessor).not.toHaveBeenCalled();
    expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ bytes: expect.any(Uint8Array), level: 0.4 }));
    await capture.stop();
  });

  it.each([[16_000, 320], [24_000, 480]] as const)(
    'resamples 48k input to exact %i Hz 10ms PCM16 chunks',
    async (targetRate, targetBytes) => {
      const { context, processor } = createContext();
      const { mic } = createMic(context);
      const chunks: Uint8Array[] = [];
      const capture = createWebPcmCapture({
        mic, format: { sampleRate: targetRate, channels: 1, encoding: 'pcm16le' }, chunkMs: 10,
        fallback: 'allow_script_processor', onChunk: async ({ bytes }) => { chunks.push(bytes); },
      });
      await capture.start();
      processor.onaudioprocess?.(processEvent(Float32Array.from({ length: 960 }, (_, index) => index % 2 ? 0.5 : -0.5)));
      await capture.waitForDrain();
      expect(chunks).toHaveLength(2);
      expect(chunks.every((chunk) => chunk.byteLength === targetBytes)).toBe(true);
      await capture.stop();
    },
  );

  it('keeps the exact target rate across fragmented render quanta without cumulative drift', async () => {
    const { context, processor } = createContext();
    const chunks: Uint8Array[] = [];
    const capture = createWebPcmCapture({
      mic: createMic(context).mic,
      format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' },
      chunkMs: 20,
      fallback: 'allow_script_processor',
      maxQueuedChunks: 64,
      onChunk: async ({ bytes }) => { chunks.push(bytes); },
    });
    await capture.start();
    for (let quantum = 0; quantum < 375; quantum += 1) {
      processor.onaudioprocess?.(processEvent(new Float32Array(128).fill(0.25)));
    }
    await capture.waitForDrain();
    expect(chunks).toHaveLength(50);
    expect(chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(32_000);
    await capture.stop();
  });

  it('reports resume failure and fails closed before capture nodes are connected', async () => {
    const { context, source } = createContext({ state: 'suspended' });
    context.resume.mockRejectedValueOnce(new Error('resume denied'));
    const onError = vi.fn();
    const capture = createWebPcmCapture({
      mic: createMic(context).mic,
      format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' },
      chunkMs: 20,
      fallback: 'allow_script_processor',
      onChunk: vi.fn(),
      onError,
    });
    await capture.start();
    expect(capture.isActive()).toBe(false);
    expect(onError).toHaveBeenCalledWith('web_pcm_capture_resume_failed');
    expect(source.connect).not.toHaveBeenCalled();
  });

  it('makes deprecated ScriptProcessor activation observable to its adapter', async () => {
    const { context } = createContext();
    const onFallbackActivated = vi.fn();
    const capture = createWebPcmCapture({
      mic: createMic(context).mic,
      format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' },
      chunkMs: 20,
      fallback: 'allow_script_processor',
      onChunk: vi.fn(),
      onFallbackActivated,
    });
    await capture.start();
    expect(onFallbackActivated).toHaveBeenCalledWith('script_processor');
    await capture.stop();
  });

  it('fails closed on queue overflow and stops producing chunks', async () => {
    const { context, processor } = createContext();
    const { mic } = createMic(context);
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const onError = vi.fn();
    const capture = createWebPcmCapture({
      mic, format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' }, chunkMs: 10,
      fallback: 'allow_script_processor', maxQueuedChunks: 1, onError,
      onChunk: vi.fn(async () => await first),
    });
    await capture.start();
    processor.onaudioprocess?.(processEvent(new Float32Array(480)));
    processor.onaudioprocess?.(processEvent(new Float32Array(480)));
    expect(onError).toHaveBeenCalledWith('web_pcm_capture_backpressure');
    expect(capture.isActive()).toBe(false);
    release();
    await capture.waitForDrain();
  });

  it('resumes on visibility restoration and removes the listener on stop', async () => {
    const visibility = { listener: null as (() => void) | null };
    const documentLike = {
      visibilityState: 'visible',
      addEventListener: vi.fn((_name: string, listener: () => void) => { visibility.listener = listener; }),
      removeEventListener: vi.fn((_name: string, listener: () => void) => {
        if (visibility.listener === listener) visibility.listener = null;
      }),
    };
    vi.stubGlobal('document', documentLike);
    const { context } = createContext({ worklet: true });
    installWorklet();
    const capture = createWebPcmCapture({
      mic: createMic(context).mic, format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' }, chunkMs: 20,
      fallback: 'disabled', onChunk: vi.fn(async () => {}),
    });
    await capture.start();
    context.state = 'suspended';
    visibility.listener?.();
    await Promise.resolve();
    expect(context.resume).toHaveBeenCalledTimes(1);
    await capture.stop();
    expect(documentLike.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('aborts while AudioWorklet setup is awaiting and cleans every acquired resource', async () => {
    let release!: () => void;
    const addModule = vi.fn(async () => await new Promise<void>((resolve) => { release = resolve; }));
    const { context, source } = createContext({ worklet: true, addModule });
    installWorklet();
    const abort = new AbortController();
    const capture = createWebPcmCapture({
      mic: createMic(context).mic, format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' }, chunkMs: 20,
      fallback: 'disabled', signal: abort.signal, onChunk: vi.fn(async () => {}),
    });
    const starting = capture.start();
    await vi.waitFor(() => expect(addModule).toHaveBeenCalled());
    abort.abort();
    release();
    await starting;
    expect(capture.isActive()).toBe(false);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:web-pcm');
  });

  it('supports repeated start/stop without retaining state or listeners', async () => {
    const { context } = createContext({ worklet: true });
    const { node } = installWorklet();
    const capture = createWebPcmCapture({
      mic: createMic(context).mic, format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' }, chunkMs: 20,
      fallback: 'disabled', onChunk: vi.fn(async () => {}),
    });
    await capture.start(); await capture.start(); await capture.stop(); await capture.stop();
    await capture.start(); await capture.stop();
    expect(node.port.close).toHaveBeenCalledTimes(2);
    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(2);
  });

  it('reports device loss once and tears down capture', async () => {
    const { context } = createContext({ worklet: true });
    installWorklet();
    const { mic, track } = createMic(context);
    const onError = vi.fn();
    const capture = createWebPcmCapture({
      mic, format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' }, chunkMs: 20,
      fallback: 'disabled', onError, onChunk: vi.fn(async () => {}),
    });
    await capture.start();
    track.end(); track.end();
    await vi.waitFor(() => expect(capture.isActive()).toBe(false));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('web_pcm_capture_device_lost');
  });

  it('reports microphone acquisition failure separately from later capture setup', async () => {
    const { context } = createContext();
    const { mic } = createMic(context);
    mic.ensureActive.mockRejectedValueOnce(new Error('permission denied'));
    const onError = vi.fn();
    const capture = createWebPcmCapture({
      mic,
      format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' },
      chunkMs: 20,
      fallback: 'allow_script_processor',
      onChunk: vi.fn(),
      onError,
    });
    await capture.start();
    expect(onError).toHaveBeenCalledWith('web_pcm_capture_mic_acquisition_failed');
  });

  it('reports missing stream or audio context separately from microphone acquisition', async () => {
    const { context } = createContext();
    const { mic } = createMic(context);
    mic.getStream.mockReturnValueOnce(null);
    const onError = vi.fn();
    const capture = createWebPcmCapture({
      mic,
      format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' },
      chunkMs: 20,
      fallback: 'allow_script_processor',
      onChunk: vi.fn(),
      onError,
    });
    await capture.start();
    expect(onError).toHaveBeenCalledWith('web_pcm_capture_mic_state_unavailable');
  });

  it('reports media-source construction failure separately and removes device listeners', async () => {
    const { context } = createContext();
    context.createMediaStreamSource.mockImplementationOnce(() => { throw new Error('ended stream'); });
    const { mic, track } = createMic(context);
    const onError = vi.fn();
    const capture = createWebPcmCapture({
      mic,
      format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' },
      chunkMs: 20,
      fallback: 'allow_script_processor',
      onChunk: vi.fn(),
      onError,
    });
    await capture.start();
    expect(capture.isActive()).toBe(false);
    expect(onError).toHaveBeenCalledWith('web_pcm_capture_media_source_failed');
    expect(track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
  });

  it('tears down capture even when the error observer throws', async () => {
    const { context, source } = createContext({ worklet: true });
    const { node } = installWorklet();
    const { mic, track } = createMic(context);
    const capture = createWebPcmCapture({
      mic,
      format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' },
      chunkMs: 20,
      fallback: 'disabled',
      onChunk: vi.fn(),
      onError: () => { throw new Error('observer failed'); },
    });
    await capture.start();
    track.end();
    await vi.waitFor(() => expect(capture.isActive()).toBe(false));
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(node.port.close).toHaveBeenCalledTimes(1);
    expect(track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
  });
});
