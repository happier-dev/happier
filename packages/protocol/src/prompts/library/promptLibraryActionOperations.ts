import { encodeBase64 } from '../../crypto/base64.js';
import { normalizeArtifactTagsV1 as normalizePromptTags } from '../../artifacts/artifactOrganizationV1.js';
import { resolveArtifactOrganizationHeaderV1 } from '../../artifacts/artifactOrganizationV1.js';
import { ArtifactOrganizationMutationFailureV1, mutateArtifactOrganizationV1, readArtifactFolderCatalogV1, type ArtifactFolderActionPortV1 } from './promptFolderActionsV1.js';
import {
  PromptBundleArtifactHeaderV1Schema,
  PromptBundleBodyV1Schema,
  validatePromptBundleBodyV1AgainstSchemaId,
  type PromptBundleBodyV1,
  type PromptBundleEntryV1,
  type PromptBundleSchemaIdV1,
} from './promptBundleSchemas.js';
import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema, type PromptDocBodyV1 } from './promptDocV2.js';
import { computePromptBundleDigestV1, computePromptDocDigestV1 } from './promptLibraryDigests.js';
import type {
  PromptAssetInstallModeV1,
  PromptAssetMutationResponseV1,
  PromptAssetScopeV1,
  PromptAssetWriteRequest,
} from './promptAssetsV1.js';
import type {
  PromptRegistryConfiguredSourceV1,
  PromptRegistryFetchItemResponseV1,
  PromptRegistryInstallRequestV1,
  PromptRegistryInstallResponseV1,
} from './promptRegistriesV1.js';
import type { PromptExternalLinkEntryV1, PromptExternalLinksV1 } from './promptExternalLinksV1.js';
import { MemoryDocArtifactHeaderV1Schema, MemoryDocArtifactHeaderV1StoredSchema, MemoryDocBodyV1Schema, MemoryDocBodyV1StoredSchema,
  MEMORY_ARCHIVE_TOPIC_TITLE_V1, MEMORY_ARCHIVE_TOPIC_SUMMARY_V1, projectMemoryDocIndexV1, readMemoryDocTopicV1,
  type MemoryDocBodyV1, type MemoryDocIndexV1, type MemoryFactV1, type MemoryTopicV1 } from './memoryDocV1.js';
import type { PromptDocArtifactRefV1 } from './promptArtifactRefsV1.js';
import { redactBugReportSensitiveText } from '../../bugs/reports/redaction.js';

export type PromptLibraryStoredArtifact = Readonly<{
  id: string;
  revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
  header: Readonly<Record<string, unknown>> | null;
  body: string | null;
  /** Observed access on the qualified Artifact read, never inferred from headers. */
  owned?: boolean;
}>;

export type PromptLibraryArtifactStore = Readonly<{
  organization?: ArtifactFolderActionPortV1;
  /** Header inventory only. Unreadable ranges must not be reported as complete. */
  list?(options?: Readonly<{ limit?: number; cursor?: string; signal?: AbortSignal }>): Promise<Readonly<{
    items: readonly Readonly<{ id: string; header: Readonly<Record<string, unknown>> | null; updatedAtMs: number; owned?: boolean }>[];
    coverage: 'complete' | 'partial' | 'unavailable';
    nextCursor?: string;
  }>>;
  read(artifactId: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<PromptLibraryStoredArtifact | null>;
  update(input: Readonly<{
    artifactId: string;
    /** The revision returned by the read used to derive this mutation. */
    expectedRevision: PromptLibraryStoredArtifact['revision'];
    header: Readonly<Record<string, unknown>>;
    body: string;
    signal?: AbortSignal;
  }>): Promise<void | Readonly<{ revision: PromptLibraryStoredArtifact['revision'] }>>;
  create?(input: Readonly<{
    header: Readonly<Record<string, unknown>>;
    body: string;
    signal?: AbortSignal;
  }>): Promise<string>;
}>;

type PromptLibraryMutationFailure = Readonly<{
  ok: false;
  error: string;
  errorCode?: string;
  artifactId?: string;
  currentDigest?: string | null;
}>;

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export { normalizeArtifactTagsV1 as normalizePromptTags } from '../../artifacts/artifactOrganizationV1.js';

function parseArtifactBody<T>(body: string | null, parse: (value: unknown) => T | null): T | null {
  if (typeof body !== 'string') return null;
  try {
    return parse(JSON.parse(body));
  } catch {
    return null;
  }
}

export type MemoryDocMutationTargetV1 = Readonly<{
  ref: PromptDocArtifactRefV1; expectedRevision: PromptLibraryStoredArtifact['revision']; topic?: string;
}>;
type MemoryDocVersionFieldsV1 = Readonly<{
  ok: true; artifactId: string; revision: PromptLibraryStoredArtifact['revision'];
  header: Readonly<{ v: 1; kind: 'memory_doc.v1'; title: string }>;
}>;
export type MemoryDocVersionV1 = MemoryDocVersionFieldsV1 & Readonly<{ body: MemoryDocBodyV1 }>;
export type MemoryDocReadResultV1 = MemoryDocVersionFieldsV1 & (
  Readonly<{ body: MemoryDocIndexV1 }> | Readonly<{ topic: MemoryTopicV1 }>
);

export class MemoryDocFailureV1 extends Error {
  constructor(readonly code: string, readonly details?: Readonly<{ current: MemoryDocVersionV1 }>) {
    super(code);
    this.name = 'MemoryDocFailureV1';
  }
}
function memoryFailure(code: string, details?: Readonly<{ current: MemoryDocVersionV1 }>) {
  return new MemoryDocFailureV1(code, details);
}

async function readMemoryArtifact(params: Readonly<{ store: PromptLibraryArtifactStore; artifactId: string; signal?: AbortSignal }>) {
  throwIfAborted(params.signal);
  const artifact = await params.store.read(params.artifactId, params.signal ? { signal: params.signal } : undefined);
  throwIfAborted(params.signal);
  if (!artifact) throw memoryFailure('memory_doc_not_found');
  const header = MemoryDocArtifactHeaderV1StoredSchema.safeParse(artifact.header);
  const body = parseArtifactBody(artifact.body, value => {
    const parsed = MemoryDocBodyV1StoredSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  if (!header.success || !body) throw memoryFailure('memory_doc_invalid');
  return { artifact, header: header.data, body };
}

export async function readMemoryDocInLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore; artifactId: string; topic?: string; nowMs?: () => number; signal?: AbortSignal;
}>): Promise<MemoryDocReadResultV1> {
  const { artifact, header, body } = await readMemoryArtifact(params);
  const version = { ok: true as const, artifactId: artifact.id, revision: artifact.revision, header };
  const nowMs = (params.nowMs ?? Date.now)();
  if (params.topic === undefined) return { ...version, body: projectMemoryDocIndexV1(body, nowMs) };
  const topic = readMemoryDocTopicV1(body, params.topic, nowMs);
  if (!topic) throw memoryFailure('memory_topic_not_found');
  return { ...version, topic };
}

type MemoryMutationParams = Readonly<{
  store: PromptLibraryArtifactStore; request: MemoryDocMutationTargetV1; signal?: AbortSignal;
}>;
async function readReviewedMemory(params: MemoryMutationParams) {
  const read = await readMemoryArtifact({ store: params.store, artifactId: params.request.ref.artifactId, signal: params.signal });
  const revision = params.request.expectedRevision;
  if (read.artifact.revision.headerVersion !== revision.headerVersion || read.artifact.revision.bodyVersion !== revision.bodyVersion) {
    throw memoryFailure('version_mismatch', { current: memoryVersion(read) });
  }
  return read;
}

function memoryVersion(read: Awaited<ReturnType<typeof readMemoryArtifact>>): MemoryDocVersionV1 {
  return { ok: true, artifactId: read.artifact.id, revision: read.artifact.revision, header: read.header, body: read.body };
}

/** Approval and mutation share the same reviewed-version comparison and full admitted body. */
export async function readReviewedMemoryDocInLibrary(params: MemoryMutationParams): Promise<MemoryDocVersionV1> {
  return memoryVersion(await readReviewedMemory(params));
}

async function writeMemory(params: MemoryMutationParams, read: Awaited<ReturnType<typeof readReviewedMemory>>, body: MemoryDocBodyV1) {
  throwIfAborted(params.signal);
  try {
    await params.store.update({ artifactId: read.artifact.id, expectedRevision: params.request.expectedRevision,
      header: read.artifact.header!, body: JSON.stringify(MemoryDocBodyV1Schema.parse(body)),
      ...(params.signal ? { signal: params.signal } : {}) });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'version_mismatch') {
      // This is a new access/mode-aware read, never the earlier approved snapshot or an automatic retry.
      const current = await readMemoryArtifact({ store: params.store, artifactId: read.artifact.id, signal: params.signal });
      throw memoryFailure('version_mismatch', { current: memoryVersion(current) });
    }
    throw error;
  }
  return { ok: true as const, artifactId: read.artifact.id };
}

function appendMemoryFact(body: MemoryDocBodyV1, fact: MemoryFactV1, title?: string): MemoryDocBodyV1 {
  if (title === undefined) return { ...body, index: [...body.index, fact] };
  const topic = body.topics.find(candidate => candidate.title === title);
  return { ...body, topics: topic ? body.topics.map(candidate => candidate.title === title
    ? { ...candidate, facts: [...candidate.facts, fact] } : candidate)
    : [...body.topics, { title, summary: title === MEMORY_ARCHIVE_TOPIC_TITLE_V1 ? MEMORY_ARCHIVE_TOPIC_SUMMARY_V1 : `Facts about ${title}.`, facts: [fact] }] };
}

type MemoryFactAuthorParams = Readonly<{
  randomId: () => string; nowMs?: () => number; sourceSessionRef: MemoryFactV1['sourceSessionRef'];
}>;
function authorMemoryFact(params: MemoryFactAuthorParams, request: Readonly<{ text: string; expiresAtMs?: number }>): MemoryFactV1 {
  return { id: params.randomId(), text: redactBugReportSensitiveText(request.text),
    createdAtMs: (params.nowMs ?? Date.now)(), sourceSessionRef: params.sourceSessionRef,
    ...(request.expiresAtMs === undefined ? {} : { expiresAtMs: request.expiresAtMs }) };
}

/** Lazy scope creation uses the same fact author and topic decision as later remembers. */
export async function createMemoryDocInLibrary(params: MemoryFactAuthorParams & Readonly<{
  store: PromptLibraryArtifactStore; request: Readonly<{ title: string; text: string; topic?: string; expiresAtMs?: number }>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string; factId: string }>> {
  throwIfAborted(params.signal);
  if (!params.store.create) throw memoryFailure('memory_doc_create_unavailable');
  const fact = authorMemoryFact(params, params.request);
  const body = MemoryDocBodyV1Schema.parse(appendMemoryFact({ v: 1, index: [], topics: [] }, fact, params.request.topic));
  const header = MemoryDocArtifactHeaderV1Schema.parse({ v: 1, kind: 'memory_doc.v1', title: params.request.title });
  throwIfAborted(params.signal);
  const artifactId = await params.store.create({ header, body: JSON.stringify(body), ...(params.signal ? { signal: params.signal } : {}) });
  return { ok: true, artifactId, factId: fact.id };
}

export async function rememberMemoryFactInLibrary(params: MemoryMutationParams & MemoryFactAuthorParams & Readonly<{
  request: MemoryDocMutationTargetV1 & Readonly<{ text: string; expiresAtMs?: number }>;
}>): Promise<Readonly<{ ok: true; artifactId: string; factId: string }>> {
  const read = await readReviewedMemory(params);
  const fact = authorMemoryFact(params, params.request);
  const result = await writeMemory(params, read, appendMemoryFact(read.body, fact, params.request.topic));
  return { ...result, factId: fact.id };
}

export async function updateMemoryFactInLibrary(params: MemoryMutationParams & MemoryFactAuthorParams & Readonly<{
  request: MemoryDocMutationTargetV1 & Readonly<{ factId: string; text: string; expiresAtMs?: number | null }>;
}>): Promise<Readonly<{ ok: true; artifactId: string; factId: string }>> {
  const read = await readReviewedMemory(params);
  const previous = read.body.index.find(fact => fact.id === params.request.factId)
    ?? read.body.topics.filter(topic => topic.title !== MEMORY_ARCHIVE_TOPIC_TITLE_V1).flatMap(topic => topic.facts).find(fact => fact.id === params.request.factId);
  if (!previous) throw memoryFailure('memory_fact_not_found');
  const expiresAtMs = params.request.expiresAtMs === undefined ? previous.expiresAtMs : params.request.expiresAtMs;
  const next: MemoryFactV1 = { id: params.randomId(), text: redactBugReportSensitiveText(params.request.text),
    createdAtMs: (params.nowMs ?? Date.now)(), sourceSessionRef: params.sourceSessionRef, supersedes: previous.id,
    ...(expiresAtMs == null ? {} : { expiresAtMs }) };
  const destination = params.request.topic;
  let replaced = false;
  const replace = (facts: readonly MemoryFactV1[], title?: string) => facts.flatMap(fact => {
    if (fact.id !== previous.id) return [fact];
    if (title !== destination) return [];
    replaced = true;
    return [next];
  });
  let body: MemoryDocBodyV1 = { ...read.body, index: replace(read.body.index),
    topics: read.body.topics.map(topic => ({ ...topic, facts: replace(topic.facts, topic.title) })) };
  if (!replaced) body = appendMemoryFact(body, next, destination);
  body = appendMemoryFact(body, previous, MEMORY_ARCHIVE_TOPIC_TITLE_V1);
  const result = await writeMemory(params, read, body);
  return { ...result, factId: next.id };
}

export async function forgetMemoryFactInLibrary(params: MemoryMutationParams & Readonly<{
  request: MemoryDocMutationTargetV1 & Readonly<{ factId: string }>;
}>): Promise<Readonly<{ ok: true; artifactId: string; factId: string }>> {
  const read = await readReviewedMemory(params);
  const title = params.request.topic;
  const facts = title === undefined ? read.body.index
    : title === MEMORY_ARCHIVE_TOPIC_TITLE_V1 ? [] : read.body.topics.find(topic => topic.title === title)?.facts ?? [];
  const previous = facts.find(fact => fact.id === params.request.factId);
  if (!previous) throw memoryFailure('memory_fact_not_found');
  const body = { ...read.body, index: title === undefined ? read.body.index.filter(fact => fact.id !== previous.id) : read.body.index,
    topics: read.body.topics.map(topic => topic.title === title ? { ...topic, facts: topic.facts.filter(fact => fact.id !== previous.id) } : topic) };
  const result = await writeMemory(params, read, appendMemoryFact(body, previous, MEMORY_ARCHIVE_TOPIC_TITLE_V1));
  return { ...result, factId: previous.id };
}

/** Inventory is the existing paged Artifact inventory, not a separate memory catalog. */
export async function listMemoryDocsInLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore; request: Readonly<{ cursor?: string; limit?: number }>; signal?: AbortSignal;
}>): Promise<Readonly<{ items: readonly Readonly<{ artifactId: string; title: string; updatedAtMs: number }>[];
  coverage: 'complete' | 'partial' | 'unavailable'; nextCursor?: string }>> {
  throwIfAborted(params.signal);
  if (!params.store.list) return { items: [], coverage: 'unavailable' };
  const page = await params.store.list({ ...params.request, ...(params.signal ? { signal: params.signal } : {}) });
  throwIfAborted(params.signal);
  return { items: page.items.flatMap(item => {
    const header = MemoryDocArtifactHeaderV1StoredSchema.safeParse(item.header);
    return header.success ? [{ artifactId: item.id, title: header.data.title, updatedAtMs: item.updatedAtMs }] : [];
  }), coverage: page.coverage, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
}

function readArtifactTitle(artifact: PromptLibraryStoredArtifact): string | null {
  const title = artifact.header?.title;
  return typeof title === 'string' && title.trim().length > 0 ? title : null;
}

function upsertSkillMd(entries: readonly PromptBundleEntryV1[], markdown: string): PromptBundleEntryV1[] {
  const entry: PromptBundleEntryV1 = {
    path: 'SKILL.md',
    contentBase64: encodeBase64(new TextEncoder().encode(markdown), 'base64'),
    contentKind: 'utf8',
  };
  return [entry, ...entries.filter((candidate) => candidate.path !== 'SKILL.md')];
}

type PromptOrganizationRequest = Readonly<{ folderId?: string | null; tags?: readonly string[] }>;

export async function requirePromptArtifactOrganizationV1(store: PromptLibraryArtifactStore, request: PromptOrganizationRequest,
  signal?: AbortSignal): Promise<void> {
  if (request.folderId === undefined && request.tags === undefined) return;
  if (!store.organization) {
    throw Object.assign(new Error('artifact_organization_unavailable'), { code: 'artifact_organization_unavailable' });
  }
  const read = await readArtifactFolderCatalogV1({ port: store.organization, signal });
  if (read.status !== 'ready') throw Object.assign(new Error(read.reason), { code: read.reason });
  if (request.folderId && !read.value.folders.some(folder => folder.id === request.folderId)) {
    throw Object.assign(new Error('folder_not_found'), { code: 'folder_not_found' });
  }
}

/** A content receipt is never hidden if the independent personal-row CAS fails. */
export async function persistPromptArtifactOrganizationV1(input: Readonly<{
  store: PromptLibraryArtifactStore; artifactId: string; request: PromptOrganizationRequest; signal?: AbortSignal;
  contentRevision?: PromptLibraryStoredArtifact['revision'];
}>): Promise<void> {
  if (input.request.folderId === undefined && input.request.tags === undefined) return;
  const receipt = { artifactId: input.artifactId,
    ...(input.contentRevision ? { contentRevision: input.contentRevision } : {}) };
  if (!input.store.organization) {
    throw new ArtifactOrganizationMutationFailureV1({ ...receipt,
      organization: { status: 'unavailable', reason: 'artifact_organization_unavailable' } });
  }
  let result: Awaited<ReturnType<typeof mutateArtifactOrganizationV1>>;
  try {
    result = await mutateArtifactOrganizationV1({ port: input.store.organization, artifactId: input.artifactId,
      change: { ...(input.request.folderId === undefined ? {} : { folderId: input.request.folderId }),
        ...(input.request.tags === undefined ? {} : { tags: normalizePromptTags(input.request.tags) }) }, signal: input.signal });
  } catch (cause) {
    throw new ArtifactOrganizationMutationFailureV1({ ...receipt,
      organization: { status: 'unavailable', reason: 'artifact_organization_unavailable' } }, { cause });
  }
  if (result.status !== 'updated') throw new ArtifactOrganizationMutationFailureV1({ ...receipt, organization: result });
}

export async function createPromptDocInLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore;
  request: Readonly<{ title: string; markdown: string; folderId?: string | null; tags?: readonly string[];
    favorite?: boolean; origin?: 'built_in' | 'user' | 'imported' }>;
  nowMs?: () => number;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string }>> {
  throwIfAborted(params.signal);
  if (!params.store.create) throw new Error('prompt_library_artifact_create_unavailable');
  if (params.request.folderId != null || normalizePromptTags(params.request.tags).length > 0) {
    await requirePromptArtifactOrganizationV1(params.store, params.request, params.signal);
  }
  const now = (params.nowMs ?? Date.now)();
  const header = PromptDocArtifactHeaderV1Schema.parse({
    v: 1, kind: 'prompt_doc.v2', title: params.request.title,
    origin: params.request.origin ?? 'user', locked: false,
    ...(params.request.favorite !== undefined ? { favorite: params.request.favorite } : {}),
  });
  const body = PromptDocBodyV1Schema.parse({ v: 1, markdown: params.request.markdown, createdAtMs: now, updatedAtMs: now });
  const artifactId = await params.store.create({ header, body: JSON.stringify(body), ...(params.signal ? { signal: params.signal } : {}) });
  if (params.request.folderId != null || normalizePromptTags(params.request.tags).length > 0) {
    await persistPromptArtifactOrganizationV1({ store: params.store, artifactId, request: params.request, signal: params.signal });
  }
  return { ok: true, artifactId };
}

export async function createPromptBundleInLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore;
  request: Readonly<{ title: string; bundleSchemaId: PromptBundleSchemaIdV1; entries: readonly PromptBundleEntryV1[];
    folderId?: string | null; tags?: readonly string[]; origin?: 'built_in' | 'user' | 'imported' }>;
  nowMs?: () => number;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string }>> {
  throwIfAborted(params.signal);
  if (!params.store.create) throw new Error('prompt_bundle_create_unavailable');
  const hasOrganization = params.request.folderId != null || normalizePromptTags(params.request.tags).length > 0;
  if (hasOrganization) await requirePromptArtifactOrganizationV1(params.store, params.request, params.signal);
  const now = (params.nowMs ?? Date.now)();
  const body = PromptBundleBodyV1Schema.parse({ v: 1, entries: [...params.request.entries], createdAtMs: now, updatedAtMs: now });
  const validation = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: params.request.bundleSchemaId, body });
  if (!validation.ok) throw Object.assign(new Error(validation.errorCode), { code: validation.errorCode });
  const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: params.request.title,
    bundleSchemaId: params.request.bundleSchemaId, origin: params.request.origin ?? 'user', locked: false });
  throwIfAborted(params.signal);
  const artifactId = await params.store.create({ header, body: JSON.stringify(body), ...(params.signal ? { signal: params.signal } : {}) });
  if (hasOrganization) await persistPromptArtifactOrganizationV1({ store: params.store, artifactId, request: params.request, signal: params.signal });
  return { ok: true, artifactId };
}

export async function setPromptDocFavorite(params: Readonly<{
  store: PromptLibraryArtifactStore;
  request: Readonly<{ artifactId: string; favorite: boolean }>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string }>> {
  throwIfAborted(params.signal);
  const artifact = await params.store.read(params.request.artifactId, params.signal ? { signal: params.signal } : undefined);
  throwIfAborted(params.signal);
  if (!artifact) throw new Error('prompt_doc_not_found');
  const header = PromptDocArtifactHeaderV1Schema.safeParse(artifact.header);
  const body = parseArtifactBody(artifact.body, value => {
    const parsed = PromptDocBodyV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  if (!header.success || !body) {
    throw new Error('prompt_doc_invalid_body');
  }
  // The full-revision CAS preserves content and timestamps while current writes
  // normalize admitted fields rather than retaining unrecognized extensions.
  await params.store.update({ artifactId: artifact.id, expectedRevision: artifact.revision,
    header: { ...header.data, favorite: params.request.favorite }, body: JSON.stringify(body),
    ...(params.signal ? { signal: params.signal } : {}) });
  throwIfAborted(params.signal);
  return { ok: true, artifactId: artifact.id };
}

export type PromptLibraryListItem = Readonly<{
  artifactId: string; title: string; folderId: string | null; tags: readonly string[]; favorite: boolean; updatedAtMs: number;
}>;

export async function listPromptLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore;
  request: Readonly<{ query?: string; includeBundles?: false }>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ items: readonly PromptLibraryListItem[]; coverage: 'complete' | 'partial' | 'unavailable' }>> {
  throwIfAborted(params.signal);
  if (!params.store.list || !params.store.organization) return { items: [], coverage: 'unavailable' };
  const items: PromptLibraryListItem[] = [];
  let coverage: 'complete' | 'partial' | 'unavailable' = 'complete';
  const query = params.request.query?.trim().toLocaleLowerCase() ?? '';
  const folderRead = await readArtifactFolderCatalogV1({ port: params.store.organization, signal: params.signal });
  if (folderRead.status !== 'ready') {
    return { items: [], coverage: 'unavailable' };
  }
  const personal = folderRead.value.artifactHeadersById;
  let cursor: string | undefined;
  do {
    // The Artifact API admits pages of at most 500 rows. This is a transport
    // page, never a limit on the user's library.
    const inventory = await params.store.list({ limit: 500, ...(cursor ? { cursor } : {}),
      ...(params.signal ? { signal: params.signal } : {}) });
    throwIfAborted(params.signal);
    if (inventory.coverage === 'partial') coverage = 'partial';
    if (inventory.coverage === 'unavailable') coverage = items.length || inventory.items.length ? 'partial' : 'unavailable';
    for (const artifact of inventory.items) {
      if (!artifact.header) {
        if (coverage === 'complete') coverage = 'partial';
        continue;
      }
      if (artifact.header.kind !== 'prompt_doc.v2') continue;
      const parsed = PromptDocArtifactHeaderV1Schema.safeParse(artifact.header);
      if (!parsed.success) {
        if (coverage === 'complete') coverage = 'partial';
        continue;
      }
      const header = parsed.data;
      let organization;
      try {
        organization = resolveArtifactOrganizationHeaderV1({ artifactId: artifact.id, artifactHeadersById: personal,
          header: artifact.header, owned: artifact.owned === true });
      } catch { coverage = 'partial'; continue; }
      if (query && ![header.title, ...(organization.tags ?? [])].some((value) => value.toLocaleLowerCase().includes(query))) continue;
      items.push({ artifactId: artifact.id, title: header.title, folderId: organization.folderId ?? null,
        tags: organization.tags ?? [], favorite: header.favorite ?? false, updatedAtMs: artifact.updatedAtMs });
    }
    cursor = inventory.nextCursor;
  } while (cursor);
  return { items, coverage };
}

export async function updatePromptDocInLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore;
  request: Readonly<{
    artifactId: string;
    title: string;
    markdown: string;
    expectedRevision?: PromptLibraryStoredArtifact['revision'];
    folderId?: string | null;
    tags?: readonly string[];
  }>;
  nowMs?: () => number;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string; revision?: PromptLibraryStoredArtifact['revision'] }>> {
  throwIfAborted(params.signal);
  await requirePromptArtifactOrganizationV1(params.store, params.request, params.signal);
  const artifact = await params.store.read(params.request.artifactId, params.signal ? { signal: params.signal } : undefined);
  throwIfAborted(params.signal);
  if (!artifact) throw new Error('prompt_doc_missing_body');
  const expected = params.request.expectedRevision;
  if (expected && (expected.headerVersion !== artifact.revision.headerVersion || expected.bodyVersion !== artifact.revision.bodyVersion)) {
    throw Object.assign(new Error('artifact_version_mismatch'), { code: 'version_mismatch' });
  }
  const body = parseArtifactBody(artifact.body, (value) => {
    const parsed = PromptDocBodyV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  if (!body) throw new Error('prompt_doc_invalid_body');

  const nextBody: PromptDocBodyV1 = {
    ...body,
    markdown: params.request.markdown,
    updatedAtMs: (params.nowMs ?? Date.now)(),
  };
  const header = PromptDocArtifactHeaderV1Schema.safeParse(artifact.header);
  if (!header.success) throw new Error('prompt_doc_invalid_body');
  const baseHeader = header.data;
  const nextHeader = PromptDocArtifactHeaderV1Schema.parse({
    ...baseHeader,
    v: 1,
    kind: 'prompt_doc.v2',
    title: params.request.title,
  });
  throwIfAborted(params.signal);
  const receipt = await params.store.update({
    artifactId: params.request.artifactId,
    expectedRevision: artifact.revision,
    header: nextHeader,
    body: JSON.stringify(PromptDocBodyV1Schema.parse(nextBody)),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  await persistPromptArtifactOrganizationV1({ store: params.store, artifactId: params.request.artifactId, request: params.request,
    signal: params.signal, ...(receipt ? { contentRevision: receipt.revision } : {}) });
  return { ok: true, artifactId: params.request.artifactId, ...(receipt ? { revision: receipt.revision } : {}) };
}

/** Account-scoped Artifact storage supplies decryption and access; reads never
 * reuse a cached document, so an approved learning is visible on the next turn. */
export async function readPromptDocInLibrary(params: Readonly<{
  store: Pick<PromptLibraryArtifactStore, 'read'>;
  artifactId: string;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string; title: string; markdown: string; revision: PromptLibraryStoredArtifact['revision'] }>
  | Readonly<{ ok: false; errorCode: 'prompt_doc_not_found' | 'prompt_doc_wrong_kind' | 'prompt_doc_invalid_body'; error: string }>> {
  throwIfAborted(params.signal);
  const artifact = await params.store.read(params.artifactId, params.signal ? { signal: params.signal } : undefined);
  throwIfAborted(params.signal);
  if (!artifact) return { ok: false, errorCode: 'prompt_doc_not_found', error: 'prompt_doc_not_found' };
  if (artifact.header?.kind !== 'prompt_doc.v2') {
    return { ok: false, errorCode: 'prompt_doc_wrong_kind', error: 'prompt_doc_wrong_kind' };
  }
  const header = PromptDocArtifactHeaderV1Schema.safeParse(artifact.header);
  const body = parseArtifactBody(artifact.body, (value) => {
    const parsed = PromptDocBodyV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  if (!header.success || !body) {
    return { ok: false, errorCode: 'prompt_doc_invalid_body', error: 'prompt_doc_invalid_body' };
  }
  return { ok: true, artifactId: params.artifactId, title: header.data.title, markdown: body.markdown, revision: artifact.revision };
}

export async function updatePromptBundleInLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore;
  request: Readonly<{
    artifactId: string;
    title: string;
    skillMarkdown: string;
    expectedRevision?: PromptLibraryStoredArtifact['revision'];
    folderId?: string | null;
    tags?: readonly string[];
  }>;
  nowMs?: () => number;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string; revision?: PromptLibraryStoredArtifact['revision'] }>> {
  throwIfAborted(params.signal);
  await requirePromptArtifactOrganizationV1(params.store, params.request, params.signal);
  const artifact = await params.store.read(params.request.artifactId, params.signal ? { signal: params.signal } : undefined);
  throwIfAborted(params.signal);
  if (!artifact) throw new Error('prompt_bundle_missing_body');
  const expected = params.request.expectedRevision;
  if (expected && (expected.headerVersion !== artifact.revision.headerVersion || expected.bodyVersion !== artifact.revision.bodyVersion)) {
    throw Object.assign(new Error('artifact_version_mismatch'), { code: 'version_mismatch' });
  }
  const header = PromptBundleArtifactHeaderV1Schema.safeParse(artifact.header);
  if (!header.success) throw Object.assign(new Error('prompt_bundle_invalid_kind'), { code: 'prompt_bundle_invalid_kind' });
  const body = parseArtifactBody(artifact.body, (value) => {
    const parsed = PromptBundleBodyV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  if (!body) throw new Error('prompt_bundle_invalid_body');
  const nextBody: PromptBundleBodyV1 = {
    ...body,
    entries: upsertSkillMd(body.entries, params.request.skillMarkdown),
    updatedAtMs: (params.nowMs ?? Date.now)(),
  };
  const validation = validatePromptBundleBodyV1AgainstSchemaId({
    bundleSchemaId: 'skills.skill_md_v1',
    body: nextBody,
  });
  if (!validation.ok) throw new Error(validation.errorCode);
  const baseHeader = header.data;
  const nextHeader = {
    ...baseHeader,
    v: 1,
    kind: 'prompt_bundle.v2',
    title: params.request.title,
    bundleSchemaId: 'skills.skill_md_v1',
  };
  throwIfAborted(params.signal);
  const receipt = await params.store.update({
    artifactId: params.request.artifactId,
    expectedRevision: artifact.revision,
    header: nextHeader,
    body: JSON.stringify(PromptBundleBodyV1Schema.parse(nextBody)),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  await persistPromptArtifactOrganizationV1({ store: params.store, artifactId: params.request.artifactId, request: params.request,
    signal: params.signal, ...(receipt ? { contentRevision: receipt.revision } : {}) });
  return { ok: true, artifactId: params.request.artifactId, ...(receipt ? { revision: receipt.revision } : {}) };
}

export type ExportablePromptLibraryArtifact =
  | Readonly<{ libraryKind: 'doc'; title: string; markdown: string }>
  | Readonly<{ libraryKind: 'bundle'; title: string; bundleBody: PromptBundleBodyV1 }>;

export async function readPromptLibraryArtifactForExport(params: Readonly<{
  store: PromptLibraryArtifactStore;
  artifactId: string;
  signal?: AbortSignal;
}>): Promise<ExportablePromptLibraryArtifact | null> {
  throwIfAborted(params.signal);
  const artifact = await params.store.read(params.artifactId, params.signal ? { signal: params.signal } : undefined);
  throwIfAborted(params.signal);
  if (!artifact) return null;
  const title = readArtifactTitle(artifact);
  if (!title) return null;
  const doc = parseArtifactBody(artifact.body, (value) => {
    const parsed = PromptDocBodyV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  if (doc) return { libraryKind: 'doc', title, markdown: doc.markdown };
  const bundle = parseArtifactBody(artifact.body, (value) => {
    const parsed = PromptBundleBodyV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  return bundle ? { libraryKind: 'bundle', title, bundleBody: bundle } : null;
}

export function findPromptExternalLink(
  links: PromptExternalLinksV1 | null | undefined,
  params: Readonly<{
    artifactId: string;
    assetTypeId: string;
    machineId: string;
    scope: PromptAssetScopeV1;
    workspacePath?: string | null;
  }>,
): PromptExternalLinkEntryV1 | null {
  const workspacePath = params.workspacePath ?? null;
  return (links?.links ?? []).filter((entry) => (
    entry.artifactId === params.artifactId
    && entry.assetTypeId === params.assetTypeId
    && entry.machineId === params.machineId
    && entry.scope === params.scope
    && (entry.workspacePath ?? null) === workspacePath
  )).at(-1) ?? null;
}

export function upsertPromptExternalLink(
  links: PromptExternalLinksV1 | null | undefined,
  nextLink: PromptExternalLinkEntryV1,
): PromptExternalLinksV1 {
  const next = (links?.links ?? []).filter((entry) => !(
    entry.id === nextLink.id
    || (
      entry.artifactId === nextLink.artifactId
      && entry.assetTypeId === nextLink.assetTypeId
      && entry.machineId === nextLink.machineId
      && entry.scope === nextLink.scope
      && (entry.workspacePath ?? null) === (nextLink.workspacePath ?? null)
    )
  ));
  return { v: 1, links: [...next, nextLink] };
}

export async function exportPromptLibraryArtifact(params: Readonly<{
  store: PromptLibraryArtifactStore;
  write(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: PromptAssetWriteRequest;
    signal?: AbortSignal;
  }>): Promise<PromptAssetMutationResponseV1>;
  request: Readonly<{
    artifactId: string;
    machineId: string;
    assetTypeId: string;
    scope: PromptAssetScopeV1;
    serverId?: string | null;
    workspacePath?: string | null;
    targetInput: string;
    installMode?: PromptAssetInstallModeV1;
    promptExternalLinks: PromptExternalLinksV1 | null | undefined;
    previewOnly?: boolean;
  }>;
  randomId: () => string;
  nowMs?: () => number;
  signal?: AbortSignal;
}>): Promise<PromptLibraryMutationFailure | Readonly<{
  ok: true;
  artifactId: string;
  exported: boolean;
  artifactState: ExportablePromptLibraryArtifact;
  response: Extract<PromptAssetMutationResponseV1, { ok: true }>;
  nextPromptExternalLinks?: PromptExternalLinksV1;
}>> {
  const artifactState = await readPromptLibraryArtifactForExport({
    store: params.store,
    artifactId: params.request.artifactId,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!artifactState) return { ok: false, error: 'promptLibrary.saveError' };
  const directory = params.request.scope === 'project'
    ? String(params.request.workspacePath ?? '').trim() || null
    : null;
  if (params.request.scope === 'project' && !directory) {
    return { ok: false, error: 'promptLibrary.externalAssetsProjectDirectoryRequired' };
  }
  const currentLink = findPromptExternalLink(params.request.promptExternalLinks, {
    artifactId: params.request.artifactId,
    assetTypeId: params.request.assetTypeId,
    machineId: params.request.machineId,
    scope: params.request.scope,
    workspacePath: directory,
  });
  const common = {
    assetTypeId: params.request.assetTypeId,
    scope: params.request.scope,
    ...(directory ? { directory } : {}),
    externalRef: currentLink?.externalRef ?? null,
    title: artifactState.title,
    previewOnly: params.request.previewOnly === true,
    expectedDigest: currentLink?.lastExternalDigest ?? null,
  };
  const request: PromptAssetWriteRequest = artifactState.libraryKind === 'doc'
    ? { ...common, targetPath: params.request.targetInput.trim(), markdown: artifactState.markdown }
    : {
        ...common,
        targetName: params.request.targetInput.trim(),
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody: artifactState.bundleBody,
        ...(params.request.installMode ? { installMode: params.request.installMode } : {}),
      };
  throwIfAborted(params.signal);
  const response = await params.write({
    machineId: params.request.machineId,
    ...(params.request.serverId ? { serverId: params.request.serverId } : {}),
    request,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  throwIfAborted(params.signal);
  if (!response.ok) {
    return {
      ok: false,
      error: response.error,
      errorCode: response.errorCode,
      ...(Object.prototype.hasOwnProperty.call(response, 'currentDigest')
        ? { currentDigest: response.currentDigest ?? null }
        : {}),
    };
  }
  if (params.request.previewOnly === true) {
    return { ok: true, artifactId: params.request.artifactId, exported: false, artifactState, response };
  }
  if (!response.externalRef) return { ok: false, error: 'promptLibrary.saveError' };
  const nextPromptExternalLinks = upsertPromptExternalLink(params.request.promptExternalLinks, {
    id: currentLink?.id ?? params.randomId(),
    artifactId: params.request.artifactId,
    assetTypeId: params.request.assetTypeId,
    scope: params.request.scope,
    machineId: params.request.machineId,
    workspacePath: directory,
    externalRef: response.externalRef,
    syncMode: currentLink?.syncMode ?? 'manual',
    baseDigest: currentLink?.baseDigest ?? response.digest ?? null,
    lastLibraryDigest: artifactState.libraryKind === 'doc'
      ? computePromptDocDigestV1(artifactState.markdown)
      : computePromptBundleDigestV1(artifactState.bundleBody),
    lastExternalDigest: response.digest ?? null,
    lastSyncAtMs: (params.nowMs ?? Date.now)(),
  });
  return {
    ok: true,
    artifactId: params.request.artifactId,
    exported: true,
    artifactState,
    response,
    nextPromptExternalLinks,
  };
}

export async function installPromptRegistryItemInLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore;
  fetchItem(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    sourceId: string;
    itemId: string;
    configuredSources: readonly PromptRegistryConfiguredSourceV1[];
    signal?: AbortSignal;
  }>): Promise<PromptRegistryFetchItemResponseV1>;
  install(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    request: PromptRegistryInstallRequestV1;
    signal?: AbortSignal;
  }>): Promise<PromptRegistryInstallResponseV1>;
  request: Readonly<{
    machineId: string;
    serverId?: string | null;
    sourceId: string;
    itemId: string;
    configuredSources: readonly PromptRegistryConfiguredSourceV1[];
    installTarget?: PromptRegistryInstallRequestV1['installTarget'];
    promptExternalLinks: PromptExternalLinksV1 | null | undefined;
    previewOnly?: boolean;
  }>;
  randomId: () => string;
  nowMs?: () => number;
  signal?: AbortSignal;
}>): Promise<PromptLibraryMutationFailure | Readonly<{
  ok: true;
  artifactId?: string;
  routeKind: 'bundle';
  exported: boolean;
  response?: Extract<PromptRegistryInstallResponseV1, { ok: true }>;
  nextPromptExternalLinks?: PromptExternalLinksV1;
}>> {
  throwIfAborted(params.signal);
  const fetched = await params.fetchItem({
    machineId: params.request.machineId,
    ...(params.request.serverId ? { serverId: params.request.serverId } : {}),
    sourceId: params.request.sourceId,
    itemId: params.request.itemId,
    configuredSources: params.request.configuredSources,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  throwIfAborted(params.signal);
  if (!fetched.ok) return { ok: false, error: fetched.error, errorCode: fetched.errorCode };
  if (fetched.item.bundleSchemaId !== 'skills.skill_md_v1') {
    return { ok: false, error: 'promptLibrary.externalAssetsUnsupportedImport', errorCode: 'unsupported' };
  }

  let response: Extract<PromptRegistryInstallResponseV1, { ok: true }> | undefined;
  if (params.request.installTarget) {
    const installed = await params.install({
      machineId: params.request.machineId,
      ...(params.request.serverId ? { serverId: params.request.serverId } : {}),
      request: {
        sourceId: params.request.sourceId,
        itemId: params.request.itemId,
        configuredSources: [...params.request.configuredSources],
        installTarget: params.request.installTarget,
        previewOnly: params.request.previewOnly === true,
      },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    throwIfAborted(params.signal);
    if (!installed.ok || !installed.externalRef) {
      return {
        ok: false,
        error: installed.ok ? 'promptLibrary.saveError' : installed.error,
        ...(!installed.ok
          ? {
              errorCode: installed.errorCode,
              ...(Object.prototype.hasOwnProperty.call(installed, 'currentDigest')
                ? { currentDigest: installed.currentDigest ?? null }
                : {}),
            }
          : {}),
      };
    }
    response = installed;
    if (params.request.previewOnly === true) {
      return { ok: true, routeKind: 'bundle', exported: false, response };
    }
  }

  if (!params.store.create) throw new Error('prompt_library_artifact_create_unavailable');
  const artifactId = await params.store.create({
    header: {
      v: 1,
      kind: 'prompt_bundle.v2',
      title: fetched.item.title,
      bundleSchemaId: fetched.item.bundleSchemaId,
      origin: 'imported',
      locked: false,
    },
    body: JSON.stringify(fetched.item.bundleBody),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  throwIfAborted(params.signal);
  if (!params.request.installTarget || !response?.externalRef) {
    return { ok: true, artifactId, routeKind: 'bundle', exported: false };
  }
  const nextPromptExternalLinks = upsertPromptExternalLink(params.request.promptExternalLinks, {
    id: params.randomId(),
    artifactId,
    assetTypeId: params.request.installTarget.assetTypeId,
    scope: params.request.installTarget.scope,
    machineId: params.request.machineId,
    workspacePath: params.request.installTarget.scope === 'project'
      ? (params.request.installTarget.directory ?? null)
      : null,
    externalRef: response.externalRef,
    syncMode: 'manual',
    baseDigest: response.digest ?? null,
    lastLibraryDigest: computePromptBundleDigestV1(fetched.item.bundleBody),
    lastExternalDigest: response.digest ?? null,
    lastSyncAtMs: (params.nowMs ?? Date.now)(),
  });
  return {
    ok: true,
    artifactId,
    routeKind: 'bundle',
    exported: true,
    response,
    nextPromptExternalLinks,
  };
}
