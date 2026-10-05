import { encodeBase64 } from '../../crypto/base64.js';
import {
  PromptBundleBodyV1Schema,
  validatePromptBundleBodyV1AgainstSchemaId,
  type PromptBundleBodyV1,
  type PromptBundleEntryV1,
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

export type PromptLibraryStoredArtifact = Readonly<{
  id: string;
  revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
  header: Readonly<Record<string, unknown>> | null;
  body: string | null;
}>;

export type PromptLibraryArtifactStore = Readonly<{
  /** Header inventory only. Unreadable ranges must not be reported as complete. */
  list?(options?: Readonly<{ limit?: number; cursor?: string; signal?: AbortSignal }>): Promise<Readonly<{
    items: readonly Readonly<{ id: string; header: Readonly<Record<string, unknown>> | null; updatedAtMs: number }>[];
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
  }>): Promise<void>;
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

export function normalizePromptTags(value: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value ?? []) {
    const normalized = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(normalized);
  }
  return tags;
}

function parseArtifactBody<T>(body: string | null, parse: (value: unknown) => T | null): T | null {
  if (typeof body !== 'string') return null;
  try {
    return parse(JSON.parse(body));
  } catch {
    return null;
  }
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

export async function createPromptDocInLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore;
  request: Readonly<{ title: string; markdown: string; folderId?: string | null; tags?: readonly string[];
    favorite?: boolean; origin?: 'built_in' | 'user' | 'imported' }>;
  nowMs?: () => number;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string }>> {
  throwIfAborted(params.signal);
  if (!params.store.create) throw new Error('prompt_library_artifact_create_unavailable');
  const now = (params.nowMs ?? Date.now)();
  const header = PromptDocArtifactHeaderV1Schema.parse({
    v: 1, kind: 'prompt_doc.v2', title: params.request.title, folderId: params.request.folderId ?? null,
    tags: normalizePromptTags(params.request.tags), origin: params.request.origin ?? 'user', locked: false,
    ...(params.request.favorite !== undefined ? { favorite: params.request.favorite } : {}),
  });
  const body = PromptDocBodyV1Schema.parse({ v: 1, markdown: params.request.markdown, createdAtMs: now, updatedAtMs: now });
  const artifactId = await params.store.create({ header, body: JSON.stringify(body), ...(params.signal ? { signal: params.signal } : {}) });
  throwIfAborted(params.signal);
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
  if (!PromptDocArtifactHeaderV1Schema.safeParse(artifact.header).success || typeof artifact.body !== 'string') {
    throw new Error('prompt_doc_invalid_body');
  }
  // Patch the header through the existing full-revision CAS. The body bytes and
  // timestamps remain untouched; a concurrent markdown edit refuses this write.
  await params.store.update({ artifactId: artifact.id, expectedRevision: artifact.revision,
    header: { ...artifact.header, favorite: params.request.favorite }, body: artifact.body,
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
  if (!params.store.list) return { items: [], coverage: 'unavailable' };
  const items: PromptLibraryListItem[] = [];
  let coverage: 'complete' | 'partial' | 'unavailable' = 'complete';
  const query = params.request.query?.trim().toLocaleLowerCase() ?? '';
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
      if (query && ![header.title, ...(header.tags ?? [])].some((value) => value.toLocaleLowerCase().includes(query))) continue;
      items.push({ artifactId: artifact.id, title: header.title, folderId: header.folderId ?? null,
        tags: header.tags ?? [], favorite: header.favorite ?? false, updatedAtMs: artifact.updatedAtMs });
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
    folderId?: string | null;
    tags?: readonly string[];
  }>;
  nowMs?: () => number;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string }>> {
  throwIfAborted(params.signal);
  const artifact = await params.store.read(params.request.artifactId, params.signal ? { signal: params.signal } : undefined);
  throwIfAborted(params.signal);
  if (!artifact) throw new Error('prompt_doc_missing_body');
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
  const baseHeader = artifact.header ?? { v: 1, kind: 'prompt_doc.v2', title: null };
  const nextHeader = {
    ...baseHeader,
    v: 1,
    kind: 'prompt_doc.v2',
    title: params.request.title,
    folderId: params.request.folderId ?? null,
    tags: normalizePromptTags(params.request.tags ?? (Array.isArray(baseHeader.tags) ? baseHeader.tags.map(String) : [])),
  };
  throwIfAborted(params.signal);
  await params.store.update({
    artifactId: params.request.artifactId,
    expectedRevision: artifact.revision,
    header: nextHeader,
    body: JSON.stringify(PromptDocBodyV1Schema.parse(nextBody)),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  throwIfAborted(params.signal);
  return { ok: true, artifactId: params.request.artifactId };
}

/** Account-scoped Artifact storage supplies decryption and access; reads never
 * reuse a cached document, so an approved learning is visible on the next turn. */
export async function readPromptDocInLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore;
  artifactId: string;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string; title: string; markdown: string }>
  | Readonly<{ ok: false; errorCode: 'prompt_doc_not_found' | 'prompt_doc_invalid_body'; error: string }>> {
  throwIfAborted(params.signal);
  const artifact = await params.store.read(params.artifactId, params.signal ? { signal: params.signal } : undefined);
  throwIfAborted(params.signal);
  if (!artifact) return { ok: false, errorCode: 'prompt_doc_not_found', error: 'prompt_doc_not_found' };
  const title = readArtifactTitle(artifact);
  const body = parseArtifactBody(artifact.body, (value) => {
    const parsed = PromptDocBodyV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  if (artifact.header?.kind !== 'prompt_doc.v2' || !title || !body) {
    return { ok: false, errorCode: 'prompt_doc_invalid_body', error: 'prompt_doc_invalid_body' };
  }
  return { ok: true, artifactId: params.artifactId, title, markdown: body.markdown };
}

export async function updatePromptBundleInLibrary(params: Readonly<{
  store: PromptLibraryArtifactStore;
  request: Readonly<{
    artifactId: string;
    title: string;
    skillMarkdown: string;
    folderId?: string | null;
    tags?: readonly string[];
  }>;
  nowMs?: () => number;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; artifactId: string }>> {
  throwIfAborted(params.signal);
  const artifact = await params.store.read(params.request.artifactId, params.signal ? { signal: params.signal } : undefined);
  throwIfAborted(params.signal);
  if (!artifact) throw new Error('prompt_bundle_missing_body');
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
  const baseHeader = artifact.header ?? { v: 1, kind: 'prompt_bundle.v2', title: null };
  const nextHeader = {
    ...baseHeader,
    v: 1,
    kind: 'prompt_bundle.v2',
    title: params.request.title,
    bundleSchemaId: 'skills.skill_md_v1',
    folderId: params.request.folderId ?? null,
    tags: normalizePromptTags(params.request.tags ?? (Array.isArray(baseHeader.tags) ? baseHeader.tags.map(String) : [])),
  };
  throwIfAborted(params.signal);
  await params.store.update({
    artifactId: params.request.artifactId,
    expectedRevision: artifact.revision,
    header: nextHeader,
    body: JSON.stringify(PromptBundleBodyV1Schema.parse(nextBody)),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  throwIfAborted(params.signal);
  return { ok: true, artifactId: params.request.artifactId };
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
      folderId: null,
      tags: [],
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
