import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { PromptStackEntryV1Schema } from '../../prompts/library/promptStacksV1.js';
import { PromptDocArtifactRefV1Schema, PromptArtifactRefV1Schema } from '../../prompts/library/promptArtifactRefsV1.js';
import { readSessionBotV1 } from '../identity/sessionBotV1.js';
import { assertPromptStackArtifactHeaderV1, PromptStackPreparationError, type PromptStackSystemAppendInputV1 } from '../../prompts/library/resolvePromptStackSystemAppendBlocksV1.js';

export const SessionPromptStackV1Schema = lazyZodSchema(() => z.array(PromptStackEntryV1Schema)
  .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, { message: 'Duplicate context entry id' }));
export const SessionPromptStackV1StoredSchema = createStoredReadSchema(SessionPromptStackV1Schema);
export type SessionPromptStackV1 = Readonly<z.infer<typeof SessionPromptStackV1Schema>>;
export const SessionDisabledInheritedEntryIdsV1Schema = lazyZodSchema(() => z.array(z.string().min(1))
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate inherited entry id' }));
const NewEntrySchema = lazyZodSchema(() => PromptStackEntryV1Schema.extend({
  ref: PromptArtifactRefV1Schema.strict(),
  placement: z.literal('system_append').default('system_append'),
}).strict());
export const SessionContextIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set'), entry: NewEntrySchema }).strict(),
  z.object({ kind: z.literal('attach'), entry: NewEntrySchema }).strict(),
  z.object({ kind: z.literal('detach'), entryId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('reorder'), entryId: z.string().min(1), siblingId: z.string().min(1), position: z.enum(['before', 'after']) }).strict(),
  z.object({ kind: z.literal('set_budget'), entryId: z.string().min(1), maxChars: z.number().int().positive().nullable() }).strict(),
  z.object({ kind: z.literal('set_enabled'), entryId: z.string().min(1), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('inherited_enable'), entryId: z.string().min(1), enabled: z.boolean() }).strict(),
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
  let promptStack = entries;
  if (intent.kind === 'attach' || intent.kind === 'set') {
    if (intent.kind === 'attach' && index !== -1) refuse('entry_conflict');
    promptStack = index === -1 ? [...entries, intent.entry] : entries.map((entry, i) => i === index ? intent.entry : entry);
  } else if (intent.kind === 'detach') {
    promptStack = entries.filter((entry) => entry.id !== intent.entryId);
  } else {
    if (index === -1) refuse('entry_not_found');
    if (intent.kind === 'set_enabled') {
      promptStack = entries.map((entry, i) => i === index ? { ...entry, enabled: intent.enabled } : entry);
    } else if (intent.kind === 'set_budget') {
      promptStack = entries.map((entry, i) => {
        if (i !== index) return entry;
        const { maxChars: _previous, ...rest } = entry;
        return { ...rest, ...(intent.maxChars === null ? {} : { maxChars: intent.maxChars }) };
      });
    } else {
      if (intent.entryId === intent.siblingId) return metadata;
      const remaining = entries.filter((entry) => entry.id !== intent.entryId);
      const sibling = remaining.findIndex((entry) => entry.id === intent.siblingId);
      if (sibling === -1) refuse('entry_not_found');
      promptStack = [...remaining];
      promptStack.splice(sibling + (intent.position === 'after' ? 1 : 0), 0, entries[index]!);
    }
  }
  return { ...metadata, work: { ...work, promptStack: SessionPromptStackV1Schema.parse(promptStack) } };
}
