import { createCodexAppServerClient, type DisposableCodexAppServerClient } from './client/createCodexAppServerClient';

type CodexAppServerThreadResponse = Readonly<{
  threadId?: unknown;
  id?: unknown;
  thread?: Readonly<{ id?: unknown; threadId?: unknown }> | null;
}>;

function readThreadId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as CodexAppServerThreadResponse;
  const candidates = [response.threadId, response.id, response.thread?.threadId, response.thread?.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

export type CodexAppServerNativeForkDeps = Readonly<{
  createClient?: typeof createCodexAppServerClient;
}>;

export async function forkCodexAppServerConversationNative(
  params: Readonly<{
    directory: string;
    parentCodexSessionId: string;
    processEnv?: NodeJS.ProcessEnv;
  }>,
  deps: CodexAppServerNativeForkDeps = {},
): Promise<{ vendorSessionId: string } | null> {
  const parentCodexSessionId = typeof params.parentCodexSessionId === 'string'
    ? params.parentCodexSessionId.trim()
    : '';
  if (!parentCodexSessionId) return null;

  const createClient = deps.createClient ?? createCodexAppServerClient;
  let client: DisposableCodexAppServerClient | null = null;

  try {
    client = await createClient({ cwd: params.directory, processEnv: params.processEnv });
    for (const method of ['thread/fork', 'conversation/fork'] as const) {
      const response = await client.request(method, {
        threadId: parentCodexSessionId,
        persistExtendedHistory: true,
      }).catch(() => null);
      const vendorSessionId = readThreadId(response);
      if (vendorSessionId) {
        return { vendorSessionId };
      }
    }
    return null;
  } finally {
    await client?.dispose().catch(() => {});
  }
}
