import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PromptDocArtifactRefV1Schema } from './promptArtifactRefsV1.js';
import { MemoryDocArtifactHeaderV1Schema, MemoryDocIndexV1Schema, MemoryTopicV1Schema } from './memoryDocV1.js';
import { QualifiedProjectKeyV1Schema } from '../../workspaces/workspaceRefV1.js';

export const MEMORY_DOCUMENT_ACTION_IDS_V1 = ['memory.remember', 'memory.update', 'memory.forget', 'memory.read', 'memory.list'] as const;
export type MemoryDocumentActionIdV1 = typeof MEMORY_DOCUMENT_ACTION_IDS_V1[number];
export const MEMORY_WRITE_ACTION_IDS_V1 = ['memory.remember', 'memory.update', 'memory.forget'] as const;
export function isMemoryWriteActionV1(id: string): id is typeof MEMORY_WRITE_ACTION_IDS_V1[number] {
  return MEMORY_WRITE_ACTION_IDS_V1.some(value => value === id);
}
const revision = lazyZodSchema(() => z.object({ headerVersion: z.number().int().nonnegative(), bodyVersion: z.number().int().nonnegative() }).strict());
const topic = () => z.string().min(1).regex(/^[^\r\n]+$/).optional();
export const MemoryDocReadInputV1Schema = lazyZodSchema(() => z.object({ ref: PromptDocArtifactRefV1Schema.strict(), topic: topic() }).strict());
const target = lazyZodSchema(() => MemoryDocReadInputV1Schema.extend({ expectedRevision: revision }).strict());
const text = () => z.string().min(1);
const until = () => z.number().int().nonnegative();
const reviewedTarget = lazyZodSchema(() => z.object({ ref: PromptDocArtifactRefV1Schema.strict(), expectedRevision: revision }).strict().nullable().optional());
const accountScope = lazyZodSchema(() => z.object({ scope: z.literal('account') }).strict());
const projectScope = lazyZodSchema(() => z.object({ scope: z.literal('project'), projectRef: QualifiedProjectKeyV1Schema }).strict());
export const MemoryScopeTargetV1Schema = lazyZodSchema(() => z.union([accountScope, projectScope]));
export type MemoryScopeTargetV1 = z.infer<typeof MemoryScopeTargetV1Schema>;
export const MemoryRememberInputV1Schema = lazyZodSchema(() => z.union([
  target.extend({ text: text(), expiresAtMs: until().optional() }).strict(),
  z.object({ sessionRef: z.object({ serverId: z.string().min(1), sessionId: z.string().min(1) }).strict(),
    expectedMetadataRevision: until(), text: text(), expiresAtMs: until().optional(), topic: topic(),
    reviewedTarget,
  }).strict(),
  accountScope.extend({ text: text(), expiresAtMs: until().optional(), topic: topic(), reviewedTarget }).strict(),
  projectScope.extend({ text: text(), expiresAtMs: until().optional(), topic: topic(), reviewedTarget }).strict(),
]));
export const MemoryUpdateInputV1Schema = lazyZodSchema(() => z.union([
  target.extend({ factId: z.string().min(1), text: text(), expiresAtMs: until().nullable().optional() }).strict(),
  target.extend({ topic: z.literal('archive'), factId: z.string().min(1), restore: z.literal(true), restoreTopic: topic() }).strict(),
]));
export type MemoryUpdateInputV1 = z.infer<typeof MemoryUpdateInputV1Schema>;
export const MemoryForgetInputV1Schema = lazyZodSchema(() => target.extend({ factId: z.string().min(1) }).strict());
export const MemoryListInputV1Schema = lazyZodSchema(() => z.object({ serverId: z.string().min(1).optional(), cursor: z.string().min(1).optional(), limit: z.number().int().positive().optional() }).strict());
export const MemoryMutationResultV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(true), artifactId: z.string().min(1), factId: z.string().min(1),
  ref: PromptDocArtifactRefV1Schema.strict().optional(), attachment: z.enum(['attached', 'conflict']).optional(),
}).strict());
export const MemoryDocReadResultV1Schema = lazyZodSchema(() => {
  const version = { ok: z.literal(true), artifactId: z.string().min(1), revision, header: MemoryDocArtifactHeaderV1Schema };
  return z.union([z.object({ ...version, body: MemoryDocIndexV1Schema }).strict(),
    z.object({ ...version, topic: MemoryTopicV1Schema }).strict()]);
});
export const MemoryListResultV1Schema = lazyZodSchema(() => z.object({
  items: z.array(z.object({ artifactId: z.string().min(1), title: z.string().min(1), updatedAtMs: until() }).strict()),
  coverage: z.enum(['complete', 'partial', 'unavailable']), nextCursor: z.string().min(1).optional(),
}).strict());
export const MemoryActionInputSchemasV1 = {
  'memory.remember': MemoryRememberInputV1Schema, 'memory.update': MemoryUpdateInputV1Schema,
  'memory.forget': MemoryForgetInputV1Schema, 'memory.read': MemoryDocReadInputV1Schema, 'memory.list': MemoryListInputV1Schema,
} as const;
export const MemoryActionOutputSchemasV1 = {
  'memory.remember': MemoryMutationResultV1Schema, 'memory.update': MemoryMutationResultV1Schema,
  'memory.forget': MemoryMutationResultV1Schema, 'memory.read': MemoryDocReadResultV1Schema, 'memory.list': MemoryListResultV1Schema,
} as const;
