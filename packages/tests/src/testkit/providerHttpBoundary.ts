import type {
  HttpMethod,
  HttpService,
  PluginFetchCredentialBinding,
} from '@happier-dev/plugin-sdk/http';

/**
 * A deterministic HTTP boundary for provider adapters.
 *
 * This deliberately stops at the SDK `HttpService` boundary: provider parsing,
 * retry classification, checkpoint decisions, and delivery custody remain in
 * the provider/core owner under test. The script only supplies external
 * success/failure/cancellation observations and records the request bytes.
 */
export type ProviderHttpRequest = Readonly<{
  url: string;
  method?: HttpMethod;
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  credentialBinding?: PluginFetchCredentialBinding;
  redirect: 'error' | 'follow' | 'manual';
  timeoutMs?: number;
}>;

export type ProviderHttpResponse = Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

export type ProviderHttpStep =
  | Readonly<{
      kind?: 'response';
      response: ProviderHttpResponse;
      assertRequest?: (request: ProviderHttpRequest) => void;
    }>
  | Readonly<{
      kind: 'error';
      error: unknown;
      assertRequest?: (request: ProviderHttpRequest) => void;
    }>
  | Readonly<{
      kind: 'abort';
      assertRequest?: (request: ProviderHttpRequest) => void;
    }>;

export type ProviderHttpBoundary = Readonly<{
  http: Pick<HttpService, 'request'>;
  readonly requests: readonly ProviderHttpRequest[];
  readonly consumedStepCount: number;
  remainingStepCount(): number;
}>;

export function jsonProviderHttpResponse(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = { 'content-type': 'application/json' },
): ProviderHttpResponse {
  return {
    status,
    finalUrl: 'https://provider.invalid/',
    headers,
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function cloneRequest(input: ProviderHttpRequest): ProviderHttpRequest {
  return {
    ...input,
    ...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
    ...(input.body === undefined ? {} : { body: input.body.slice() }),
    ...(input.credentialBinding === undefined
      ? {}
      : {
          credentialBinding: {
            ...input.credentialBinding,
            provider: { ...input.credentialBinding.provider },
            parameters: { ...input.credentialBinding.parameters },
          },
        }),
  };
}

function abortError(): Error {
  return new DOMException('The provider HTTP request was aborted.', 'AbortError');
}

/**
 * Creates one ordered provider-boundary script. A missing step is an explicit
 * test failure, preventing a provider from silently making an unrecorded
 * network call. `abort` models cancellation before an external response is
 * observed; it does not decide provider retry semantics.
 */
export function createProviderHttpBoundary(
  steps: readonly ProviderHttpStep[],
): ProviderHttpBoundary {
  let nextStep = 0;
  const requests: ProviderHttpRequest[] = [];

  const http: Pick<HttpService, 'request'> = {
    async request(input, options) {
      const request = cloneRequest(input);
      requests.push(request);

      const step = steps[nextStep];
      nextStep += 1;
      if (step === undefined) {
        throw new Error(`provider_http_script_exhausted:${request.method ?? 'GET'}:${request.url}`);
      }
      step.assertRequest?.(request);

      if (options?.signal?.aborted) {
        throw abortError();
      }
      if (step.kind === 'abort') {
        throw abortError();
      }
      if (step.kind === 'error') {
        throw step.error;
      }
      return {
        ...step.response,
        headers: { ...step.response.headers },
        body: step.response.body.slice(),
      };
    },
  };

  return {
    http,
    get requests() {
      return requests.map(cloneRequest);
    },
    get consumedStepCount() {
      return nextStep;
    },
    remainingStepCount: () => Math.max(0, steps.length - nextStep),
  };
}
