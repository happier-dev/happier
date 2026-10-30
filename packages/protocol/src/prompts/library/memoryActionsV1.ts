import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PromptDocArtifactRefV1Schema } from './promptArtifactRefsV1.js';
import { MemoryDocArtifactHeaderV1Schema, MemoryDocIndexV1Schema, MemoryTopicReadV1Schema, MemoryDecisionV1Schema } from './memoryDocV1.js';
import { QualifiedProjectKeyV1Schema } from '../../workspaces/workspaceRefV1.js';
import { CoordinationMessageRefV1Schema } from '../../discussions/messageRefs.js';
import { ProjectSourcesFailureV1Schema } from '../../projects/sources/projectSourceV1.js';

export const MEMORY_DOCUMENT_ACTION_IDS_V1 = ['memory.remember', 'memory.decision.save', 'memory.update', 'memory.forget', 'memory.read', 'memory.list'] as const;
export type MemoryDocumentActionIdV1 = typeof MEMORY_DOCUMENT_ACTION_IDS_V1[number];
export const MemoryDecisionSourceErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'memory_decision_source_unavailable', 'memory_decision_source_unsupported', 'memory_decision_disclosure_denied',
]));
export type MemoryDecisionSourceErrorCodeV1 = z.infer<typeof MemoryDecisionSourceErrorCodeV1Schema>;
export const MEMORY_WRITE_ACTION_IDS_V1 = ['memory.remember', 'memory.decision.save', 'memory.update', 'memory.forget'] as const;
export function isMemoryWriteActionV1(id: string): id is typeof MEMORY_WRITE_ACTION_IDS_V1[number] {
  return MEMORY_WRITE_ACTION_IDS_V1.some(value => value === id);
}
const revision = lazyZodSchema(() => z.strictObject({ headerVersion: z.number().check(z.int(), z.nonnegative()), bodyVersion: z.number().check(z.int(), z.nonnegative()) }));
export const MemoryDuplicateChoiceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.enum(['update', 'replace']), factId: z.string().check(z.minLength(1)), expectedRevision: revision }),
  z.strictObject({ kind: z.literal('keep_both'), expectedRevision: revision }),
]));
export type MemoryDuplicateChoiceV1 = z.infer<typeof MemoryDuplicateChoiceV1Schema>;
const duplicateChoice = lazyZodSchema(() => z.optional(MemoryDuplicateChoiceV1Schema));
const topic = () => z.optional(z.string().check(z.minLength(1), z.regex(/^[^\r\n]+$/)));
export const MemoryDocReadInputV1Schema = lazyZodSchema(() => z.strictObject({ ref: PromptDocArtifactRefV1Schema, topic: topic() }));
const target = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MemoryDocReadInputV1Schema, { expectedRevision: revision })));
const text = () => z.string().check(z.minLength(1));
const until = () => z.number().check(z.int(), z.nonnegative());
const reviewedTarget = lazyZodSchema(() => z.optional(z.nullable(z.strictObject({ ref: PromptDocArtifactRefV1Schema, expectedRevision: revision }))));
const accountScope = lazyZodSchema(() => z.strictObject({ scope: z.literal('account') }));
const projectScope = lazyZodSchema(() => z.strictObject({ scope: z.literal('project'), projectRef: QualifiedProjectKeyV1Schema }));
export const MemoryScopeTargetV1Schema = lazyZodSchema(() => z.union([accountScope, projectScope]));
export type MemoryScopeTargetV1 = z.infer<typeof MemoryScopeTargetV1Schema>;
const memoryRememberInputVariants = () => ([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(target, { text: text(), expiresAtMs: z.optional(until()), duplicateChoice })),
  z.strictObject({ sessionRef: z.strictObject({ serverId: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)) }),
    expectedMetadataRevision: until(), text: text(), expiresAtMs: z.optional(until()), topic: topic(),
    reviewedTarget, duplicateChoice,
  }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(accountScope, { text: text(), expiresAtMs: z.optional(until()), topic: topic(), reviewedTarget, duplicateChoice })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(projectScope, { text: text(), expiresAtMs: z.optional(until()), topic: topic(), reviewedTarget, duplicateChoice })),
] as const);
export const MemoryRememberInputV1Schema = lazyZodSchema(() => z.union(memoryRememberInputVariants()));
/** Same admitted targets and duplicate custody as remember; provenance is host output only. */
export const MemoryDecisionSaveInputV1Schema = lazyZodSchema(() => {
  const [doc, session, account, project] = memoryRememberInputVariants();
  const decision = { reason: text(), sourceMessageRef: CoordinationMessageRefV1Schema };
  return z.union([z.extend(doc, decision), z.extend(session, decision), z.extend(account, decision), z.extend(project, decision)]);
});
export type MemoryDecisionSaveInputV1 = z.infer<typeof MemoryDecisionSaveInputV1Schema>;
export const MemoryUpdateInputV1Schema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(target, { factId: z.string().check(z.minLength(1)), text: text(), expiresAtMs: z.optional(z.nullable(until())), duplicateChoice })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(target, { topic: z.literal('archive'), factId: z.string().check(z.minLength(1)), restore: z.literal(true), restoreTopic: topic(), duplicateChoice })),
]));
export type MemoryUpdateInputV1 = z.infer<typeof MemoryUpdateInputV1Schema>;
export const MemoryForgetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(target, { factId: z.string().check(z.minLength(1)) })));
export const MemoryListInputV1Schema = lazyZodSchema(() => z.strictObject({ serverId: z.optional(z.string().check(z.minLength(1))), cursor: z.optional(z.string().check(z.minLength(1))), limit: z.optional(z.number().check(z.int(), z.positive())) }));
/** Safe owner error codes only; transport/database prose never enters a saved-fact receipt. */
export const MemoryAttachmentFailureV1Schema = lazyZodSchema(() => z.strictObject({ errorCode: z.union([
  ProjectSourcesFailureV1Schema.shape.error,
  z.enum(['project_context_unavailable', 'project_context_access_denied', 'action_account_scope_changed', 'cancelled',
    'outcome_unknown', 'home_unreachable', 'memory_target_unavailable']),
]) }));
export type MemoryAttachmentFailureV1 = z.infer<typeof MemoryAttachmentFailureV1Schema>;
export const MemoryMutationResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), artifactId: z.string().check(z.minLength(1)), factId: z.string().check(z.minLength(1)),
  revision: z.optional(revision), ref: z.optional(PromptDocArtifactRefV1Schema), attachment: z.optional(z.enum(['attached', 'conflict'])),
  attachmentFailure: z.optional(MemoryAttachmentFailureV1Schema),
}));
export const MemoryDuplicateChoiceRequiredV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false), errorCode: z.literal('memory_duplicate_choice_required'), ref: PromptDocArtifactRefV1Schema, revision,
  candidates: z.array(z.strictObject({ factId: text(), topic: topic(), text: text(), decision: z.optional(MemoryDecisionV1Schema), match: z.enum(['exact', 'related']) })),
}));
export type MemoryDuplicateChoiceRequiredV1 = z.infer<typeof MemoryDuplicateChoiceRequiredV1Schema>;
export const MemorySemanticMutationResultV1Schema = lazyZodSchema(() => z.union([MemoryMutationResultV1Schema, MemoryDuplicateChoiceRequiredV1Schema]));
export type MemorySemanticMutationResultV1 = z.infer<typeof MemorySemanticMutationResultV1Schema>;
export const MemoryDocReadResultV1Schema = lazyZodSchema(() => {
  const version = { ok: z.literal(true), artifactId: z.string().check(z.minLength(1)), revision, header: MemoryDocArtifactHeaderV1Schema };
  return z.union([z.strictObject({ ...version, body: MemoryDocIndexV1Schema }),
    z.strictObject({ ...version, topic: MemoryTopicReadV1Schema })]);
});
export const MemoryListResultV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({ artifactId: z.string().check(z.minLength(1)), title: z.string().check(z.minLength(1)), updatedAtMs: until() })),
  coverage: z.enum(['complete', 'partial', 'unavailable']), nextCursor: z.optional(z.string().check(z.minLength(1))),
}));
export const MemoryActionInputSchemasV1 = {
  'memory.remember': MemoryRememberInputV1Schema, 'memory.decision.save': MemoryDecisionSaveInputV1Schema, 'memory.update': MemoryUpdateInputV1Schema,
  'memory.forget': MemoryForgetInputV1Schema, 'memory.read': MemoryDocReadInputV1Schema, 'memory.list': MemoryListInputV1Schema,
} as const;
export const MemoryActionOutputSchemasV1 = {
  'memory.remember': MemorySemanticMutationResultV1Schema, 'memory.decision.save': MemorySemanticMutationResultV1Schema, 'memory.update': MemorySemanticMutationResultV1Schema,
  'memory.forget': MemoryMutationResultV1Schema, 'memory.read': MemoryDocReadResultV1Schema, 'memory.list': MemoryListResultV1Schema,
} as const;
