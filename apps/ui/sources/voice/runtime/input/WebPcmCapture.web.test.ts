import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';

import { createWebPcmCapture } from './WebPcmCapture.web';
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { installVoiceWebRtcBrowserBoundary } = await import('@/dev/testkit/harness/voiceWebRtcHarness');
const browsers: Array<ReturnType<typeof installVoiceWebRtcBrowserBoundary>> = [];

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
    close: vi.fn(async () => {}),
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

function createMic(context: unknown) {
  // Only MediaDevices/Web Audio are synthetic; MicSession is the shipped owner.
  const browser = installVoiceWebRtcBrowserBoundary({ createAudioContext: () => context as AudioContext | null });
  browsers.push(browser);
  // Allocate the physical first reply without reading a pre-acquisition getter;
  // later SDK acquisitions still receive fresh tracks from the canonical port.
  const firstCapture = browser.allocateCapture();
  const acquire = vi.mocked(navigator.mediaDevices.getUserMedia).getMockImplementation();
  if (!acquire) throw new Error('Browser MediaDevices boundary missing');
  let first = true;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async constraints => {
    if (first) { first = false; return firstCapture.stream; }
    return await acquire(constraints);
  });
  const track = Object.assign(firstCapture.track, { end: () => firstCapture.track.dispatchEvent(new Event('ended')) });
  vi.spyOn(track, 'removeEventListener');
  return { mic: browser.micSession, track };
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
  afterEach(async () => {
    for (const browser of browsers.splice(0).reverse()) {
      await browser.micSession.teardown();
      browser.restore();
    }
    vi.unstubAllGlobals();
  });

  it.each(['failure', 'cancel'] as const)('does not report a successful graceful drain after accepted callback %s', async (action) => {
    const { context, processor } = createContext({ sampleRate: 16_000 });
    const chunkResult = createDeferred<void>();
    const chunkEntered = createDeferred<void>();
    const signal = new AbortController();
    const capture = createWebPcmCapture({
      mic: createMic(context).mic, signal: signal.signal,
      format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' }, chunkMs: 20,
      fallback: 'allow_script_processor', onChunk: () => { chunkEntered.resolve(); return chunkResult.promise; },
    });
    let acceptedDrain: Promise<void> | undefined;
    try {
      await capture.start();
      processor.onaudioprocess?.(processEvent(new Float32Array(320), 16_000));
      await chunkEntered.promise;
      acceptedDrain = capture.waitForDrain();
      const outcome = capture.finish().then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
      if (action === 'failure') chunkResult.reject(new Error('consumer failed'));
      else signal.abort();
      // Cancellation must settle finish while the accepted callback is still held.
      expect(await outcome).toMatchObject(action === 'failure'
        ? { ok: false, error: { code: 'pcm_capture_chunk_failed' } }
        : { ok: false, error: { name: 'AbortError' } });
      expect(capture.isActive()).toBe(false);
    } finally {
      chunkResult.resolve();
      await capture.stop();
      await acceptedDrain;
    }
  });

  it('finishes every accepted frame while prompt stop discards frames still queued for delivery', async () => {
    for (const graceful of [true, false]) {
      const { context, processor, source } = createContext({ sampleRate: 16_000 });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const chunkEntered = createDeferred<void>();
      const delivered: number[] = [];
      const capture = createWebPcmCapture({
        mic: createMic(context).mic,
        format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' },
        chunkMs: 20, fallback: 'allow_script_processor',
        onChunk: async () => { delivered.push(delivered.length); chunkEntered.resolve(); await held; },
      });
      await capture.start();
      processor.onaudioprocess?.(processEvent(new Float32Array(960), 16_000));
      await chunkEntered.promise;
      let settled = false;
      const stopping = (graceful ? capture.finish() : capture.stop()).then(() => { settled = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(source.disconnect).toHaveBeenCalled();
      expect(capture.isActive()).toBe(false);
      expect(settled).toBe(!graceful);
      release();
      await stopping;
      await capture.waitForDrain();
      expect(delivered).toHaveLength(graceful ? 3 : 1);
    }
  });

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

  it('settles capture stop while its mic owner retires an unanswered acquisition before retry', async () => {
    const { context } = createContext({ worklet: true });
    installWorklet();
    const { mic } = createMic(context);
    let acquisitions = 0;
    const acquisitionEntered = createDeferred<void>();
    const acquire = vi.mocked(navigator.mediaDevices.getUserMedia).getMockImplementation();
    if (!acquire) throw new Error('Browser MediaDevices boundary missing');
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async constraints => {
      acquisitions += 1;
      // An unanswered browser permission prompt cannot be settled by capture.
      if (acquisitions === 1) { acquisitionEntered.resolve(); return await new Promise<MediaStream>(() => {}); }
      return await acquire(constraints);
    });
    const capture = createWebPcmCapture({
      mic, format: { sampleRate: 24_000, channels: 1, encoding: 'pcm16le' }, chunkMs: 20,
      fallback: 'allow_script_processor', onChunk: vi.fn(async () => {}),
    });

    const start = capture.start();
    void start.catch(() => undefined);
    await acquisitionEntered.promise;
    expect(mic.ensureActive).toHaveBeenCalledTimes(1);

    await capture.stop();
    expect(capture.isActive()).toBe(false);

    await mic.teardown();
    await capture.start();
    expect(mic.ensureActive).toHaveBeenCalledTimes(2);
    expect(capture.isActive()).toBe(true);
    await capture.stop();
  });

  it('invokes AudioWorklet.addModule with its native receiver', async () => {
    let receiver: unknown = null;
    const addModule = vi.fn(async function (this: unknown) {
      receiver = this;
    });
    const { context } = createContext({ worklet: true, addModule });
    installWorklet();
    const capture = createWebPcmCapture({
      mic: createMic(context).mic,
      format: { sampleRate: 24_000, channels: 1, encoding: 'pcm16le' },
      chunkMs: 20,
      fallback: 'allow_script_processor',
      onChunk: vi.fn(),
    });

    await capture.start();

    expect(receiver).toBe(context.audioWorklet);
    expect(context.createScriptProcessor).not.toHaveBeenCalled();
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
    const { context, source } = createContext();
    const { mic } = createMic(context);
    await mic.ensureActive();
    context.state = 'suspended';
    // Both the mic and capture owners may try the browser's resume operation;
    // a sustained native denial must fail capture without connected nodes.
    context.resume.mockRejectedValue(new Error('resume denied'));
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
    expect(onError).toHaveBeenCalledWith('pcm_capture_resume_failed');
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
    expect(onError).toHaveBeenCalledWith('pcm_capture_backpressure');
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
    const workletEntered = createDeferred<void>();
    const addModule = vi.fn(async () => await new Promise<void>((resolve) => { release = resolve; workletEntered.resolve(); }));
    const { context, source } = createContext({ worklet: true, addModule });
    installWorklet();
    const abort = new AbortController();
    const capture = createWebPcmCapture({
      mic: createMic(context).mic, format: { sampleRate: 16_000, channels: 1, encoding: 'pcm16le' }, chunkMs: 20,
      fallback: 'disabled', signal: abort.signal, onChunk: vi.fn(async () => {}),
    });
    const starting = capture.start();
    await workletEntered.promise;
    expect(addModule).toHaveBeenCalled();
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
    expect(capture.isActive()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('pcm_capture_device_lost');
  });

  it('reports microphone acquisition failure separately from later capture setup', async () => {
    const { context } = createContext();
    const { mic } = createMic(context);
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new Error('permission denied'));
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
    expect(onError).toHaveBeenCalledWith('pcm_capture_mic_acquisition_failed');
  });

  it('reports missing stream or audio context separately from microphone acquisition', async () => {
    const { mic } = createMic(null);
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
    expect(onError).toHaveBeenCalledWith('pcm_capture_mic_state_unavailable');
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
    expect(onError).toHaveBeenCalledWith('pcm_capture_media_source_failed');
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
    expect(capture.isActive()).toBe(false);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(node.port.close).toHaveBeenCalledTimes(1);
    expect(track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
  });
});
