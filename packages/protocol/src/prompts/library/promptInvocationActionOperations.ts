import { isPromptInvocationAvailable, PromptInvocationEntryV1Schema, PromptInvocationsV1Schema, validatePromptInvocationTokenV1, type PromptInvocationEntryV1 } from './promptInvocationsV1.js';
import { readPromptLibraryCatalogRecordV1, type PromptLibraryStackActionPortV1 } from './promptLibraryCatalogV1.js';
import type { z } from '../../zodRuntimePolicy.js';
import type { PromptInvocationCreateInputSchema, PromptInvocationCreateOutputSchema, PromptInvocationUpdateInputSchema,
  PromptInvocationUpdateOutputSchema, PromptInvocationDeleteInputSchema, PromptInvocationDeleteOutputSchema } from '../../actions/promptInvocationCreateActionSpecs.js';
import { readPromptDocInLibrary, type PromptLibraryArtifactStore, type PromptLibraryStoredArtifact } from './promptLibraryActionOperations.js';
import type { PromptDocArtifactRefV1 } from './promptArtifactRefsV1.js';
import { renderPromptTemplateTextV1 } from './renderPromptTemplateTextV1.js';

export type PromptInvocationsListItem = Readonly<Pick<PromptInvocationEntryV1, 'id' | 'token' | 'title' | 'target' | 'behavior' | 'allowArgs' | 'availableIn'>>;
export type PromptInvocationsListResult = Readonly<{ items: readonly PromptInvocationsListItem[]; coverage: 'complete' | 'truncated' | 'unavailable'; revision?: number | 'absent' }>;
export type PromptInvocationResolveResult =
  | Readonly<{ status: 'resolved'; invocationId: string; token: string; title: string; behavior: PromptInvocationEntryV1['behavior']; text: string }>
  | Readonly<{ status: 'unknownInvocation' | 'unavailable'; invocationId: string }>;
export type PromptInvocationArtifactReader = (ref: PromptDocArtifactRefV1, options?: Readonly<{ signal?: AbortSignal }>) => Promise<PromptLibraryStoredArtifact | null>;

async function readInvocationCatalog(params: Readonly<{ port: PromptLibraryStackActionPortV1; signal?: AbortSignal }>) {
  params.signal?.throwIfAborted(); params.port.assertCurrent();
  const projection = await params.port.readCatalog(params.signal);
  params.signal?.throwIfAborted(); params.port.assertCurrent();
  const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'invocations' });
  if (read.status !== 'ready') return read;
  if (read.record.key !== 'invocations') return { status: 'unavailable' as const, reason: 'invalid-stored-content' };
  if (read.authority === 'inactive' && projection.sourceSettingsVersion === undefined) {
    return { status: 'unavailable' as const, reason: 'source-currentness-unavailable' };
  }
  return { status: 'ready' as const, record: read.record, revision: read.revision,
    ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}) };
}

async function writeInvocationEntries(params: Readonly<{ port: PromptLibraryStackActionPortV1; signal?: AbortSignal }>,
  source: Extract<Awaited<ReturnType<typeof readInvocationCatalog>>, { status: 'ready' }>, entries: PromptInvocationEntryV1[]) {
  params.signal?.throwIfAborted(); params.port.assertCurrent();
  const receipt = await params.port.writeRecord({ record: { key: 'invocations', value: { ...source.record.value, entries } },
    expectedRevision: source.revision, ...(source.sourceSettingsVersion !== undefined ? { sourceSettingsVersion: source.sourceSettingsVersion } : {}) }, params.signal);
  // An acknowledged receipt survives retirement; conflicts never rebase or replay a write.
  if (receipt.status === 'updated' || receipt.status === 'conflict') return receipt;
  return { status: 'unavailable' as const, reason: receipt.status };
}

/** All authoring uses the captured Account's existing row CAS, below Action admission. */
export async function createPromptInvocationInLibrary(params: Readonly<{
  port: PromptLibraryStackActionPortV1;
  request: z.infer<typeof PromptInvocationCreateInputSchema>;
  invocationId: string;
  actionTokens: readonly string[];
  signal?: AbortSignal;
}>): Promise<z.infer<typeof PromptInvocationCreateOutputSchema>> {
  const read = await readInvocationCatalog(params);
  if (read.status !== 'ready') return read;
  const validation = validatePromptInvocationTokenV1({ token: params.request.token,
    entries: read.record.value.entries, actionTokens: params.actionTokens });
  if (!validation.ok) return { status: 'invalid', reason: validation.reason };
  const entry = PromptInvocationEntryV1Schema.parse({ ...params.request, id: params.invocationId,
    token: validation.token, title: params.request.title.trim() });
  const receipt = await writeInvocationEntries(params, read, [...read.record.value.entries, entry]);
  if (receipt.status === 'updated') return { status: 'updated', invocationId: entry.id, token: entry.token, revision: receipt.revision };
  return receipt;
}

export async function updatePromptInvocationInLibrary(params: Readonly<{ port: PromptLibraryStackActionPortV1;
  request: z.infer<typeof PromptInvocationUpdateInputSchema>; actionTokens: readonly string[]; signal?: AbortSignal;
}>): Promise<z.infer<typeof PromptInvocationUpdateOutputSchema>> {
  const read = await readInvocationCatalog(params);
  if (read.status !== 'ready') return read;
  if (read.revision !== params.request.expectedRevision) return { status: 'conflict', revision: read.revision === 'absent' ? -1 : read.revision };
  const existing = read.record.value.entries.find(entry => entry.id === params.request.invocationId);
  if (!existing) return { status: 'invalid', reason: 'not_found' };
  const validation = validatePromptInvocationTokenV1({ token: params.request.token, entries: read.record.value.entries,
    excludingInvocationId: existing.id, actionTokens: params.actionTokens });
  if (!validation.ok) return { status: 'invalid', reason: validation.reason };
  const { invocationId: _id, expectedRevision: _revision, ...fields } = params.request;
  const entry = PromptInvocationEntryV1Schema.parse({ ...existing, ...fields, id: existing.id,
    token: validation.token, title: params.request.title.trim() });
  const receipt = await writeInvocationEntries(params, read, read.record.value.entries.map(value => value.id === entry.id ? entry : value));
  return receipt.status === 'updated'
    ? { status: 'updated', invocationId: entry.id, token: entry.token, revision: receipt.revision } : receipt;
}

export async function deletePromptInvocationInLibrary(params: Readonly<{ port: PromptLibraryStackActionPortV1;
  request: z.infer<typeof PromptInvocationDeleteInputSchema>; signal?: AbortSignal;
}>): Promise<z.infer<typeof PromptInvocationDeleteOutputSchema>> {
  const read = await readInvocationCatalog(params);
  if (read.status !== 'ready') return read;
  if (read.revision !== params.request.expectedRevision) return { status: 'conflict', revision: read.revision === 'absent' ? -1 : read.revision };
  const entries = read.record.value.entries.filter(entry => entry.id !== params.request.invocationId);
  if (entries.length === read.record.value.entries.length) return { status: 'invalid', reason: 'not_found' };
  const receipt = await writeInvocationEntries(params, read, entries);
  return receipt.status === 'updated'
    ? { status: 'updated', invocationId: params.request.invocationId, revision: receipt.revision } : receipt;
}

export function listPromptInvocationsInLibrary(params: Readonly<{ invocations: unknown; revision?: number | 'absent'; request: Readonly<{ limit?: number }> }>): PromptInvocationsListResult {
  const parsed = PromptInvocationsV1Schema._zod.def.innerType.safeParse(params.invocations ?? {});
  if (!parsed.success) return { items: [], coverage: 'unavailable' as const };
  const items = parsed.data.entries.map(({ id, token, title, target, behavior, allowArgs, availableIn }) =>
    ({ id, token, title, target, behavior, allowArgs, availableIn }));
  const revision = params.revision === undefined ? {} : { revision: params.revision };
  const limit = params.request.limit;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && items.length > Math.floor(limit)) {
    return { items: items.slice(0, Math.floor(limit)), coverage: 'truncated' as const, ...revision };
  }
  return { items, coverage: 'complete' as const, ...revision };
}

export async function resolvePromptInvocationInLibrary(params: Readonly<{
  invocations: unknown;
  store: PromptLibraryArtifactStore;
  readArtifact?: PromptInvocationArtifactReader;
  request: Readonly<{ invocationId: string; argsText?: string }>;
  sessionId: string | null;
  signal?: AbortSignal;
}>): Promise<PromptInvocationResolveResult> {
  params.signal?.throwIfAborted();
  const invocationId = params.request.invocationId.trim();
  const unavailable = { status: 'unavailable' as const, invocationId };
  const parsed = PromptInvocationsV1Schema._zod.def.innerType.safeParse(params.invocations ?? {});
  if (!parsed.success) return unavailable;
  const entry = parsed.data.entries.find((candidate) => candidate.id === invocationId);
  if (!entry) return { status: 'unknownInvocation' as const, invocationId };
  if (!isPromptInvocationAvailable(entry, { sessionId: params.sessionId })) return unavailable;
  // A string-only store cannot prove which Home a qualified target belongs to.
  if (entry.target.serverId && !params.readArtifact) return unavailable;
  try {
    const readArtifact = params.readArtifact;
    const store = readArtifact ? { ...params.store,
      read: (_artifactId: string, options?: Readonly<{ signal?: AbortSignal }>) => readArtifact(entry.target, options),
    } : params.store;
    const document = await readPromptDocInLibrary({ store, artifactId: entry.target.artifactId,
      ...(params.signal ? { signal: params.signal } : {}) });
    if (!document.ok) return unavailable;
    const { text } = renderPromptTemplateTextV1({ templateMarkdown: document.markdown,
      argsText: entry.allowArgs ? params.request.argsText ?? '' : '' });
    if (!text.trim()) return unavailable;
    return { status: 'resolved' as const, invocationId, token: entry.token, title: entry.title, behavior: entry.behavior, text };
  } catch {
    params.signal?.throwIfAborted();
    return unavailable;
  }
}
