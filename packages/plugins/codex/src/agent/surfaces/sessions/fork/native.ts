import { readThreadId } from '../../../runtime/appServer/wire/fields.js';

export const CODEX_APP_SERVER_NATIVE_FORK_METHODS = ['thread/fork', 'conversation/fork'] as const;

export type CodexAppServerNativeForkMethod = typeof CODEX_APP_SERVER_NATIVE_FORK_METHODS[number];

export type CodexAppServerNativeForkClient = Readonly<{
  request(
    method: CodexAppServerNativeForkMethod,
    params: Readonly<{
      threadId: string;
      persistExtendedHistory: true;
    }>,
  ): Promise<unknown>;
}>;

export type CodexAppServerNativeForkEvent =
  | Readonly<{ type: 'methodAttempt'; method: CodexAppServerNativeForkMethod }>
  | Readonly<{ type: 'methodFailed'; method: CodexAppServerNativeForkMethod; error: unknown }>
  | Readonly<{ type: 'methodReturnedNoThreadId'; method: CodexAppServerNativeForkMethod; response: unknown }>
  | Readonly<{ type: 'methodSucceeded'; method: CodexAppServerNativeForkMethod; providerSessionId: string }>
  | Readonly<{ type: 'methodsExhausted' }>;

export type CodexAppServerNativeForkResult = Readonly<{
  providerSessionId: string;
}>;

export async function forkCodexNativeAppServerConversation(params: Readonly<{
  client: CodexAppServerNativeForkClient;
  parentCodexSessionId: string;
  onEvent?: (event: CodexAppServerNativeForkEvent) => void;
}>): Promise<CodexAppServerNativeForkResult | null> {
  const parentCodexSessionId = typeof params.parentCodexSessionId === 'string'
    ? params.parentCodexSessionId.trim()
    : '';
  if (!parentCodexSessionId) return null;

  for (const method of CODEX_APP_SERVER_NATIVE_FORK_METHODS) {
    params.onEvent?.({ type: 'methodAttempt', method });
    let response: unknown;
    try {
      response = await params.client.request(method, {
        threadId: parentCodexSessionId,
        persistExtendedHistory: true,
      });
    } catch (error) {
      params.onEvent?.({ type: 'methodFailed', method, error });
      continue;
    }

    const providerSessionId = readThreadId(response);
    if (providerSessionId) {
      params.onEvent?.({ type: 'methodSucceeded', method, providerSessionId });
      return { providerSessionId };
    }
    params.onEvent?.({ type: 'methodReturnedNoThreadId', method, response });
  }

  params.onEvent?.({ type: 'methodsExhausted' });
  return null;
}
