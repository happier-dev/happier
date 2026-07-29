import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineVoiceInferenceTtsStreamingRpcHandlers } from './rpcHandlers.voiceInferenceTtsStreaming';
import { createDiagnosticsControllerWithRemovalFailure } from '../../daemon/voiceDiagnostics/controller.testkit';

type Handler = (data: unknown) => Promise<unknown>;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('registerMachineVoiceInferenceTtsStreamingRpcHandlers', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-tts-stream-handler-'));
    tempDirs.push(dir);
    return dir;
  }

  it('registers segmented TTS start/next/ack/cancel handlers and preserves per-segment synthesis', async () => {
    const root = await createTempDir();
    let segmentCounter = 0;
    const synthesizeTts = vi.fn(async (input: any) => {
      const segmentIndex = segmentCounter;
      segmentCounter += 1;
      const filePath = join(root, `segment-${segmentIndex}.wav`);
      await writeFile(filePath, Buffer.from(`audio-${segmentIndex}`));
      return {
        requestId: input.requestId,
        output: input.output,
        filePath,
        sizeBytes: (await readFile(filePath)).byteLength,
        name: `segment-${segmentIndex}.wav`,
      };
    });
    const mgr = createRpcHandlerManager();
    const capture = vi.fn(async () => null);
    const registration = registerMachineVoiceInferenceTtsStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        synthesizeTts,
        cancelTts: vi.fn(async () => {}),
      },
      streamRoot: root,
      voiceDiagnostics: { capture } as any,
    });

    const start = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START);
    const next = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT);
    const ack = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK);
    const cancel = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL);
    expect(start).toBeTypeOf('function');
    expect(next).toBeTypeOf('function');
    expect(ack).toBeTypeOf('function');
    expect(cancel).toBeTypeOf('function');

    const started = await start?.({
      requestId: 'tts-handler-1',
      text: 'First sentence. Second sentence.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      prefetchDepth: 1,
      diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    }) as any;
    expect(started).toMatchObject({ ok: true, segmentCount: 2 });

    const segment = await next?.({
      streamId: started.streamId,
      generation: started.generation,
    }) as any;
    expect(segment).toMatchObject({
      ok: true,
      event: {
        type: 'segment',
        segmentIndex: 0,
        audio: { contentBase64: Buffer.from('audio-0').toString('base64') },
      },
    });
    expect(capture).not.toHaveBeenCalled();
    await expect(ack?.({
      streamId: started.streamId,
      generation: started.generation,
      segmentId: segment.event.segmentId,
      segmentIndex: 0,
    })).resolves.toMatchObject({ ok: true, ackedSegmentIndex: 0 });

    await expect(registration.dispose()).resolves.toBeUndefined();
    await expect(cancel?.({
      streamId: started.streamId,
      generation: started.generation,
      reason: 'client_dispose',
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
  });

  it('persists segmented TTS diagnostics only after terminal success and drops cancelled output', async () => {
    const root = await createTempDir();
    const synthesizeTts = vi.fn(async (input: any) => {
      const filePath = join(root, `${input.requestId}.wav`);
      await writeFile(filePath, Buffer.from(`audio:${input.text}`));
      return {
        requestId: input.requestId,
        output: input.output,
        filePath,
        sizeBytes: (await readFile(filePath)).byteLength,
        name: 'segment.wav',
      };
    });
    const mgr = createRpcHandlerManager();
    const capture = vi.fn(async () => null);
    const registration = registerMachineVoiceInferenceTtsStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: { synthesizeTts, cancelTts: vi.fn(async () => {}) },
      streamRoot: root,
      voiceDiagnostics: { capture } as any,
    });
    const start = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START)!;
    const next = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT)!;
    const ack = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK)!;
    const cancel = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL)!;

    const started = await start({
      requestId: 'tts-success', text: 'One sentence.', packId: 'pack', voiceId: null, speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' }, prefetchDepth: 1,
      diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    }) as any;
    const segment = await next({ streamId: started.streamId, generation: started.generation }) as any;
    expect(capture).not.toHaveBeenCalled();
    await ack({
      streamId: started.streamId,
      generation: started.generation,
      segmentId: segment.event.segmentId,
      segmentIndex: segment.event.segmentIndex,
    });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));

    capture.mockClear();
    const cancelled = await start({
      requestId: 'tts-cancel', text: 'Another sentence.', packId: 'pack', voiceId: null, speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' }, prefetchDepth: 1,
      diagnostics: { sessionId: 'session-1', captureAllowed: true, durationMs: null, authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637' },
    }) as any;
    await next({ streamId: cancelled.streamId, generation: cancelled.generation });
    await cancel({ streamId: cancelled.streamId, generation: cancelled.generation, reason: 'user_cancelled' });
    await Promise.resolve();
    expect(capture).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it('keeps segmented TTS usable while surfacing and recovering diagnostics retention failure', async () => {
    const diagnosticsHome = await createTempDir();
    const { controller, recoverRemoval } = await createDiagnosticsControllerWithRemovalFailure({
      happyHomeDir: diagnosticsHome,
    });
    const streamRoot = await createTempDir();
    const synthesizeTts = vi.fn(async (input: any) => {
      const filePath = join(streamRoot, `${input.requestId}.wav`);
      await writeFile(filePath, Buffer.from(`audio:${input.text}`));
      return {
        requestId: input.requestId,
        output: input.output,
        filePath,
        sizeBytes: (await readFile(filePath)).byteLength,
        name: 'segment.wav',
      };
    });
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceTtsStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: { synthesizeTts, cancelTts: vi.fn(async () => {}) },
      streamRoot,
      voiceDiagnostics: controller,
    });
    const start = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START)!;
    const next = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT)!;
    const ack = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK)!;

    const started = await start({
      requestId: 'tts-retention-failure', text: 'One sentence.', packId: 'pack', voiceId: null, speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' }, prefetchDepth: 1,
      diagnostics: {
        sessionId: 'session-1', captureAllowed: true, durationMs: null,
        authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
      },
    }) as any;
    const segment = await next({ streamId: started.streamId, generation: started.generation }) as any;
    await expect(ack({
      streamId: started.streamId,
      generation: started.generation,
      segmentId: segment.event.segmentId,
      segmentIndex: segment.event.segmentIndex,
    })).resolves.toMatchObject({ ok: true, complete: true });

    await vi.waitFor(async () => {
      await expect(controller.status()).resolves.toMatchObject({
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 1 },
        },
      });
    });
    recoverRemoval();
    await controller.deleteAll();
    await expect(controller.status()).resolves.toMatchObject({
      health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
    });
    await registration.dispose();
  });
});
