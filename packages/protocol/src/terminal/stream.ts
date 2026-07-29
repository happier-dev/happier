import { fromByteArray, toByteArray } from 'base64-js';
import { z } from 'zod';

import { readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';

export const TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES = 256 * 1024;
export const TERMINAL_STREAM_MAX_READ_BYTES = 1024 * 1024;
export const TERMINAL_STREAM_MAX_FRAMES = 2048;
export const TERMINAL_STREAM_MAX_ENCODED_BYTES =
  Math.ceil(TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES / 3) * 4;

export const TerminalStreamBytesEncodingSchema = z.literal('base64');
export type TerminalStreamBytesEncoding = z.infer<typeof TerminalStreamBytesEncodingSchema>;

function readStrictBase64DecodedLength(input: string): number | null {
  return readCanonicalPaddedBase64DecodedLength(input);
}

function decodeStrictBase64(input: string): Uint8Array {
  if (readStrictBase64DecodedLength(input) === null) {
    throw new Error('Invalid terminal stream base64 payload');
  }
  return toByteArray(input);
}

export function encodeTerminalStreamBytes(bytes: Uint8Array): string {
  return fromByteArray(bytes);
}

const TerminalIdSchema = z.string().min(1).max(2000);
const ByteOffsetSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ByteLengthSchema = z.number().int().min(0).max(TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES);

export const TerminalStreamBytesFrameSchema = z
  .object({
    t: z.literal('bytes'),
    terminalId: TerminalIdSchema,
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    byteOffset: ByteOffsetSchema,
    byteLength: ByteLengthSchema,
    encoding: TerminalStreamBytesEncodingSchema,
    data: z.string().max(TERMINAL_STREAM_MAX_ENCODED_BYTES),
  })
  .superRefine((frame, ctx) => {
    const decodedLength = readStrictBase64DecodedLength(frame.data);
    if (decodedLength === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: 'data must be canonical padded base64',
      });
      return;
    }
    if (decodedLength !== frame.byteLength) {
      ctx.addIssue({
        code: 'custom',
        path: ['byteLength'],
        message: 'byteLength must match decoded data length',
      });
    }
  });
export type TerminalStreamBytesFrame = z.infer<typeof TerminalStreamBytesFrameSchema>;

export function decodeTerminalStreamBytesFrame(frame: TerminalStreamBytesFrame): Uint8Array {
  const parsed = TerminalStreamBytesFrameSchema.parse(frame);
  return decodeStrictBase64(parsed.data);
}

export const TerminalStreamControlFrameSchema = z
  .discriminatedUnion('t', [
    z.object({
      t: z.literal('gap'),
      terminalId: TerminalIdSchema,
      droppedBeforeByteOffset: ByteOffsetSchema,
      nextAvailableByteOffset: ByteOffsetSchema,
      reason: z.enum(['ring_overflow', 'consumer_too_slow', 'session_restarted']),
    }),
    z.object({
      t: z.literal('url'),
      terminalId: TerminalIdSchema,
      byteOffset: ByteOffsetSchema,
      url: z.string().url(),
      kind: z.enum(['auth', 'generic']),
      suggestOpen: z.boolean().optional(),
    }),
    z.object({
      t: z.literal('exit'),
      terminalId: TerminalIdSchema,
      byteOffset: ByteOffsetSchema,
      exitCode: z.number().int().nullable(),
      signal: z.number().int().nullable(),
    }),
    z.object({
      t: z.literal('legacyOnly'),
      terminalId: TerminalIdSchema,
      provider: z.enum(['windows-conpty', 'python-relay', 'unknown']),
      reason: z.string().min(1).max(2000),
    }),
  ])
  .superRefine((frame, ctx) => {
    if (frame.t === 'gap' && frame.droppedBeforeByteOffset > frame.nextAvailableByteOffset) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextAvailableByteOffset'],
        message: 'nextAvailableByteOffset must be greater than or equal to droppedBeforeByteOffset',
      });
    }
  });
export type TerminalStreamControlFrame = z.infer<typeof TerminalStreamControlFrameSchema>;

export const TerminalStreamFrameSchema = z.union([
  TerminalStreamBytesFrameSchema,
  TerminalStreamControlFrameSchema,
]);
export type TerminalStreamFrame = z.infer<typeof TerminalStreamFrameSchema>;

export const TerminalStreamReadRequestSchema = z
  .object({
    terminalId: TerminalIdSchema,
    byteOffset: ByteOffsetSchema,
    ackedByteOffset: ByteOffsetSchema.optional(),
    creditBytes: z.number().int().min(0).max(TERMINAL_STREAM_MAX_READ_BYTES).optional(),
    maxBytes: z.number().int().min(1).max(TERMINAL_STREAM_MAX_READ_BYTES).optional(),
    maxFrames: z.number().int().min(1).max(TERMINAL_STREAM_MAX_FRAMES).optional(),
    rendererId: z.string().min(1).max(200).optional(),
    surfaceEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .superRefine((request, ctx) => {
    if (request.ackedByteOffset !== undefined && request.ackedByteOffset > request.byteOffset) {
      ctx.addIssue({
        code: 'custom',
        path: ['ackedByteOffset'],
        message: 'ackedByteOffset must not be greater than byteOffset',
      });
    }
  });
export type TerminalStreamReadRequest = z.infer<typeof TerminalStreamReadRequestSchema>;

export const TerminalStreamReadOkResponseSchema = z
  .object({
    ok: z.literal(true),
    terminalId: TerminalIdSchema,
    frames: z.array(TerminalStreamFrameSchema).max(TERMINAL_STREAM_MAX_FRAMES),
    nextByteOffset: ByteOffsetSchema,
    availableByteOffset: ByteOffsetSchema,
    droppedBeforeByteOffset: ByteOffsetSchema,
    done: z.boolean(),
  })
  .superRefine((response, ctx) => {
    if (response.droppedBeforeByteOffset > response.nextByteOffset) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextByteOffset'],
        message: 'nextByteOffset must be greater than or equal to droppedBeforeByteOffset',
      });
    }
    if (response.nextByteOffset > response.availableByteOffset) {
      ctx.addIssue({
        code: 'custom',
        path: ['availableByteOffset'],
        message: 'availableByteOffset must be greater than or equal to nextByteOffset',
      });
    }
    let decodedByteTotal = 0;
    response.frames.forEach((frame, index) => {
      if (frame.terminalId !== response.terminalId) {
        ctx.addIssue({
          code: 'custom',
          path: ['frames', index, 'terminalId'],
          message: 'frame terminalId must match response terminalId',
        });
      }
      if (frame.t === 'bytes') {
        const frameEnd = frame.byteOffset + frame.byteLength;
        if (!Number.isSafeInteger(frameEnd) || frameEnd > response.nextByteOffset) {
          ctx.addIssue({
            code: 'custom',
            path: ['frames', index, 'byteOffset'],
            message: 'bytes frame range must end at or before nextByteOffset',
          });
        }
        if (frame.byteOffset < response.droppedBeforeByteOffset) {
          ctx.addIssue({
            code: 'custom',
            path: ['frames', index, 'byteOffset'],
            message: 'bytes frame byteOffset must be greater than or equal to droppedBeforeByteOffset',
          });
        }
        decodedByteTotal += frame.byteLength;
      }
    });
    if (decodedByteTotal > TERMINAL_STREAM_MAX_READ_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['frames'],
        message: 'decoded bytes in response must not exceed max read bytes',
      });
    }
  });

export const TerminalStreamUnavailableResponseSchema = z.object({
  ok: z.literal(false),
  code: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
});

export const TerminalStreamReadResponseSchema = z.union([
  TerminalStreamReadOkResponseSchema,
  TerminalStreamUnavailableResponseSchema,
]);
export type TerminalStreamReadResponse = z.infer<typeof TerminalStreamReadResponseSchema>;

export const TerminalStreamAckRequestSchema = z.object({
  terminalId: TerminalIdSchema,
  ackedByteOffset: ByteOffsetSchema,
  rendererId: z.string().min(1).max(200).optional(),
  surfaceEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  creditBytes: z.number().int().min(0).max(TERMINAL_STREAM_MAX_READ_BYTES).optional(),
});
export type TerminalStreamAckRequest = z.infer<typeof TerminalStreamAckRequestSchema>;

export const TerminalStreamAckResponseSchema = z.union([
  z.object({ ok: z.literal(true) }),
  TerminalStreamUnavailableResponseSchema,
]);
export type TerminalStreamAckResponse = z.infer<typeof TerminalStreamAckResponseSchema>;
