import { z } from 'zod';

const LINE_CONTENT_HASH_PREFIX = 'lh1:';
const LINE_CONTENT_HASH_PATTERN = /^lh1:[0-9a-f]{16}$/;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export type LineContentHashV1 = `lh1:${string}`;

export function isLineContentHashV1(value: unknown): value is LineContentHashV1 {
  return typeof value === 'string' && LINE_CONTENT_HASH_PATTERN.test(value);
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

const LineContentHashV1Schema = z.custom<LineContentHashV1>(isLineContentHashV1);

export const WorkspaceAnchorV1Schema = z.union([
  z.object({
    kind: z.literal('fileLine'),
    startLine: z.number().int().positive(),
    lineHash: LineContentHashV1Schema.optional(),
  }),
  z.object({
    kind: z.literal('diffLine'),
    startLine: z.number().int().positive(),
    side: z.enum(['before', 'after']),
    oldLine: z.number().int().positive().nullable(),
    newLine: z.number().int().positive().nullable(),
    lineHash: LineContentHashV1Schema.optional(),
  }),
  z.object({
    kind: z.literal('line'),
    filePath: z.string(),
    line: z.number().int().positive(),
    side: z.enum(['before', 'after']).optional(),
    lineHash: LineContentHashV1Schema.optional(),
  }),
  z.object({
    kind: z.literal('range'),
    filePath: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    side: z.enum(['before', 'after']).optional(),
    startLineHash: LineContentHashV1Schema.optional(),
    endLineHash: LineContentHashV1Schema.optional(),
    selectedTextHash: LineContentHashV1Schema.optional(),
  }).refine((anchor) => anchor.endLine >= anchor.startLine, {
    message: 'endLine must be greater than or equal to startLine',
    path: ['endLine'],
  }),
]);

export type WorkspaceAnchorV1 = z.infer<typeof WorkspaceAnchorV1Schema>;

export const WorkspaceAnchorSourceV1Schema = z.enum(['file', 'diff']);
export type WorkspaceAnchorSourceV1 = z.infer<typeof WorkspaceAnchorSourceV1Schema>;

export const WorkspaceAnchorSnapshotV1Schema = z.object({
  selectedLines: z.array(z.string()),
  beforeContext: z.array(z.string()),
  afterContext: z.array(z.string()),
});
export type WorkspaceAnchorSnapshotV1 = z.infer<typeof WorkspaceAnchorSnapshotV1Schema>;

export const WorkspaceAnchorsResolveRequestV1Schema = z.object({
  workspacePath: z.string().min(1),
  comments: z.array(z.object({
    id: z.string().optional(),
    filePath: z.string().min(1),
    source: WorkspaceAnchorSourceV1Schema,
    anchor: WorkspaceAnchorV1Schema,
    snapshot: WorkspaceAnchorSnapshotV1Schema.optional(),
  })),
});
export type WorkspaceAnchorsResolveRequestV1 = z.infer<typeof WorkspaceAnchorsResolveRequestV1Schema>;

export const WorkspaceAnchorResolutionStatusV1Schema = z.enum([
  'exact',
  'hash',
  'context',
  'ambiguous',
  'stale',
  'missing',
  'unsupported',
]);
export type WorkspaceAnchorResolutionStatusV1 = z.infer<typeof WorkspaceAnchorResolutionStatusV1Schema>;

export const WorkspaceAnchorResolutionV1Schema = z.object({
  id: z.string().optional(),
  filePath: z.string(),
  originalAnchor: WorkspaceAnchorV1Schema,
  resolvedAnchor: WorkspaceAnchorV1Schema.optional(),
  status: WorkspaceAnchorResolutionStatusV1Schema,
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
  preview: WorkspaceAnchorSnapshotV1Schema.optional(),
});
export type WorkspaceAnchorResolutionV1 = z.infer<typeof WorkspaceAnchorResolutionV1Schema>;

export const WorkspaceAnchorsResolveResponseV1Schema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    resolutions: z.array(WorkspaceAnchorResolutionV1Schema),
  }),
  z.object({
    success: z.literal(false),
    errorCode: z.string(),
    error: z.string(),
  }),
]);
export type WorkspaceAnchorsResolveResponseV1 = z.infer<typeof WorkspaceAnchorsResolveResponseV1Schema>;
