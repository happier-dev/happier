import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosRequestTransformer, type AxiosResponse } from 'axios';
import { assertCredentialRequestRedirectAllowed, CREDENTIAL_REQUEST_REDIRECT_POLICY, CredentialRequestRedirectError,
  resolveCredentialRequestRedirect } from '@happier-dev/cli-common/homeTarget';
import { createHttpStatusError, isAuthenticationStatus, readHttpStatus } from './httpStatusError';
import { readSignedHomeAuthorizationHttpError } from './homeAuthorizationHttpFailure';
import { encodeExternalActionHttpBodyV1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_HTTP_BODY_HEADER_V1, EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1,
  EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 } from '@happier-dev/protocol/actions/externalActionHttpTransportV1';

const privateActionProofHeaders = new Set(EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1);

function carriesExecutionAuthorization(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function scopeRequest(client: AxiosInstance, config: AxiosRequestConfig | undefined) {
  let executionProof: 'header' | 'body' | false | undefined;
  let requestUrl: string | undefined;
  let method = config?.method ?? client.defaults.method ?? 'GET';
  let hasSecretBody = config?.data != null;
  const beforeRedirect = config?.beforeRedirect ?? client.defaults.beforeRedirect;
  const transforms = config?.transformRequest ?? client.defaults.transformRequest;
  const frameAuthorization: AxiosRequestTransformer = function (data, headers) {
    const logicalMethod = (this.method ?? 'get').toLowerCase();
    executionProof = carriesExecutionAuthorization(headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)) ? 'header' : false;
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(logicalMethod)) return data;
    const frame = encodeExternalActionHttpBodyV1(Object.fromEntries(
      EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1.map(header => [header, headers.get(header)])), data);
    if (frame === null) return data;
    if (executionProof) executionProof = 'body';
    for (const header of EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1) headers.delete(header);
    if (logicalMethod === 'get') {
      // Signing has already bound the logical GET. POST carries its proofs through ordinary HTTP parsers.
      this.method = 'post';
      method = 'POST';
    }
    headers.set(EXTERNAL_ACTION_HTTP_BODY_HEADER_V1, logicalMethod === 'get' ? EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 : 'v1');
    headers.setContentType('application/json', true);
    hasSecretBody = true;
    return frame;
  };
  const scopedConfig: AxiosRequestConfig = {
    ...config,
    transformRequest: [frameAuthorization, ...(Array.isArray(transforms) ? transforms : transforms ? [transforms] : [])],
    maxRedirects: Math.min(config?.maxRedirects ?? client.defaults.maxRedirects ?? CREDENTIAL_REQUEST_REDIRECT_POLICY.maxRedirects,
      CREDENTIAL_REQUEST_REDIRECT_POLICY.maxRedirects),
    fetchOptions: { ...config?.fetchOptions, redirect: CREDENTIAL_REQUEST_REDIRECT_POLICY.redirect },
    beforeRedirect(options, response) {
      beforeRedirect?.(options, response);
      // Axios owns this untyped native-options boundary; normalize its headers immediately.
      const rawHeaders: unknown = options.headers;
      const headers = typeof rawHeaders === 'object' && rawHeaders !== null
        ? Object.fromEntries(Object.entries(rawHeaders).map(([name, value]) => [name, String(value)])) : {};
      const next = resolveCredentialRequestRedirect({ requestUrl: requestUrl ?? client.getUri(config), status: response.statusCode,
        location: response.headers.location ?? null, method, headers, hasSecretBody,
        privateCredentialHeaderNames: privateActionProofHeaders });
      if (!next) return;
      options.headers = next.headers;
      if (next.crossOrigin) options.auth = undefined;
      requestUrl = next.url;
      method = next.method;
      hasSecretBody &&= !next.dropBody;
      if (next.crossOrigin || (next.dropBody && executionProof === 'body')) executionProof = false;
    },
  };
  return {
    config: scopedConfig,
    settle: (response: Promise<AxiosResponse<unknown>>) => settle(response, () => {
      const signed = executionProof === undefined
        ? Object.entries(config?.headers ?? {}).some(([name, value]) =>
          name.toLowerCase() === EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER && carriesExecutionAuthorization(value))
        : executionProof !== false;
      return signed ? requestUrl ?? client.getUri(config) : undefined;
    }),
  };
}

function assertCredentialResponseAllowed(status: number, payload: unknown, readSignedRequestUrl: () => string | undefined): void {
  assertCredentialRequestRedirectAllowed(status);
  if (status === 431) throw createHttpStatusError(status, 'request_headers_too_large', 'request_headers_too_large');
  if (isAuthenticationStatus(status)) {
    const signedRequestUrl = readSignedRequestUrl();
    if (signedRequestUrl !== undefined) {
      const refusal = readSignedHomeAuthorizationHttpError(status, payload, signedRequestUrl);
      if (refusal) throw refusal;
    }
  }
}

async function settle(response: Promise<AxiosResponse<unknown>>, readSignedRequestUrl: () => string | undefined): Promise<AxiosResponse<unknown>> {
  let result: AxiosResponse<unknown>;
  try {
    result = await response;
  } catch (error) {
    // follow-redirects/Axios wrap hook failures; expose only the closed policy error.
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      if (cause instanceof CredentialRequestRedirectError) throw cause;
    }
    // Both Axios validateStatus branches must produce the same secret-free error.
    const status = readHttpStatus(error);
    if (status !== null) {
      const response = typeof error === 'object' && error !== null && 'response' in error ? error.response : undefined;
      const data = typeof response === 'object' && response !== null && 'data' in response ? response.data : undefined;
      assertCredentialResponseAllowed(status, data, readSignedRequestUrl);
    }
    throw error;
  }
  assertCredentialResponseAllowed(result.status, result.data, readSignedRequestUrl);
  return result;
}

const bodyMethodNames = ['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm'] as const;
const readMethodNames = ['get', 'delete', 'head', 'options'] as const;
type AxiosMethodName = typeof bodyMethodNames[number] | typeof readMethodNames[number];
const bodyMethods = new Set<string>(bodyMethodNames);
const readMethods = new Set<string>(readMethodNames);

function isAxiosMethodName(key: PropertyKey): key is AxiosMethodName {
  return typeof key === 'string' && (bodyMethods.has(key) || readMethods.has(key));
}

/** Preserve the Axios API and its existing proxy/authority interceptors at one boundary. */
function credentialClient<T extends AxiosInstance>(client: T): T {
  const methods = new Map<PropertyKey, unknown>();
  const request = (args: unknown[]) => {
    const [first, second] = args;
    const config = typeof first === 'string'
      ? { ...(second as AxiosRequestConfig | undefined), url: first }
      : first as AxiosRequestConfig;
    const scoped = scopeRequest(client, config);
    return scoped.settle(client.request(scoped.config));
  };
  return new Proxy(client, {
    apply(_target, _receiver, args: unknown[]) { return request(args); },
    get(target, key, receiver): unknown {
      if (methods.has(key)) return methods.get(key);
      let method: unknown;
      if (key === 'request') method = (...args: unknown[]) => request(args);
      else if (key === 'create') method = (config?: AxiosRequestConfig) => credentialClient(
        Reflect.apply(Reflect.get(target, key), target, [config]) as AxiosInstance,
      );
      else if (isAxiosMethodName(key)) {
        method = (...args: unknown[]) => {
          const configIndex = bodyMethods.has(key) ? 2 : 1;
          const scoped = scopeRequest(client, {
            ...(args[configIndex] as AxiosRequestConfig | undefined),
            url: String(args[0]), method: key.replace('Form', ''),
            ...(bodyMethods.has(key) ? { data: args[1] } : {}),
          });
          args[configIndex] = scoped.config;
          // Axios owns these public method signatures; the decorator changes only config.
          const instance: AxiosInstance = target;
          return scoped.settle(Reflect.apply(Reflect.get(instance, key), target, args) as Promise<AxiosResponse<unknown>>);
        };
      } else return Reflect.get(target, key, receiver);
      methods.set(key, method);
      return method;
    },
  });
}

export default credentialClient(axios);
