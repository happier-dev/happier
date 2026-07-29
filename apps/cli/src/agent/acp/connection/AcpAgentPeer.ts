import {
  methods,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientContext,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
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

const ACP_ERROR_DIAGNOSTIC_MAX_BYTES = 16_384;

function cloneErrorWithSanitizedData(
  error: Error,
  data: Record<string, unknown>,
): Error & { data: Record<string, unknown> } {
  const descriptors = Object.getOwnPropertyDescriptors(error);
  delete descriptors.data;
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
  ) {}

  private assertActive(): void {
    if (this.connectionSignal.aborted) throw new Error('ACP connection is closed');
  }

  private async requestWithDiagnostics<Response>(request: () => Promise<Response>): Promise<Response> {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof Error)) throw error;

      const data = (error as Error & { data?: unknown }).data;
      const dataRecord = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : null;
      const rawDetails = typeof dataRecord?.details === 'string'
        ? dataRecord.details.trim().slice(0, ACP_ERROR_DIAGNOSTIC_MAX_BYTES)
        : '';
      const sanitizedDetails = rawDetails
        ? trimBugReportTextToMaxBytes(
          redactBugReportSensitiveText(rawDetails),
          ACP_ERROR_DIAGNOSTIC_MAX_BYTES,
        ).trim()
        : '';

      let safeError = error as Error & { data?: unknown };
      if (dataRecord) {
        const sanitizedData = sanitizedDetails ? { details: sanitizedDetails } : {};
        try {
          safeError.data = sanitizedData;
        } catch {
          safeError = cloneErrorWithSanitizedData(error, sanitizedData);
        }
      }
      const messageWithDetails = sanitizedDetails && !error.message.includes(sanitizedDetails)
        ? `${error.message}: ${sanitizedDetails}`
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
      throw safeError;
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

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertActive();
    return await this.requestWithDiagnostics(
      () => this.context.request(methods.agent.session.load, params),
    ) ?? {};
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
    const controller = new AbortController();
    const timeoutMs = typeof options?.timeoutMs === 'number'
      && Number.isFinite(options.timeoutMs)
      && options.timeoutMs > 0
      ? Math.trunc(options.timeoutMs)
      : null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const abortFromCaller = (): void => {
      if (controller.signal.aborted) return;
      const error = new Error('ACP extension request was aborted');
      error.name = 'AbortError';
      controller.abort(error);
    };
    options?.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (options?.signal?.aborted) abortFromCaller();

    let timeoutError: Error | null = null;
    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        timeoutError = new Error(`ACP extension request timed out after ${timeoutMs}ms`);
        if (!controller.signal.aborted) controller.abort(timeoutError);
      }, timeoutMs);
    }

    const request = this.requestWithDiagnostics(() => this.context.request<Response, Params>(
      method,
      params,
      { cancellationSignal: controller.signal },
    ));
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAborted = (): void => {
        const reason = timeoutError ?? controller.signal.reason;
        if (reason instanceof Error) reject(reason);
        else {
          const error = new Error('ACP extension request was aborted');
          error.name = 'AbortError';
          reject(error);
        }
      };
      if (controller.signal.aborted) rejectAborted();
      else controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });

    return await Promise.race([request, aborted]).finally(() => {
      if (timeout) clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', abortFromCaller);
    });
  }
}
