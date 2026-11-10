import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

const LINE_CONTENT_HASH_PREFIX = 'lh1:';
const LineContentHashV1Schema = lazyZodSchema(() => z.templateLiteral([
  LINE_CONTENT_HASH_PREFIX,
  z.string().check(z.regex(/^[0-9a-f]{16}$/)),
]));
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export type LineContentHashV1 = `lh1:${string}`;

export function isLineContentHashV1(value: unknown): value is LineContentHashV1 {
  return LineContentHashV1Schema.safeParse(value).success;
}

function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

export function normalizeLineContentForHashV1(line: string): string {
  return String(line ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function computeLineContentHashV1(line: string): LineContentHashV1 {
  const normalized = normalizeLineContentForHashV1(line);
  let first = FNV_OFFSET_BASIS;
  let second = FNV_OFFSET_BASIS ^ normalized.length;

  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    first = Math.imul(first ^ code, FNV_PRIME);
    second = Math.imul(second ^ ((code << 5) | (code >>> 11)), FNV_PRIME);
  }

  return `${LINE_CONTENT_HASH_PREFIX}${toHex32(first)}${toHex32(second)}`;
}

export const WorkspaceAnchorV1Schema = lazyZodSchema(() => z.union([
  z.object({
    kind: z.literal('fileLine'),
    startLine: z.number().check(z.int(), z.positive()),
    lineHash: z.optional(LineContentHashV1Schema),
  }),
  z.object({
    kind: z.literal('diffLine'),
    startLine: z.number().check(z.int(), z.positive()),
    side: z.enum(['before', 'after']),
    oldLine: z.nullable(z.number().check(z.int(), z.positive())),
    newLine: z.nullable(z.number().check(z.int(), z.positive())),
    lineHash: z.optional(LineContentHashV1Schema),
  }),
  z.object({
    kind: z.literal('line'),
    filePath: z.string(),
    line: z.number().check(z.int(), z.positive()),
    side: z.optional(z.enum(['before', 'after'])),
    lineHash: z.optional(LineContentHashV1Schema),
  }),
  z.object({
    kind: z.literal('range'),
    filePath: z.string(),
    startLine: z.number().check(z.int(), z.positive()),
    endLine: z.number().check(z.int(), z.positive()),
    side: z.optional(z.enum(['before', 'after'])),
    startLineHash: z.optional(LineContentHashV1Schema),
    endLineHash: z.optional(LineContentHashV1Schema),
    selectedTextHash: z.optional(LineContentHashV1Schema),
  }).check(z.refine((anchor) => anchor.endLine >= anchor.startLine, {
    message: 'endLine must be greater than or equal to startLine',
    path: ['endLine'],
  })),
]));

export type WorkspaceAnchorV1 = z.infer<typeof WorkspaceAnchorV1Schema>;

export const WorkspaceAnchorSourceV1Schema = lazyZodSchema(() => z.enum(['file', 'diff']));
export type WorkspaceAnchorSourceV1 = z.infer<typeof WorkspaceAnchorSourceV1Schema>;

export const WorkspaceAnchorSnapshotV1Schema = lazyZodSchema(() => z.object({
  selectedLines: z.array(z.string()),
  beforeContext: z.array(z.string()),
  afterContext: z.array(z.string()),
}));
export type WorkspaceAnchorSnapshotV1 = z.infer<typeof WorkspaceAnchorSnapshotV1Schema>;

export const WorkspaceAnchorsResolveRequestV1Schema = lazyZodSchema(() => z.object({
  workspacePath: z.string().check(z.minLength(1)),
  comments: z.array(z.object({
    id: z.optional(z.string()),
    filePath: z.string().check(z.minLength(1)),
    source: WorkspaceAnchorSourceV1Schema,
    anchor: WorkspaceAnchorV1Schema,
    snapshot: z.optional(WorkspaceAnchorSnapshotV1Schema),
  })),
}));
export type WorkspaceAnchorsResolveRequestV1 = z.infer<typeof WorkspaceAnchorsResolveRequestV1Schema>;

export const WorkspaceAnchorResolutionStatusV1Schema = lazyZodSchema(() => z.enum([
  'exact',
  'hash',
  'context',
  'ambiguous',
  'stale',
  'missing',
  'unsupported',
]));
export type WorkspaceAnchorResolutionStatusV1 = z.infer<typeof WorkspaceAnchorResolutionStatusV1Schema>;

export const WorkspaceAnchorResolutionV1Schema = lazyZodSchema(() => z.object({
  id: z.optional(z.string()),
  filePath: z.string(),
  originalAnchor: WorkspaceAnchorV1Schema,
  resolvedAnchor: z.optional(WorkspaceAnchorV1Schema),
  status: WorkspaceAnchorResolutionStatusV1Schema,
  confidence: z.number().check(z.minimum(0), z.maximum(1)),
  reason: z.optional(z.string()),
  preview: z.optional(WorkspaceAnchorSnapshotV1Schema),
}));
export type WorkspaceAnchorResolutionV1 = z.infer<typeof WorkspaceAnchorResolutionV1Schema>;

export const WorkspaceAnchorsResolveResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    resolutions: z.array(WorkspaceAnchorResolutionV1Schema),
  }),
  z.object({
    success: z.literal(false),
    errorCode: z.string(),
    error: z.string(),
  }),
]));
export type WorkspaceAnchorsResolveResponseV1 = z.infer<typeof WorkspaceAnchorsResolveResponseV1Schema>;
