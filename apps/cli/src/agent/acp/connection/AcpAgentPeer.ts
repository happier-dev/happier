import {
  methods,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientContext,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import {
  redactBugReportSensitiveText,
  trimBugReportTextToMaxBytes,
} from '@happier-dev/protocol';

import type { AcpClientConnectionOptions } from './types';
import { classifyProviderLimitEvidence, parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';

const ACP_ERROR_DIAGNOSTIC_MAX_BYTES = 16_384;

function cloneErrorWithSanitizedData(
  error: Error,
  data: Record<string, unknown>,
): Error & { data: Record<string, unknown> } {
  const descriptors = Object.getOwnPropertyDescriptors(error);
  delete descriptors.data;
  delete descriptors.authenticationSetupFailure;
  const clone = Object.create(Object.getPrototypeOf(error)) as Error & { data: Record<string, unknown> };
  Object.defineProperties(clone, descriptors);
  Object.defineProperty(clone, 'data', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: data,
  });
  return clone;
}

export class AcpAgentPeer {
  constructor(
    private readonly context: ClientContext,
    private readonly connectionSignal: AbortSignal,
    private readonly isAuthenticationSetupFailure?: AcpClientConnectionOptions['isAuthenticationSetupFailure'],
  ) {}

  private assertActive(): void {
    if (this.connectionSignal.aborted) {
      throw new Error('ACP connection is closed');
    }
  }

  private async requestWithDiagnostics<Response>(request: () => Promise<Response>): Promise<Response> {
    try {
      return await request();
    } catch (error) {
      let failure = error;
      if (error instanceof Error) {
        const data = (error as Error & { data?: unknown }).data;
        const dataRecord = data && typeof data === 'object' && !Array.isArray(data)
          ? data as Record<string, unknown>
          : null;
        const authenticationSetupFailure = this.isAuthenticationSetupFailure?.({
          code: 'code' in error ? error.code : undefined,
          data,
        }) === true;
        const details = dataRecord
          ? dataRecord.details
          : undefined;
        const rawDetails = typeof details === 'string'
          ? details.trim().slice(0, ACP_ERROR_DIAGNOSTIC_MAX_BYTES)
          : '';
        const sanitizedDetails = rawDetails
          ? trimBugReportTextToMaxBytes(
            redactBugReportSensitiveText(rawDetails),
            ACP_ERROR_DIAGNOSTIC_MAX_BYTES,
          ).trim()
          : '';
        const limitCategory = classifyProviderLimitEvidence([error, dataRecord]);
        const sanitizedData = {
          ...(sanitizedDetails ? { details: sanitizedDetails } : {}),
          ...(limitCategory === 'usage_limit' || limitCategory === 'rate_limit' ? {
            limitCategory,
            ...parseProviderResetAt({ body: dataRecord, headers: dataRecord?.headers, nowMs: Date.now() }),
          } : {}),
        };
        let safeError = error as Error & { data?: unknown };
        if (dataRecord) {
          // JSON-RPC error data is provider-controlled. Happier consumes only the
          // bounded diagnostic and normalized limit evidence; arbitrary sibling fields would
          // surface unbounded payloads and secrets through callers/loggers.
          try {
            safeError.data = sanitizedData;
          } catch {
            safeError = cloneErrorWithSanitizedData(error, sanitizedData);
          }
        }
        const messageWithDetails = rawDetails && !error.message.includes(rawDetails)
          ? `${error.message}: ${rawDetails}`
          : error.message;
        safeError.message = trimBugReportTextToMaxBytes(
          redactBugReportSensitiveText(messageWithDetails),
          ACP_ERROR_DIAGNOSTIC_MAX_BYTES,
        ).trim() || 'ACP request failed';
        if (typeof safeError.stack === 'string') {
          safeError.stack = trimBugReportTextToMaxBytes(
            redactBugReportSensitiveText(safeError.stack),
            ACP_ERROR_DIAGNOSTIC_MAX_BYTES,
          );
        }
        if (authenticationSetupFailure) {
          if (!Object.isExtensible(safeError)
            || Object.getOwnPropertyDescriptor(safeError, 'authenticationSetupFailure')?.configurable === false) {
            safeError = cloneErrorWithSanitizedData(safeError, sanitizedData);
          }
          Object.defineProperty(safeError, 'authenticationSetupFailure', {
            configurable: true,
            value: true,
          });
        }
        failure = safeError;
      }
      throw failure;
    }
  }

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(() => this.context.request(methods.agent.initialize, params));
  }

  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(() => this.context.request(methods.agent.authenticate, params));
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(() => this.context.request(methods.agent.session.new, params));
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(
      () => this.context.request(methods.agent.session.load, params),
    ).then((response) => response ?? {});
  }

  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(() => this.context.request(methods.agent.session.list, params));
  }

  deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(
      () => this.context.request(methods.agent.session.delete, params),
    ).then((response) => response ?? {});
  }

  closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(
      () => this.context.request(methods.agent.session.close, params),
    ).then((response) => response ?? {});
  }

  forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(() => this.context.request(methods.agent.session.fork, params));
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(() => this.context.request(methods.agent.session.prompt, params));
  }

  setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(() => this.context.request(methods.agent.session.setMode, params));
  }

  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    this.assertActive();
    return this.requestWithDiagnostics(
      () => this.context.request(methods.agent.session.setConfigOption, params),
    );
  }

  setSessionModelLegacy(params: Readonly<{
    sessionId: string;
    modelId: string;
    _meta?: Readonly<Record<string, unknown>>;
  }>): Promise<unknown> {
    return this.requestExtension('session/set_model', params);
  }

  cancel(params: CancelNotification): Promise<void> {
    this.assertActive();
    return this.context.notify(methods.agent.session.cancel, params);
  }

  async requestExtension<Response = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<Response> {
    this.assertActive();
    const timeoutMs = typeof options?.timeoutMs === 'number'
      && Number.isFinite(options.timeoutMs)
      && options.timeoutMs > 0
      ? Math.trunc(options.timeoutMs)
      : null;
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = null;

    const abortFromCaller = (): void => {
      if (!controller.signal.aborted) {
        const error = new Error('ACP extension request was aborted');
        error.name = 'AbortError';
        controller.abort(error);
      }
    };
    options?.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (options?.signal?.aborted) {
      abortFromCaller();
    }

    let timeoutError: Error | null = null;
    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        timeoutError = new Error(`ACP extension request timed out after ${timeoutMs}ms`);
        if (!controller.signal.aborted) {
          controller.abort(timeoutError);
        }
      }, timeoutMs);
      timeout.unref?.();
    }

    const request = this.requestWithDiagnostics(() => this.context.request<Response, Params>(
      method,
      params,
      { cancellationSignal: controller.signal },
    ));
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAborted = (): void => {
        const reason = timeoutError ?? controller.signal.reason;
        if (reason instanceof Error) {
          reject(reason);
          return;
        }
        const error = new Error('ACP extension request was aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (controller.signal.aborted) {
        rejectAborted();
        return;
      }
      controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });

    return await Promise.race([request, aborted]).finally(() => {
      if (timeout) clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', abortFromCaller);
    });
  }

}
