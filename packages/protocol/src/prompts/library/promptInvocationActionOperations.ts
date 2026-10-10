import { isPromptInvocationAvailable, PromptInvocationEntryV1Schema, PromptInvocationsV1Schema, validatePromptInvocationTokenV1, type PromptInvocationEntryV1 } from './promptInvocationsV1.js';
import { readPromptLibraryCatalogRecordV1, type PromptLibraryStackActionPortV1 } from './promptLibraryCatalogV1.js';
import type { z } from 'zod';
import type { PromptInvocationCreateInputSchema, PromptInvocationCreateOutputSchema } from '../../actions/promptInvocationCreateActionSpecs.js';
import { readPromptDocInLibrary, type PromptLibraryArtifactStore, type PromptLibraryStoredArtifact } from './promptLibraryActionOperations.js';
import type { PromptDocArtifactRefV1 } from './promptArtifactRefsV1.js';
import { renderPromptTemplateTextV1 } from './renderPromptTemplateTextV1.js';

export type PromptInvocationsListItem = Readonly<Pick<PromptInvocationEntryV1, 'id' | 'token' | 'title' | 'behavior' | 'allowArgs' | 'availableIn'>>;
export type PromptInvocationsListResult = Readonly<{ items: readonly PromptInvocationsListItem[]; coverage: 'complete' | 'truncated' | 'unavailable' }>;
export type PromptInvocationResolveResult =
  | Readonly<{ status: 'resolved'; invocationId: string; token: string; title: string; behavior: PromptInvocationEntryV1['behavior']; text: string }>
  | Readonly<{ status: 'unknownInvocation' | 'unavailable'; invocationId: string }>;
export type PromptInvocationArtifactReader = (ref: PromptDocArtifactRefV1, options?: Readonly<{ signal?: AbortSignal }>) => Promise<PromptLibraryStoredArtifact | null>;

/** Append through the catalog's existing captured-Account row CAS; never author the retired settings carrier. */
export async function createPromptInvocationInLibrary(params: Readonly<{
  port: PromptLibraryStackActionPortV1;
  request: z.infer<typeof PromptInvocationCreateInputSchema>;
  invocationId: string;
  actionTokens: readonly string[];
  signal?: AbortSignal;
}>): Promise<z.infer<typeof PromptInvocationCreateOutputSchema>> {
  const assertCurrent = () => { params.signal?.throwIfAborted(); params.port.assertCurrent(); };
  assertCurrent();
  const projection = await params.port.readCatalog(params.signal);
  assertCurrent();
  const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'invocations' });
  if (read.status !== 'ready') return read;
  if (read.record.key !== 'invocations') return { status: 'unavailable', reason: 'invalid-stored-content' };
  if (read.authority === 'inactive' && projection.sourceSettingsVersion === undefined) {
    return { status: 'unavailable', reason: 'source-currentness-unavailable' };
  }
  const validation = validatePromptInvocationTokenV1({ token: params.request.token,
    entries: read.record.value.entries, actionTokens: params.actionTokens });
  if (!validation.ok) return { status: 'invalid', reason: validation.reason };
  const entry = PromptInvocationEntryV1Schema.parse({ ...params.request, id: params.invocationId,
    token: validation.token, title: params.request.title.trim() });
  assertCurrent();
  const receipt = await params.port.writeRecord({ record: { key: 'invocations',
    value: { ...read.record.value, entries: [...read.record.value.entries, entry] } }, expectedRevision: read.revision,
    ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}),
  }, params.signal);
  // An acknowledged receipt is not erased by post-write retirement or replayed after a conflict.
  if (receipt.status === 'updated') return { status: 'updated', invocationId: entry.id, token: entry.token, revision: receipt.revision };
  if (receipt.status === 'conflict') return { status: 'conflict', revision: receipt.revision };
  return { status: 'unavailable', reason: receipt.status };
}

export function listPromptInvocationsInLibrary(params: Readonly<{ invocations: unknown; request: Readonly<{ limit?: number }> }>): PromptInvocationsListResult {
  const parsed = PromptInvocationsV1Schema.removeCatch().safeParse(params.invocations ?? {});
  if (!parsed.success) return { items: [], coverage: 'unavailable' as const };
  const items = parsed.data.entries.map(({ id, token, title, behavior, allowArgs, availableIn }) =>
    ({ id, token, title, behavior, allowArgs, availableIn }));
  const limit = params.request.limit;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && items.length > Math.floor(limit)) {
    return { items: items.slice(0, Math.floor(limit)), coverage: 'truncated' as const };
  }
  return { items, coverage: 'complete' as const };
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
  const parsed = PromptInvocationsV1Schema.removeCatch().safeParse(params.invocations ?? {});
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
