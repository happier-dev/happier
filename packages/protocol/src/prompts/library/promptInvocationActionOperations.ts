import { isPromptInvocationAvailable, PromptInvocationsV1Schema, type PromptInvocationEntryV1 } from './promptInvocationsV1.js';
import { readPromptDocInLibrary, type PromptLibraryArtifactStore } from './promptLibraryActionOperations.js';
import { renderPromptTemplateTextV1 } from './renderPromptTemplateTextV1.js';

export type PromptInvocationsListItem = Readonly<Pick<PromptInvocationEntryV1, 'id' | 'token' | 'title' | 'behavior' | 'allowArgs' | 'availableIn'>>;
export type PromptInvocationsListResult = Readonly<{ items: readonly PromptInvocationsListItem[]; coverage: 'complete' | 'truncated' | 'unavailable' }>;
export type PromptInvocationResolveResult =
  | Readonly<{ status: 'resolved'; invocationId: string; token: string; title: string; behavior: PromptInvocationEntryV1['behavior']; text: string }>
  | Readonly<{ status: 'unknownInvocation' | 'unavailable'; invocationId: string }>;

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
  try {
    const document = await readPromptDocInLibrary({ store: params.store, artifactId: entry.target.artifactId,
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
