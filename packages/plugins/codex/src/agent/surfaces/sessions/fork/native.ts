import { readThreadId } from '../../../runtime/appServer/wire/fields.js';
import { isCodexAppServerApplicationRejectionForMethod } from '../../../runtime/appServer/compatibility.js';

export const CODEX_APP_SERVER_NATIVE_FORK_METHODS = ['thread/fork', 'conversation/fork'] as const;

export type CodexAppServerNativeForkMethod = typeof CODEX_APP_SERVER_NATIVE_FORK_METHODS[number];

export type CodexAppServerNativeForkClient = Readonly<{
  request(
    method: CodexAppServerNativeForkMethod,
    params: Readonly<{
      threadId: string;
      persistExtendedHistory: true;
    }>,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number | null }>,
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

export type CodexAppServerNativeForkOutcome =
  | Readonly<{ kind: 'succeeded'; result: CodexAppServerNativeForkResult }>
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'failed_before_dispatch'; cause: unknown }>
  | Readonly<{ kind: 'indeterminate_after_dispatch'; cause: unknown }>;

type CodexAppServerNativeForkFailureOutcome = Extract<
  CodexAppServerNativeForkOutcome,
  { kind: 'failed_before_dispatch' | 'indeterminate_after_dispatch' }
>;

export class CodexAppServerNativeForkFailure extends Error {
  readonly outcome: CodexAppServerNativeForkFailureOutcome['kind'];

  constructor(outcome: CodexAppServerNativeForkFailureOutcome) {
    super(
      outcome.kind === 'failed_before_dispatch'
        ? 'Codex native fork failed before dispatch.'
        : 'Codex native fork outcome is unknown. Check the existing child session before retrying.',
      { cause: outcome.cause },
    );
    this.name = 'CodexAppServerNativeForkFailure';
    this.outcome = outcome.kind;
  }
}

const NATIVE_FORK_REQUEST_OPTIONS = Object.freeze({ timeoutMs: null });

function isDefinitiveNativeForkMethodUnsupported(
  error: unknown,
  method: CodexAppServerNativeForkMethod,
): boolean {
  return isCodexAppServerApplicationRejectionForMethod(error, method)
    && (error as Readonly<{ code?: unknown }>).code === -32601;
}

async function attemptCodexNativeAppServerConversationFork(params: Readonly<{
  client: CodexAppServerNativeForkClient;
  parentCodexSessionId: string;
  signal?: AbortSignal;
  onEvent?: (event: CodexAppServerNativeForkEvent) => void;
}>): Promise<CodexAppServerNativeForkOutcome> {
  const parentCodexSessionId = typeof params.parentCodexSessionId === 'string'
    ? params.parentCodexSessionId.trim()
    : '';
  if (!parentCodexSessionId) {
    return {
      kind: 'failed_before_dispatch',
      cause: new Error('Codex native fork requires a parent thread id.'),
    };
  }

  params.signal?.throwIfAborted();

  for (const method of CODEX_APP_SERVER_NATIVE_FORK_METHODS) {
    params.onEvent?.({ type: 'methodAttempt', method });
    let response: unknown;
    try {
      response = await params.client.request(method, {
        threadId: parentCodexSessionId,
        persistExtendedHistory: true,
      }, {
        ...NATIVE_FORK_REQUEST_OPTIONS,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      if (
        params.signal?.aborted === true
        && error instanceof Error
        && error.name === 'AbortError'
      ) {
        throw error;
      }
      if (isDefinitiveNativeForkMethodUnsupported(error, method)) {
        params.onEvent?.({ type: 'methodFailed', method, error });
        continue;
      }
      params.onEvent?.({ type: 'methodFailed', method, error });
      return { kind: 'indeterminate_after_dispatch', cause: error };
    }

    const providerSessionId = readThreadId(response);
    if (providerSessionId) {
      const result = { providerSessionId };
      params.onEvent?.({ type: 'methodSucceeded', method, providerSessionId });
      return { kind: 'succeeded', result };
    }
    params.onEvent?.({ type: 'methodReturnedNoThreadId', method, response });
    return {
      kind: 'indeterminate_after_dispatch',
      cause: new Error(`Codex native fork '${method}' returned no child thread id.`),
    };
  }

  params.onEvent?.({ type: 'methodsExhausted' });
  return { kind: 'unsupported' };
}

export async function forkCodexNativeAppServerConversation(params: Readonly<{
  client: CodexAppServerNativeForkClient;
  parentCodexSessionId: string;
  signal?: AbortSignal;
  onEvent?: (event: CodexAppServerNativeForkEvent) => void;
}>): Promise<CodexAppServerNativeForkResult | null> {
  const outcome = await attemptCodexNativeAppServerConversationFork(params);
  if (outcome.kind === 'succeeded') return outcome.result;
  if (outcome.kind === 'unsupported') return null;
  throw new CodexAppServerNativeForkFailure(outcome);
}
