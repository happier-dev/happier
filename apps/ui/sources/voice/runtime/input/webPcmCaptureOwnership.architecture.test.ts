import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('web PCM capture ownership', () => {
  it('keeps AudioWorklet, resampling, framing, queueing, and visibility in one generic owner', () => {
    const owner = read('sources/voice/runtime/input/WebPcmCapture.web.ts');
    const daemon = read('sources/voice/runtime/daemonInference/WebDaemonSpeechPcmCapture.web.ts');
    const websocket = read('sources/voice/runtime/connection/WebSocketPcmMedia.ts');
    expect(owner).toContain('AudioWorkletNode');
    expect(owner).toContain('createScriptProcessor');
    for (const consumer of [daemon, websocket]) {
      expect(consumer).toContain('createWebPcmCapture');
      expect(consumer).not.toContain('AudioWorkletProcessor');
      expect(consumer).not.toContain('createScriptProcessor');
      expect(consumer).not.toContain('resampleFloat');
      expect(consumer).not.toContain('queuedChunks');
    }
  });
});
