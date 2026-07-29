import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

const terminalProtocol = protocol as Record<string, any>;

function requireTerminalStreamApi() {
  expect(typeof terminalProtocol.TerminalStreamBytesFrameSchema?.safeParse).toBe('function');
  expect(typeof terminalProtocol.TerminalStreamReadRequestSchema?.safeParse).toBe('function');
  expect(typeof terminalProtocol.TerminalStreamReadResponseSchema?.safeParse).toBe('function');
  expect(typeof terminalProtocol.TerminalStreamAckRequestSchema?.safeParse).toBe('function');
  expect(typeof terminalProtocol.encodeTerminalStreamBytes).toBe('function');
  expect(typeof terminalProtocol.decodeTerminalStreamBytesFrame).toBe('function');
  return terminalProtocol;
}

describe('terminal byte stream protocol', () => {
  it('preserves arbitrary invalid UTF-8 bytes through bounded base64 frames', () => {
    const api = requireTerminalStreamApi();
    const bytes = Uint8Array.from([0, 0xff, 0xc3, 0x28, 0x1b, 0x5b, 0x31, 0x6d]);

    const parsed = api.TerminalStreamBytesFrameSchema.parse({
      t: 'bytes',
      terminalId: 'term-1',
      seq: 7,
      byteOffset: 42,
      byteLength: bytes.byteLength,
      encoding: 'base64',
      data: api.encodeTerminalStreamBytes(bytes),
    });

    expect(Array.from(api.decodeTerminalStreamBytesFrame(parsed))).toEqual(Array.from(bytes));
  });

  it('rejects unsupported encodings, malformed base64, decoded-size mismatches, oversized frames, and raw bytes', () => {
    const api = requireTerminalStreamApi();
    const schema = api.TerminalStreamBytesFrameSchema;
    const valid = {
      t: 'bytes',
      terminalId: 'term-1',
      seq: 1,
      byteOffset: 0,
      byteLength: 3,
      encoding: 'base64',
      data: api.encodeTerminalStreamBytes(Uint8Array.from([1, 2, 3])),
    };

    expect(schema.safeParse({ ...valid, encoding: 'utf8' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, data: '@@@', byteLength: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, byteLength: 4 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, byteLength: api.TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES + 1 }).success)
      .toBe(false);
    expect(schema.safeParse({ ...valid, data: Uint8Array.from([1, 2, 3]) }).success).toBe(false);
  });

  it('rejects malformed offsets and ack ranges', () => {
    const api = requireTerminalStreamApi();

    expect(api.TerminalStreamReadRequestSchema.safeParse({
      terminalId: 'term-1',
      byteOffset: -1,
    }).success).toBe(false);
    expect(api.TerminalStreamReadRequestSchema.safeParse({
      terminalId: 'term-1',
      byteOffset: 10,
      ackedByteOffset: 11,
    }).success).toBe(false);
    expect(api.TerminalStreamAckRequestSchema.safeParse({
      terminalId: 'term-1',
      ackedByteOffset: -1,
    }).success).toBe(false);
  });

  it('rejects malformed gap and response offset ordering', () => {
    const api = requireTerminalStreamApi();
    const bytes = Uint8Array.from([1, 2, 3]);

    expect(api.TerminalStreamControlFrameSchema.safeParse({
      t: 'gap',
      terminalId: 'term-1',
      droppedBeforeByteOffset: 20,
      nextAvailableByteOffset: 10,
      reason: 'ring_overflow',
    }).success).toBe(false);
    expect(api.TerminalStreamReadResponseSchema.safeParse({
      ok: true,
      terminalId: 'term-1',
      frames: [],
      nextByteOffset: 9,
      availableByteOffset: 10,
      droppedBeforeByteOffset: 10,
      done: false,
    }).success).toBe(false);
    expect(api.TerminalStreamReadResponseSchema.safeParse({
      ok: true,
      terminalId: 'term-1',
      frames: [],
      nextByteOffset: 11,
      availableByteOffset: 10,
      droppedBeforeByteOffset: 0,
      done: false,
    }).success).toBe(false);
    expect(api.TerminalStreamReadResponseSchema.safeParse({
      ok: true,
      terminalId: 'term-1',
      frames: [{
        t: 'bytes',
        terminalId: 'term-1',
        seq: 1,
        byteOffset: 12,
        byteLength: bytes.byteLength,
        encoding: 'base64',
        data: api.encodeTerminalStreamBytes(bytes),
      }],
      nextByteOffset: 10,
      availableByteOffset: 20,
      droppedBeforeByteOffset: 0,
      done: false,
    }).success).toBe(false);
    expect(api.TerminalStreamReadResponseSchema.safeParse({
      ok: true,
      terminalId: 'term-1',
      frames: [{
        t: 'url',
        terminalId: 'other-term',
        byteOffset: 0,
        url: 'https://example.test',
        kind: 'generic',
      }],
      nextByteOffset: 0,
      availableByteOffset: 0,
      droppedBeforeByteOffset: 0,
      done: false,
    }).success).toBe(false);
  });

  it('rejects future control frames not emitted or handled by TERM V1 byte streams', () => {
    const api = requireTerminalStreamApi();

    for (const frame of [
      {
        t: 'preamble',
        terminalId: 'term-1',
        byteOffset: 0,
        data: '',
        encoding: 'base64',
        mode: 'xterm-256color',
        generatedAt: 1,
      },
      {
        t: 'title',
        terminalId: 'term-1',
        byteOffset: 0,
        title: 'Terminal',
      },
      {
        t: 'resize',
        terminalId: 'term-1',
        cols: 80,
        rows: 24,
        observedAt: 1,
      },
      {
        t: 'error',
        terminalId: 'term-1',
        code: 'terminal_error',
        message: 'terminal_error',
      },
    ]) {
      expect(api.TerminalStreamControlFrameSchema.safeParse(frame).success).toBe(false);
    }
  });

  it('rejects responses whose decoded byte frames exceed the read cap', () => {
    const api = requireTerminalStreamApi();
    const chunk = new Uint8Array(api.TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES);
    const frames = Array.from({ length: 5 }, (_, index) => ({
      t: 'bytes',
      terminalId: 'term-1',
      seq: index,
      byteOffset: index * chunk.byteLength,
      byteLength: chunk.byteLength,
      encoding: 'base64',
      data: api.encodeTerminalStreamBytes(chunk),
    }));

    expect(api.TerminalStreamReadResponseSchema.safeParse({
      ok: true,
      terminalId: 'term-1',
      frames,
      nextByteOffset: api.TERMINAL_STREAM_MAX_READ_BYTES + chunk.byteLength,
      availableByteOffset: api.TERMINAL_STREAM_MAX_READ_BYTES + chunk.byteLength,
      droppedBeforeByteOffset: 0,
      done: false,
    }).success).toBe(false);
  });

  it('accepts structured legacy-only responses without pretending byte support exists', () => {
    const api = requireTerminalStreamApi();

    const parsed = api.TerminalStreamReadResponseSchema.parse({
      ok: true,
      terminalId: 'term-1',
      frames: [{
        t: 'legacyOnly',
        terminalId: 'term-1',
        provider: 'windows-conpty',
        reason: 'raw byte capture is unavailable',
      }],
      nextByteOffset: 0,
      availableByteOffset: 0,
      droppedBeforeByteOffset: 0,
      done: false,
    });

    expect(parsed.frames[0].t).toBe('legacyOnly');
  });
});
