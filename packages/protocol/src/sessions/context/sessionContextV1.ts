import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { applyPromptStackIntentV1, PromptStackEntryV1Schema, PromptStackEntryAuthoringV1Schema, PromptStackSetEnabledIntentV1Schema } from '../../prompts/library/promptStacksV1.js';
import { PromptDocArtifactRefV1Schema, PromptArtifactRefV1Schema } from '../../prompts/library/promptArtifactRefsV1.js';
import { readSessionBotV1 } from '../identity/sessionBotV1.js';
import { assertPromptStackArtifactHeaderV1, PromptStackPreparationError, type PromptStackSystemAppendInputV1 } from '../../prompts/library/resolvePromptStackSystemAppendBlocksV1.js';

/** Plan is a Session annotation, not a second Account or Project Context authority. */
export const SessionPromptStackEntryV1Schema = lazyZodSchema(() => z.extend(PromptStackEntryV1Schema, {
  plan: z.optional(z.literal(true)),
}).check(z.refine(entry => entry.plan !== true || entry.ref.kind === 'doc', { message: 'Plan must reference a Doc' })));
export type SessionPromptStackEntryV1 = z.infer<typeof SessionPromptStackEntryV1Schema>;
export const SessionPromptStackV1Schema = lazyZodSchema(() => z.array(SessionPromptStackEntryV1Schema).check(
  z.refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, { message: 'Duplicate context entry id' }),
  z.refine((entries) => entries.filter(entry => entry.plan === true).length <= 1, { message: 'Multiple Plan entries' }),
));
export const SessionPromptStackV1StoredSchema = createStoredReadSchema(SessionPromptStackV1Schema);
export type SessionPromptStackV1 = Readonly<z.infer<typeof SessionPromptStackV1Schema>>;
export const SessionDisabledInheritedEntryIdsV1Schema = lazyZodSchema(() => z.array(z.string().check(z.minLength(1))).check(z.refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate inherited entry id' })));
const NewEntrySchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PromptStackEntryAuthoringV1Schema, {
  ref: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(PromptArtifactRefV1Schema),
})));
export const SessionContextIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('set'), entry: NewEntrySchema }),
  z.strictObject({ kind: z.literal('attach'), entry: NewEntrySchema }),
  z.strictObject({ kind: z.literal('detach'), entryId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('reorder'), entryId: z.string().check(z.minLength(1)), siblingId: z.string().check(z.minLength(1)), position: z.enum(['before', 'after']) }),
  z.strictObject({ kind: z.literal('set_budget'), entryId: z.string().check(z.minLength(1)), maxChars: z.nullable(z.number().check(z.int(), z.positive())) }),
  z.strictObject({ kind: z.literal('set_plan'), entryId: z.nullable(z.string().check(z.minLength(1))) }),
  PromptStackSetEnabledIntentV1Schema,
  z.strictObject({ kind: z.literal('inherited_enable'), entryId: z.string().check(z.minLength(1)), enabled: z.boolean() }),
]));
export type SessionContextIntentV1 = z.infer<typeof SessionContextIntentV1Schema>;

/** The semantic writer admits new references against the same header authority as preparation. */
export async function admitSessionContextIntentV1(input: unknown,
  readArtifactHeader: NonNullable<PromptStackSystemAppendInputV1['readArtifactHeader']>,
): Promise<SessionContextIntentV1> {
  const intent = SessionContextIntentV1Schema.parse(input);
  if (intent.kind === 'attach' || intent.kind === 'set') {
    const artifact = await readArtifactHeader(intent.entry.ref);
    if (!artifact) throw new PromptStackPreparationError('not_found', intent.entry.ref);
    assertPromptStackArtifactHeaderV1(intent.entry.ref, artifact.header, { layer: 'session', entryId: intent.entry.id });
  }
  return intent;
}

/** Retained development data only: move the obsolete role pointer into its
 * owning Session layer. This preserves a Markdown reference; it does not
 * create or reinterpret the document as a memory artifact. */
export function migrateRetainedSessionWorkContextV1(value: unknown): Record<string, unknown> {
  const work = value === undefined ? {} : z.record(z.string(), z.unknown()).parse(value);
  const roles: unknown = 'sessionRolesV1' in work ? work.sessionRolesV1 : undefined;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles) || !('memoryDocRef' in roles)) return { ...work };
  const ref = createStoredReadSchema(PromptDocArtifactRefV1Schema).parse(roles.memoryDocRef);
  const entries = createStoredReadSchema(SessionPromptStackV1Schema).parse('promptStack' in work ? work.promptStack : []);
  const id = 'session.legacy-role-memory';
  const existing = entries.find((entry) => entry.id === id);
  if (existing && (existing.ref.kind !== ref.kind || existing.ref.artifactId !== ref.artifactId || existing.ref.serverId !== ref.serverId)) {
    throw Object.assign(new Error('Retained role context entry conflicts with Session context'), { code: 'entry_conflict' });
  }
  const { memoryDocRef: _legacy, ...sessionRolesV1 } = roles;
  return { ...work, sessionRolesV1, promptStack: existing ? entries : [...entries,
    PromptStackEntryV1Schema.parse({ id, ref, enabled: true, placement: 'system_append' })] };
}

export function migrateRetainedSessionMetadataContextV1(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('work' in value)) return value;
  return { ...value, work: migrateRetainedSessionWorkContextV1(value.work) };
}

/** The Account default is creation-only. Retained Sessions use their own choice or kind baseline. */
export function readSessionMemoryEnabledV1(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const work: unknown = Reflect.get(metadata, 'work');
  if (work && typeof work === 'object' && 'memoryEnabled' in work) return work.memoryEnabled === true;
  return readSessionBotV1(Reflect.get(metadata, 'bot') ?? (work && typeof work === 'object' ? Reflect.get(work, 'bot') : undefined)) !== null;
}

export function writeSessionContextIntentV1ToMetadata<T extends Record<string, unknown>>(metadata: T, input: SessionContextIntentV1): T {
  const intent = SessionContextIntentV1Schema.parse(input);
  const rawWork = metadata.work;
  const work = migrateRetainedSessionWorkContextV1(rawWork);
  const rawStack = 'promptStack' in work ? work.promptStack : [];
  const entries = createStoredReadSchema(SessionPromptStackV1Schema).parse(rawStack);
  if (intent.kind === 'inherited_enable') {
    const ids = SessionDisabledInheritedEntryIdsV1Schema.parse('disabledInheritedEntryIds' in work ? work.disabledInheritedEntryIds : []);
    return { ...metadata, work: { ...work, disabledInheritedEntryIds: intent.enabled
      ? ids.filter((id) => id !== intent.entryId) : [...new Set([...ids, intent.entryId])] } };
  }
  const index = entries.findIndex((entry) => entry.id === ('entry' in intent ? intent.entry.id : intent.entryId));
  const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  const migratedStack = 'promptStack' in work && rawWork !== null && typeof rawWork === 'object'
    && (!('promptStack' in rawWork) || rawWork.promptStack !== work.promptStack);
  let promptStack = entries;
  if (intent.kind === 'set_plan') {
    // Validate before clearing the previous choice. The intent is applied to the
    // current reviewed stack, never to a caller-supplied replacement snapshot.
    if (intent.entryId !== null) {
      if (index === -1) refuse('entry_not_found');
      if (entries[index]!.ref.kind !== 'doc') refuse('invalid_parameters');
    }
    if (!migratedStack && entries.every(entry => (entry.plan === true) === (entry.id === intent.entryId))) return metadata;
    promptStack = entries.map(entry => {
      const { plan: _previous, ...withoutPlan } = entry;
      return entry.id === intent.entryId ? { ...withoutPlan, plan: true as const } : withoutPlan;
    });
  } else if (intent.kind === 'attach' || intent.kind === 'set') {
    if (intent.kind === 'attach' && index !== -1) refuse('entry_conflict');
    promptStack = index === -1 ? [...entries, intent.entry] : entries.map((entry, i) => i === index ? intent.entry : entry);
  } else {
    // Retained Session self-moves are a no-op; ordinary list edits belong to the shared owner.
    if (intent.kind === 'reorder' && intent.entryId === intent.siblingId) {
      if (index === -1) refuse('entry_not_found');
      return metadata;
    }
    const mutation = applyPromptStackIntentV1({ promptStack: entries }, intent);
    if (!mutation.ok) return refuse(mutation.errorCode);
    // A no-op may still carry the canonical retained-role migration; do not drop that transition.
    if (!mutation.changed && !migratedStack) return metadata;
    promptStack = [...mutation.row.promptStack];
  }
  return { ...metadata, work: { ...work, promptStack: SessionPromptStackV1Schema.parse(promptStack) } };
}
