import { decodeBase64 } from '../../crypto/base64.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema, validatePromptBundleBodyV1AgainstSchemaId } from './promptBundleShapeV1.js';
import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema } from './promptDocV2.js';
import { MemoryDocArtifactHeaderV1StoredSchema, MemoryDocBodyV1StoredSchema, renderMemoryDocV1 } from './memoryDocV1.js';
import type { PromptStackEntryV1, PromptStacksV1 } from './promptStacksV1.js';
import type { PromptArtifactRefV1 } from './promptArtifactRefsV1.js';
import type { PromptLibraryStoredArtifact } from './promptLibraryActionOperations.js';
import { isPromptStackSystemAppendPlacementV1 } from './promptPlacementV1.js';

export type PromptStackPreparationReason = 'not_found' | 'wrong_kind' | 'malformed' | 'locked' | 'unavailable';

/** The admitted preparation target, not authority to read a referenced document. */
export type PromptStackScopeV1 = Readonly<{
  serverId: string;
  accountId: string;
  sessionId?: string;
  projectKey?: string;
  profileId?: string;
}>;
export type PromptStackLayerV1 = 'account' | 'profile' | 'project' | 'session';
export type PromptStackMemoryPreparationV1 = Omit<ReturnType<typeof renderMemoryDocV1>, 'markdown'>;
type PromptStackAdmittedEntryIdentityV1 = Readonly<{
  entryId: string;
  layer: PromptStackLayerV1;
  scope: PromptStackScopeV1 | null;
  ref: PromptArtifactRefV1;
}>;
export type PromptStackAdmittedEntryV1 = PromptStackAdmittedEntryIdentityV1 & (
  | Readonly<{ outcome: 'ready' | 'valid-empty'; revision: PromptLibraryStoredArtifact['revision']; memory?: PromptStackMemoryPreparationV1 }>
  | Readonly<{ outcome: 'unavailable'; reason: PromptStackPreparationReason; revision: PromptLibraryStoredArtifact['revision'] | null }>
);
export type PromptStackSystemAppendResultV1 = Readonly<{
  blocks: string[];
  admittedEntries: readonly PromptStackAdmittedEntryV1[];
}>;

/** This is a reader fact; the existing host owns accepted-input retention and retry. */
export class PromptStackPreparationError extends Error {
  readonly code: 'attachment_unavailable' | 'preparation_pending';
  readonly status: 'attachment_unavailable' | 'preparation_pending';
  constructor(readonly reason: PromptStackPreparationReason, readonly ref?: PromptArtifactRefV1,
    readonly admittedEntries: readonly PromptStackAdmittedEntryV1[] = []) {
    const status = reason === 'unavailable' ? 'preparation_pending' : 'attachment_unavailable';
    super(`${status}: ${reason}`);
    this.name = 'PromptStackPreparationError';
    this.status = status;
    this.code = status;
  }
}

export type PromptStackSystemAppendInputV1 = Readonly<{
  surface: 'coding' | 'voice';
  scope?: PromptStackScopeV1 | null;
  /** Read only after Protocol selects at least one effective entry. */
  readScope?: () => Promise<PromptStackScopeV1 | null>;
  promptStacksV1?: PromptStacksV1 | null;
  profileId?: string | null;
  accountEntries?: readonly PromptStackEntryV1[];
  profileEntries?: readonly PromptStackEntryV1[];
  projectEntries?: readonly PromptStackEntryV1[];
  sessionEntries?: readonly PromptStackEntryV1[];
  memoryEnabled?: boolean;
  disabledInheritedEntryIds?: readonly string[];
  readArtifact: (ref: PromptArtifactRefV1) => Promise<PromptLibraryStoredArtifact | null>;
  readArtifactHeader?: (ref: PromptArtifactRefV1) => Promise<Readonly<{ header: Readonly<Record<string, unknown>> | null }> | null>;
  signal?: AbortSignal;
  nowMs?: () => number;
}>;

/** Admission and preparation share the same document-kind authority. */
export function assertPromptStackArtifactHeaderV1(ref: PromptArtifactRefV1, header: Readonly<Record<string, unknown>> | null,
  entry?: Readonly<{ layer: PromptStackLayerV1; entryId: string; memoryEnabled?: boolean }>,
): void {
  const kind = header?.kind;
  if (entry?.layer === 'session' && entry.entryId === 'session.instructions' && kind !== 'prompt_doc.v2') {
    throw new PromptStackPreparationError('wrong_kind', ref);
  }
  // Memory-off preparation intentionally checks only the kind before skipping
  // ordinary memory bodies; reserved Instructions must never take that path.
  if (entry?.memoryEnabled === false && kind === 'memory_doc.v1') return;
  if (ref.kind === 'doc') {
    if (kind !== 'prompt_doc.v2' && kind !== 'memory_doc.v1') throw new PromptStackPreparationError('wrong_kind', ref);
    const schema = kind === 'memory_doc.v1' ? MemoryDocArtifactHeaderV1StoredSchema : createStoredReadSchema(PromptDocArtifactHeaderV1Schema);
    if (!schema.safeParse(header).success) throw new PromptStackPreparationError('malformed', ref);
  } else {
    if (kind !== 'prompt_bundle.v2') throw new PromptStackPreparationError('wrong_kind', ref);
    if (!createStoredReadSchema(PromptBundleArtifactHeaderV1Schema).safeParse(header).success) throw new PromptStackPreparationError('malformed', ref);
  }
}

function parseJson(body: string | null): unknown {
  if (body === null) return null;
  try { return JSON.parse(body); } catch { return null; }
}

/** One eligibility owner for preparation and remembered requiredness facts. */
export function selectPromptStackSystemAppendEntriesV1(args: Pick<PromptStackSystemAppendInputV1,
  'surface' | 'promptStacksV1' | 'profileId' | 'accountEntries' | 'profileEntries' | 'projectEntries' | 'sessionEntries' | 'disabledInheritedEntryIds'>):
  readonly Readonly<{ entry: PromptStackEntryV1; layer: PromptStackLayerV1 }>[] {
  const stacks = args.promptStacksV1;
  const account = args.accountEntries ?? (args.surface === 'voice' ? stacks?.surfaces.voice : stacks?.surfaces.coding) ?? [];
  const profile = args.profileEntries ?? (args.profileId ? stacks?.surfaces.profilesById?.[args.profileId.trim()] : undefined) ?? [];
  const disabled = new Set(args.disabledInheritedEntryIds ?? []);
  const layers = [
    { layer: 'account', entries: account },
    { layer: 'profile', entries: profile },
    { layer: 'project', entries: args.projectEntries ?? [] },
    { layer: 'session', entries: args.sessionEntries ?? [] },
  ] as const;
  return layers.flatMap(({ layer, entries }) => entries.filter(entry => entry.enabled
    && (layer === 'session' || !disabled.has(entry.id))
    && isPromptStackSystemAppendPlacementV1(entry.placement))
    .map(entry => ({ entry, layer })));
}

function omittedByMemoryPolicy(ref: PromptArtifactRefV1, header: Readonly<Record<string, unknown>> | null,
  entry: Readonly<{ layer: PromptStackLayerV1; entryId: string; memoryEnabled?: boolean }>): boolean {
  if (entry.memoryEnabled !== false || header?.kind !== 'memory_doc.v1') return false;
  assertPromptStackArtifactHeaderV1(ref, header, entry);
  return true;
}

/** Account → Profile → Project → Session is shared by coding and bound Voice. */
export async function resolvePromptStackSystemAppendBlocksV1(args: PromptStackSystemAppendInputV1): Promise<PromptStackSystemAppendResultV1> {
  const entries = selectPromptStackSystemAppendEntriesV1(args);
  const out: string[] = [];
  const admittedEntries: PromptStackAdmittedEntryV1[] = [];
  if (entries.length === 0) return { blocks: out, admittedEntries };
  args.signal?.throwIfAborted();
  let resolvedScope = args.scope;
  if (resolvedScope === undefined && args.readScope) {
    try { resolvedScope = await args.readScope(); }
    catch (error) {
      args.signal?.throwIfAborted();
      if (!(error instanceof PromptStackPreparationError) || error.reason === 'unavailable') {
        throw new PromptStackPreparationError('unavailable', undefined, entries.map(({ entry, layer }) => ({
          entryId: entry.id, layer, scope: null, ref: { ...entry.ref },
          outcome: 'unavailable', reason: 'unavailable', revision: null,
        })));
      }
      if (error instanceof PromptStackPreparationError) throw error;
      throw new PromptStackPreparationError('unavailable');
    }
  }
  args.signal?.throwIfAborted();
  const scope = resolvedScope ? { ...resolvedScope } : null;
  const reads = new Map<string, Promise<PromptLibraryStoredArtifact | null>>();
  const headers = new Map<string, Promise<Readonly<{ header: Readonly<Record<string, unknown>> | null }> | null>>();
  const read = async <T>(ref: PromptArtifactRefV1, load: () => Promise<T>): Promise<T> => {
    args.signal?.throwIfAborted();
    try {
      const result = await load();
      args.signal?.throwIfAborted();
      return result;
    } catch (error) {
      args.signal?.throwIfAborted();
      if (error instanceof PromptStackPreparationError) throw error;
      const code = error instanceof Error && 'code' in error ? error.code : null;
      // Unobserved Account mode is unavailable admission, not a confirmed lock.
      // No unopened content enters the plan; requiredness governs omission below.
      const locked = code === 'artifact_encryption_material_unavailable' || code === 'artifact_account_mode_mismatch'
        || code === 'artifact_content_unavailable' || code === 'content_unavailable';
      throw new PromptStackPreparationError(locked ? 'locked' : 'unavailable', ref);
    }
  };
  // Each selected address has independent read authority. Overlap its IO,
  // preserving Memory-off header admission before any body read and sharing
  // duplicate addresses only within this preparation. Settle every read before
  // returning or refusing; interpretation and failure inventory stay authored.
  const preparedReads = await Promise.allSettled(entries.map(async ({ entry, layer }) => {
    const ref = { ...entry.ref, ...(entry.ref.serverId === undefined && scope ? { serverId: scope.serverId } : {}) };
    const key = JSON.stringify([ref.serverId ?? null, ref.artifactId]);
    if (args.memoryEnabled === false) {
      if (!args.readArtifactHeader) throw new PromptStackPreparationError('unavailable', ref);
      let pending = headers.get(key);
      if (!pending) { pending = read(ref, () => args.readArtifactHeader!(ref)); headers.set(key, pending); }
      const header = await pending;
      if (!header) return { omitted: false as const, artifact: null };
      if (omittedByMemoryPolicy(ref, header.header, { layer, entryId: entry.id, memoryEnabled: false })) {
        return { omitted: true as const };
      }
    }
    let pending = reads.get(key);
    if (!pending) { pending = read(ref, () => args.readArtifact(ref)); reads.set(key, pending); }
    return { omitted: false as const, artifact: await pending };
  }));
  for (const [index, { entry, layer }] of entries.entries()) {
    const ref = { ...entry.ref, ...(entry.ref.serverId === undefined && scope ? { serverId: scope.serverId } : {}) };
    const preparing = { entryId: entry.id, layer, scope, ref };
    let observedRevision: PromptLibraryStoredArtifact['revision'] | null = null;
    try {
      const prepared = preparedReads[index]!;
      if (prepared.status === 'rejected') throw prepared.reason;
      if (prepared.value.omitted) continue;
      const artifact = prepared.value.artifact;
      if (!artifact) {
        throw new PromptStackPreparationError('not_found', ref);
      }
      observedRevision = { ...artifact.revision };
      assertPromptStackArtifactHeaderV1(ref, artifact.header, { layer, entryId: entry.id });
      // Legacy skill attachments are inert. The skills owner admits their content
      // and delivers native files or an index; stack preparation never pastes it.
      if (ref.kind === 'bundle' && artifact.header?.bundleSchemaId === 'skills.skill_md_v1') continue;
      const bodyJson = parseJson(artifact.body);
      const fail = (reason: PromptStackPreparationReason): never => { throw new PromptStackPreparationError(reason, ref); };
      let text: string;
      let memoryDocument: string | null = null;
      let memory: PromptStackMemoryPreparationV1 | undefined;
      if (ref.kind === 'doc' && artifact.header?.kind === 'memory_doc.v1') {
        const header = MemoryDocArtifactHeaderV1StoredSchema.safeParse(artifact.header);
        if (!header.success) throw new PromptStackPreparationError('malformed', ref);
        memoryDocument = header.data.title;
        const parsed = MemoryDocBodyV1StoredSchema.safeParse(bodyJson);
        if (!parsed.success) throw new PromptStackPreparationError('malformed', ref);
        const rendered = renderMemoryDocV1({ body: parsed.data, nowMs: (args.nowMs ?? Date.now)(), maxChars: entry.maxChars });
        text = rendered.markdown;
        const { markdown: _markdown, ...selection } = rendered;
        memory = selection;
      } else if (ref.kind === 'doc') {
        if (artifact.header?.kind !== 'prompt_doc.v2') fail('wrong_kind');
        if (!createStoredReadSchema(PromptDocArtifactHeaderV1Schema).safeParse(artifact.header).success) fail('malformed');
        const parsed = createStoredReadSchema(PromptDocBodyV1Schema).safeParse(bodyJson);
        if (!parsed.success) throw new PromptStackPreparationError('malformed', ref);
        text = parsed.data.markdown;
      } else {
        const header = createStoredReadSchema(PromptBundleArtifactHeaderV1Schema).parse(artifact.header);
        const parsed = createStoredReadSchema(PromptBundleBodyV1Schema).safeParse(bodyJson);
        if (!parsed.success) throw new PromptStackPreparationError('malformed', ref);
        if (!validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: header.bundleSchemaId, body: parsed.data }).ok) fail('malformed');
        const skill = parsed.data.entries.find(candidate => candidate.path === 'SKILL.md' && candidate.contentKind === 'utf8');
        if (!skill) throw new PromptStackPreparationError('malformed', ref);
        try { text = new TextDecoder().decode(decodeBase64(skill.contentBase64, 'base64')); }
        catch { throw new PromptStackPreparationError('malformed', ref); }
      }
      const trimmed = text.trim();
      admittedEntries.push({ ...preparing, outcome: trimmed ? 'ready' : 'valid-empty', revision: observedRevision,
        ...(memory ? { memory } : {}) });
      if (!trimmed) continue;
      out.push(memoryDocument !== null
        ? `Memory: ${JSON.stringify({ document: memoryDocument, layer, ref })}\n${trimmed}`
        : entry.maxChars !== undefined ? trimmed.slice(0, entry.maxChars) : trimmed);
    } catch (error) {
      args.signal?.throwIfAborted();
      if (!(error instanceof PromptStackPreparationError)) throw error;
      admittedEntries.push({ ...preparing, outcome: 'unavailable', reason: error.reason, revision: observedRevision });
      // Only definitive absence permits optional omission. Other failures use
      // the same typed refusal/retry as required entries; the host retains input.
      if (!entry.required && error.reason === 'not_found') continue;
      throw Object.assign(new PromptStackPreparationError(error.reason, error.ref, admittedEntries),
        error.cause === undefined ? {} : { cause: error.cause });
    }
  }
  return { blocks: out, admittedEntries };
}
