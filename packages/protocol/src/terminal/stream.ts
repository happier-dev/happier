import { lazyZodSchema } from '../lazyZodSchema.js';
import { fromByteArray, toByteArray } from 'base64-js';
import { z } from '../zodRuntimePolicy.js';

import { readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';

export const TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES = 256 * 1024;
export const TERMINAL_STREAM_MAX_READ_BYTES = 1024 * 1024;
export const TERMINAL_STREAM_MAX_FRAMES = 2048;
export const TERMINAL_STREAM_MAX_ENCODED_BYTES =
  Math.ceil(TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES / 3) * 4;

export const TerminalStreamBytesEncodingSchema = lazyZodSchema(() => z.literal('base64'));
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

const TerminalIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(2000)));
const ByteOffsetSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));
const ByteLengthSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES)));

export const TerminalStreamBytesFrameSchema = lazyZodSchema(() => z.strictObject({
    t: z.literal('bytes'),
    terminalId: TerminalIdSchema,
    seq: z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
    byteOffset: ByteOffsetSchema,
    byteLength: ByteLengthSchema,
    encoding: TerminalStreamBytesEncodingSchema,
    data: z.string().check(z.maxLength(TERMINAL_STREAM_MAX_ENCODED_BYTES)),
  }).check(z.superRefine((frame, ctx) => {
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
  })));
export type TerminalStreamBytesFrame = z.infer<typeof TerminalStreamBytesFrameSchema>;

export function decodeTerminalStreamBytesFrame(frame: TerminalStreamBytesFrame): Uint8Array {
  const parsed = TerminalStreamBytesFrameSchema.parse(frame);
  return decodeStrictBase64(parsed.data);
}

export const TerminalStreamControlFrameSchema = lazyZodSchema(() => z
  .discriminatedUnion('t', [
    z.strictObject({
      t: z.literal('gap'),
      terminalId: TerminalIdSchema,
      droppedBeforeByteOffset: ByteOffsetSchema,
      nextAvailableByteOffset: ByteOffsetSchema,
      reason: z.enum(['ring_overflow', 'consumer_too_slow', 'session_restarted']),
    }),
    z.strictObject({
      t: z.literal('url'),
      terminalId: TerminalIdSchema,
      byteOffset: ByteOffsetSchema,
      url: z.string().check(z.url()),
      kind: z.enum(['auth', 'generic']),
      suggestOpen: z.optional(z.boolean()),
    }),
    z.strictObject({
      t: z.literal('exit'),
      terminalId: TerminalIdSchema,
      byteOffset: ByteOffsetSchema,
      exitCode: z.nullable(z.number().check(z.int())),
      signal: z.nullable(z.number().check(z.int())),
    }),
    z.strictObject({
      t: z.literal('legacyOnly'),
      terminalId: TerminalIdSchema,
      provider: z.enum(['windows-conpty', 'python-relay', 'unknown']),
      reason: z.string().check(z.minLength(1), z.maxLength(2000)),
    }),
  ]).check(z.superRefine((frame, ctx) => {
    if (frame.t === 'gap' && frame.droppedBeforeByteOffset > frame.nextAvailableByteOffset) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextAvailableByteOffset'],
        message: 'nextAvailableByteOffset must be greater than or equal to droppedBeforeByteOffset',
      });
    }
  })));
export type TerminalStreamControlFrame = z.infer<typeof TerminalStreamControlFrameSchema>;

export const TerminalStreamFrameSchema = lazyZodSchema(() => z.union([
  TerminalStreamBytesFrameSchema,
  TerminalStreamControlFrameSchema,
]));
export type TerminalStreamFrame = z.infer<typeof TerminalStreamFrameSchema>;

export const TerminalStreamReadRequestSchema = lazyZodSchema(() => z.strictObject({
    terminalId: TerminalIdSchema,
    byteOffset: ByteOffsetSchema,
    controlCursor: z.optional(ByteOffsetSchema),
    ackedByteOffset: z.optional(ByteOffsetSchema),
    creditBytes: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(TERMINAL_STREAM_MAX_READ_BYTES))),
    maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(TERMINAL_STREAM_MAX_READ_BYTES))),
    maxFrames: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(TERMINAL_STREAM_MAX_FRAMES))),
    rendererId: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
    surfaceEpoch: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER))),
    /** An idle viewer's read stays one pending RPC until output, exit or access loss. */
    holdForOutput: z.optional(z.boolean()),
  }).check(z.superRefine((request, ctx) => {
    if (request.ackedByteOffset !== undefined && request.ackedByteOffset > request.byteOffset) {
      ctx.addIssue({
        code: 'custom',
        path: ['ackedByteOffset'],
        message: 'ackedByteOffset must not be greater than byteOffset',
      });
    }
  })));
export type TerminalStreamReadRequest = z.infer<typeof TerminalStreamReadRequestSchema>;

export const TerminalStreamReadOkResponseSchema = lazyZodSchema(() => z.strictObject({
    ok: z.literal(true),
    terminalId: TerminalIdSchema,
    frames: z.array(TerminalStreamFrameSchema).check(z.maxLength(TERMINAL_STREAM_MAX_FRAMES)),
    nextByteOffset: ByteOffsetSchema,
    availableByteOffset: ByteOffsetSchema,
    droppedBeforeByteOffset: ByteOffsetSchema,
    nextControlCursor: z.optional(ByteOffsetSchema),
    /** Echoed only for an opted-in reader whose daemon supports held reads. */
    holdForOutput: z.optional(z.literal(true)),
    done: z.boolean(),
  }).check(z.superRefine((response, ctx) => {
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
    let expectedByteOffset: number | null = null;
    let sawBytesFrame = false;
    let sawGapFrame = false;
    response.frames.forEach((frame, index) => {
      if (frame.terminalId !== response.terminalId) {
        ctx.addIssue({
          code: 'custom',
          path: ['frames', index, 'terminalId'],
          message: 'frame terminalId must match response terminalId',
        });
      }
      if (frame.t === 'gap') {
        if (sawBytesFrame || sawGapFrame) {
          ctx.addIssue({
            code: 'custom',
            path: ['frames', index],
            message: 'gap frame must appear at most once and before byte frames',
          });
        }
        sawGapFrame = true;
        expectedByteOffset = frame.nextAvailableByteOffset;
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
        if (expectedByteOffset !== null && frame.byteOffset !== expectedByteOffset) {
          ctx.addIssue({
            code: 'custom',
            path: ['frames', index, 'byteOffset'],
            message: 'bytes frame ranges must be ordered and contiguous',
          });
        }
        sawBytesFrame = true;
        expectedByteOffset = frameEnd;
        decodedByteTotal += frame.byteLength;
      }
    });
    if ((sawBytesFrame || sawGapFrame) && expectedByteOffset !== response.nextByteOffset) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextByteOffset'],
        message: 'nextByteOffset must match the end of the delivered byte range',
      });
    }
    if (decodedByteTotal > TERMINAL_STREAM_MAX_READ_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['frames'],
        message: 'decoded bytes in response must not exceed max read bytes',
      });
    }
  })));

export const TerminalStreamUnavailableResponseSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  code: z.string().check(z.minLength(1), z.maxLength(200)),
  message: z.string().check(z.minLength(1), z.maxLength(2000)),
}));

export const TerminalStreamReadResponseSchema = lazyZodSchema(() => z.union([
  TerminalStreamReadOkResponseSchema,
  TerminalStreamUnavailableResponseSchema,
]));
export type TerminalStreamReadResponse = z.infer<typeof TerminalStreamReadResponseSchema>;

export const TerminalStreamAckRequestSchema = lazyZodSchema(() => z.strictObject({
  terminalId: TerminalIdSchema,
  ackedByteOffset: ByteOffsetSchema,
  rendererId: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
  surfaceEpoch: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER))),
  creditBytes: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(TERMINAL_STREAM_MAX_READ_BYTES))),
}));
export type TerminalStreamAckRequest = z.infer<typeof TerminalStreamAckRequestSchema>;

export const TerminalStreamAckResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true) }),
  TerminalStreamUnavailableResponseSchema,
]));
export type TerminalStreamAckResponse = z.infer<typeof TerminalStreamAckResponseSchema>;
