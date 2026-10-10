import { listPromptInvocationsInLibrary, resolvePromptInvocationInLibrary, type PromptInvocationArtifactReader } from '@happier-dev/protocol/prompts/library/promptInvocationActionOperations';
import type { PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getPromptLibraryCatalogValue } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { withUiPromptLibraryArtifactReader, withUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';

export type PromptInvocationsListItem = ReturnType<typeof listPromptInvocationsInLibrary>['items'][number];
export type PromptInvocationResolveResult = Awaited<ReturnType<typeof resolvePromptInvocationInLibrary>>;

export type PromptInvocationActionSource = Readonly<{ invocations: unknown; store?: PromptLibraryArtifactStore;
  readArtifact?: PromptInvocationArtifactReader; assertCurrent?: () => void }>;

function admittedInvocations(): PromptInvocationActionSource {
  const lifetime = captureActiveServerAccountScopeLifetime();
  const catalog = getPromptLibraryCatalogValue(lifetime?.scope ?? null, 'invocations');
  return { invocations: catalog.status === 'ready' && !catalog.stale ? catalog.value : undefined,
    assertCurrent: () => { if (!lifetime?.isCurrent()) throw new Error('action_account_scope_changed'); } };
}

function isSourceCurrent(source: PromptInvocationActionSource): boolean {
  try { source.assertCurrent?.(); return true; }
  catch { return false; }
}

export function listPromptInvocationsForActions(args: Readonly<{ limit?: number }>, source?: PromptInvocationActionSource) {
  const captured = source ?? admittedInvocations();
  const invocations = captured.invocations;
  if (!isSourceCurrent(captured) || invocations === undefined || invocations === null) return { items: [], coverage: 'unavailable' as const };
  return listPromptInvocationsInLibrary({ invocations, request: args });
}

export async function resolvePromptInvocationForActions(args: Readonly<{
  invocationId: string; argsText?: string; sessionId?: string | null; signal?: AbortSignal;
}>, source?: PromptInvocationActionSource): Promise<PromptInvocationResolveResult> {
  args.signal?.throwIfAborted();
  const captured = source ?? admittedInvocations();
  const invocations = captured.invocations;
  const unavailable = { status: 'unavailable' as const, invocationId: args.invocationId.trim() };
  if (!isSourceCurrent(captured) || invocations === undefined || invocations === null) return unavailable;
  // The canonical resolver can reject an unreadable or absent selection without
  // reading Account content. Capture the qualified transport only when it reads.
  const resolve = (readArtifact: PromptInvocationArtifactReader) => resolvePromptInvocationInLibrary({ invocations, readArtifact,
    store: captured.store ?? {
      read: (artifactId, options) => withUiPromptLibraryArtifactStore((store) => store.read(artifactId, options), { signal: options?.signal }),
      update: (input) => withUiPromptLibraryArtifactStore((store) => store.update(input), { signal: input.signal }),
    }, request: args, sessionId: args.sessionId ?? null,
    ...(args.signal ? { signal: args.signal } : {}) });
  try {
    const result = captured.readArtifact ? await resolve(captured.readArtifact)
      : await withUiPromptLibraryArtifactReader((reader) => resolve((ref, options) =>
        !ref.serverId && captured.store ? captured.store.read(ref.artifactId, options) : reader.readArtifact(ref)), { signal: args.signal });
    args.signal?.throwIfAborted();
    return isSourceCurrent(captured) ? result : unavailable;
  } catch (error) {
    args.signal?.throwIfAborted();
    if (!isSourceCurrent(captured)) return unavailable;
    throw error;
  }
}
