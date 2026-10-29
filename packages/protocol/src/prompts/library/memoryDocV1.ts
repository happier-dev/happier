import * as z from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { CoordinationMessageRefV1Schema } from '../../discussions/references.js';
import type { PromptDocArtifactRefV1 } from './promptArtifactRefsV1.js';

const identity = () => z.string().check(z.minLength(1));
const date = () => z.number().check(z.int(), z.gte(0));
export const MemoryDecisionV1Schema = z.strictObject({
  reason: identity(), sourceMessageRef: CoordinationMessageRefV1Schema,
  approvedBy: z.nullable(z.strictObject({ accountId: identity(), atMs: date() })),
});
export type MemoryDecisionV1 = z.infer<typeof MemoryDecisionV1Schema>;
export const MemoryFactV1Schema = z.strictObject({
  id: identity(), text: identity(), createdAtMs: date(), expiresAtMs: z.optional(date()),
  sourceSessionRef: z.nullable(z.strictObject({ serverId: identity(), sessionId: identity() })),
  supersedes: z.optional(identity()),
  decision: z.optional(MemoryDecisionV1Schema),
});
export type MemoryFactV1 = z.infer<typeof MemoryFactV1Schema>;
export const MEMORY_ARCHIVE_TOPIC_TITLE_V1 = 'archive';
export const MEMORY_ARCHIVE_TOPIC_SUMMARY_V1 = 'Expired, replaced and forgotten facts.';
const line = () => identity().check(z.regex(/^[^\r\n]+$/));
export const MemoryTopicSummaryV1Schema = z.strictObject({ title: line(), summary: line() });
export const MemoryTopicV1Schema = z.strictObject({ title: line(), summary: line(), facts: z.array(MemoryFactV1Schema) });
export type MemoryTopicV1 = z.infer<typeof MemoryTopicV1Schema>;
/** Read-only projection; stored facts and mutation inputs never carry archive membership. */
export const MemoryFactReadV1Schema = z.object({
  ...MemoryFactV1Schema.shape,
  archivedByMutation: z.optional(z.boolean()),
});
export type MemoryFactReadV1 = z.infer<typeof MemoryFactReadV1Schema>;
export const MemoryTopicReadV1Schema = z.object({ ...MemoryTopicV1Schema.shape, facts: z.array(MemoryFactReadV1Schema) });
export type MemoryTopicReadV1 = z.infer<typeof MemoryTopicReadV1Schema>;
export const MemoryDocBodyV1Schema = z.strictObject({
  v: z.literal(1), index: z.array(MemoryFactV1Schema), topics: z.array(MemoryTopicV1Schema),
}).check(z.refine(body => {
  const facts = [...body.index, ...body.topics.flatMap(topic => topic.facts)];
  const archived = new Set(body.topics.find(topic => topic.title === MEMORY_ARCHIVE_TOPIC_TITLE_V1)?.facts.map(fact => fact.id));
  return new Set(body.topics.map(topic => topic.title)).size === body.topics.length
    && new Set(facts.map(fact => fact.id)).size === facts.length
    && facts.every(fact => fact.supersedes === undefined || (fact.supersedes !== fact.id && archived.has(fact.supersedes)));
}, { message: 'Topic titles and fact ids must be unique and supersedes must name an archived fact' }));
export type MemoryDocBodyV1 = z.infer<typeof MemoryDocBodyV1Schema>;
const retainedBody = z.union([
  z.strictObject({ v: z.literal(1), index: z.array(MemoryFactV1Schema), topics: z.optional(z.array(MemoryTopicV1Schema)) }),
  z.strictObject({ v: z.literal(1), facts: z.array(MemoryFactV1Schema), archive: z.array(MemoryFactV1Schema),
    // Known current fields cannot be dropped by the legacy arm after current admission fails.
    index: z.optional(z.never()), topics: z.optional(z.never()),
  }).check(z.refine(body => !Object.hasOwn(body, 'index') && !Object.hasOwn(body, 'topics'))),
]);
defineStoredReadProjection(MemoryDocBodyV1Schema, () => z.pipe(
  z.pipe(createStoredReadSchema(retainedBody),
    z.transform((body: z.infer<typeof retainedBody>) => 'facts' in body
      ? { v: body.v, index: body.facts, topics: body.archive.length ? [{ title: MEMORY_ARCHIVE_TOPIC_TITLE_V1,
        summary: MEMORY_ARCHIVE_TOPIC_SUMMARY_V1, facts: body.archive }] : [] }
      : { v: body.v, index: body.index, topics: body.topics ?? [] })),
  MemoryDocBodyV1Schema,
));
export const MemoryDocBodyV1StoredSchema = createStoredReadSchema(MemoryDocBodyV1Schema);
export const MemoryDocIndexV1Schema = z.strictObject({
  v: z.literal(1), index: z.array(MemoryFactV1Schema), topics: z.array(MemoryTopicSummaryV1Schema),
});
export type MemoryDocIndexV1 = z.infer<typeof MemoryDocIndexV1Schema>;
export const MemoryDocArtifactHeaderV1Schema = z.strictObject({
  v: z.literal(1), kind: z.literal('memory_doc.v1'), title: identity(),
});
export const MemoryDocArtifactHeaderV1StoredSchema = createStoredReadSchema(MemoryDocArtifactHeaderV1Schema);

export type MemoryTargetSelectionV1 = Readonly<{
  resolving: boolean; ref: PromptDocArtifactRefV1 | null; scope: 'session' | 'project' | 'account';
}>;
type MemoryTargetLayerV1 = Readonly<{ status: 'ready' | 'none' | 'pending' | 'unavailable'; ref: PromptDocArtifactRefV1 | null }>;

/** One target precedence for write admission and UI projection. Layer readers own readiness and access. */
export function selectMemoryTargetV1(input: Readonly<{
  isBot: boolean; botRef: PromptDocArtifactRefV1 | null; project?: MemoryTargetLayerV1; account?: MemoryTargetLayerV1;
}>): MemoryTargetSelectionV1 {
  if (input.isBot) return { resolving: false, ref: input.botRef, scope: 'session' };
  if (!input.project || (input.project.status !== 'ready' && input.project.status !== 'none')) {
    return { resolving: true, ref: null, scope: 'project' };
  }
  if (input.project.ref) return { resolving: false, ref: input.project.ref, scope: 'project' };
  if (input.account?.status !== 'ready') return { resolving: true, ref: null, scope: 'account' };
  return { resolving: false, ref: input.account.ref, scope: 'account' };
}

function isExpired(fact: MemoryFactV1, nowMs: number): boolean {
  return fact.expiresAtMs !== undefined && fact.expiresAtMs <= nowMs;
}

/** Expiry alone may be renewed; mutation-archived history must use the explicit restore path. */
export function isMemoryFactRenewableV1(fact: MemoryFactReadV1, nowMs: number): boolean {
  return fact.archivedByMutation !== true && isExpired(fact, nowMs);
}

/** One index projection for on-demand reads and always-loaded prompt rendering. */
export function projectMemoryDocIndexV1(body: MemoryDocBodyV1, nowMs: number): MemoryDocIndexV1 {
  // Named topics first, the archive last: it is one more topic, searchable and never loaded.
  const topics = [
    ...body.topics.filter(topic => topic.title !== MEMORY_ARCHIVE_TOPIC_TITLE_V1),
    ...body.topics.filter(topic => topic.title === MEMORY_ARCHIVE_TOPIC_TITLE_V1),
  ].map(({ title, summary }) => ({ title, summary }));
  if (!topics.some(topic => topic.title === MEMORY_ARCHIVE_TOPIC_TITLE_V1)
    && (body.index.some(fact => isExpired(fact, nowMs)) || body.topics.some(topic => topic.facts.some(fact => isExpired(fact, nowMs))))) {
    topics.push({ title: MEMORY_ARCHIVE_TOPIC_TITLE_V1, summary: MEMORY_ARCHIVE_TOPIC_SUMMARY_V1 });
  }
  return { v: 1, index: body.index.filter(fact => !isExpired(fact, nowMs)), topics };
}

/** Expiry is projected into archive without rewriting or duplicating stored facts. */
export function readMemoryDocTopicV1(body: MemoryDocBodyV1, title: string, nowMs: number): MemoryTopicReadV1 | null {
  const topic = body.topics.find(candidate => candidate.title === title);
  if (title !== MEMORY_ARCHIVE_TOPIC_TITLE_V1) return topic ?? null;
  return { title, summary: topic?.summary ?? MEMORY_ARCHIVE_TOPIC_SUMMARY_V1, facts: [
    ...(topic?.facts ?? []).map(fact => ({ ...fact, archivedByMutation: true })),
    ...body.index.filter(fact => isExpired(fact, nowMs)).map(fact => ({ ...fact, archivedByMutation: false })),
    ...body.topics.filter(candidate => candidate.title !== title).flatMap(candidate => candidate.facts
      .filter(fact => isExpired(fact, nowMs)).map(fact => ({ ...fact, archivedByMutation: false }))),
  ] };
}

const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ');
function renderDate(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? `${value} ms since Unix epoch` : date.toISOString().replace(/T.*$/, '');
}

/** Complete index entries only; topic detail never enters the always-loaded block. */
export function renderMemoryDocV1(params: Readonly<{ body: MemoryDocBodyV1; nowMs: number; maxChars?: number }>): Readonly<{
  markdown: string; loadedFactIds: readonly string[]; notLoadedFactIds: readonly string[];
  loadedTopicTitles: readonly string[]; notLoadedTopicTitles: readonly string[];
}> {
  const blocks: string[] = [];
  const loadedFactIds: string[] = [];
  const notLoadedFactIds: string[] = [];
  const loadedTopicTitles: string[] = [];
  const notLoadedTopicTitles: string[] = [];
  let length = 0;
  const index = projectMemoryDocIndexV1(params.body, params.nowMs);
  for (const fact of index.index) {
    const source = fact.sourceSessionRef;
    const metadata = [`id: ${oneLine(fact.id)}`];
    if (source) metadata.push(`source: happier://session/${encodeURIComponent(source.serverId)}/${encodeURIComponent(source.sessionId)}`);
    metadata.push(`added: ${renderDate(fact.createdAtMs)}`);
    if (fact.expiresAtMs !== undefined) metadata.push(`expires: ${renderDate(fact.expiresAtMs)}`);
    if (fact.supersedes !== undefined) metadata.push(`supersedes: ${oneLine(fact.supersedes)}`);
    const block = `- ${oneLine(fact.text)} [${metadata.join('; ')}]`;
    const addition = block.length + (blocks.length ? 1 : 0);
    if (params.maxChars !== undefined && length + addition > params.maxChars) { notLoadedFactIds.push(fact.id); continue; }
    blocks.push(block); length += addition; loadedFactIds.push(fact.id);
  }
  for (const topic of index.topics) {
    const block = `- Topic: ${topic.title} — ${topic.summary}`;
    const addition = block.length + (blocks.length ? 1 : 0);
    if (params.maxChars !== undefined && length + addition > params.maxChars) { notLoadedTopicTitles.push(topic.title); continue; }
    blocks.push(block); length += addition; loadedTopicTitles.push(topic.title);
  }
  return { markdown: blocks.join('\n'), loadedFactIds, notLoadedFactIds, loadedTopicTitles, notLoadedTopicTitles };
}
