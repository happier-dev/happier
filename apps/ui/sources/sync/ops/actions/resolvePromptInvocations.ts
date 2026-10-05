import { listPromptInvocationsInLibrary, resolvePromptInvocationInLibrary } from '@happier-dev/protocol';
import { storage } from '@/sync/domains/state/storage';
import { uiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';

export type PromptInvocationsListItem = ReturnType<typeof listPromptInvocationsInLibrary>['items'][number];
export type PromptInvocationResolveResult = Awaited<ReturnType<typeof resolvePromptInvocationInLibrary>>;

export function listPromptInvocationsForActions(args: Readonly<{ limit?: number }>) {
  return listPromptInvocationsInLibrary({ invocations: storage.getState()?.settings?.promptInvocationsV1, request: args });
}

export function resolvePromptInvocationForActions(args: Readonly<{
  invocationId: string; argsText?: string; sessionId?: string | null; signal?: AbortSignal;
}>): Promise<PromptInvocationResolveResult> {
  return resolvePromptInvocationInLibrary({ invocations: storage.getState()?.settings?.promptInvocationsV1,
    store: uiPromptLibraryArtifactStore, request: args, sessionId: args.sessionId ?? null,
    ...(args.signal ? { signal: args.signal } : {}) });
}
