import axios, { AxiosError, type AxiosAdapter, type AxiosRequestConfig, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, Response as LightMyRequestResponse } from 'light-my-request';

function normalizeHeaders(headers: AxiosRequestConfig['headers']): Record<string, string> {
  if (!headers) return {};

  if (typeof (headers as { toJSON?: unknown }).toJSON === 'function') {
    const jsonHeaders = (headers as { toJSON: () => Record<string, unknown> }).toJSON();
    return Object.fromEntries(
      Object.entries(jsonHeaders)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]),
    );
  }

  if (typeof headers === 'object') {
    return Object.fromEntries(
      Object.entries(headers)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]),
    );
  }

  return {};
}

function normalizePayload(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}

function parseResponsePayload(payloadText: string, contentType: string | undefined): unknown {
  const trimmed = payloadText.trim();
  const shouldParseJson =
    (typeof contentType === 'string' && contentType.toLowerCase().includes('application/json')) ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');

  if (!shouldParseJson) return payloadText;
  try {
    return JSON.parse(payloadText);
  } catch {
    return payloadText;
  }
}

function toInjectMethod(method: string | undefined): NonNullable<InjectOptions['method']> {
  const normalized = (method ?? 'get').toLowerCase();
  switch (normalized) {
    case 'delete':
    case 'get':
    case 'head':
    case 'patch':
    case 'post':
    case 'put':
    case 'options':
      return normalized;
    default:
      throw new Error(`axios adapter: unsupported method: ${method ?? ''}`);
  }
}

export function installAxiosFastifyAdapter(params: Readonly<{ app: FastifyInstance; origin: string }>): () => void {
  const defaults = axios.defaults as typeof axios.defaults & { adapter?: AxiosAdapter | AxiosAdapter[] };
  const originalAdapter = defaults.adapter;

  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    if (!config.url) throw new Error('axios adapter: missing url');

    const requestUrl = new URL(config.url, config.baseURL ?? params.origin);
    if (requestUrl.origin !== params.origin) {
      throw new Error(`axios adapter: unexpected origin: ${requestUrl.origin}`);
    }

    if (config.params && typeof config.params === 'object') {
      for (const [key, value] of Object.entries(config.params as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        requestUrl.searchParams.set(key, String(value));
      }
    }
    const method = toInjectMethod(config.method);
    const injectOptions: InjectOptions = {
      method,
      url: `${requestUrl.pathname}${requestUrl.search}`,
      headers: normalizeHeaders(config.headers),
      payload: normalizePayload(config.data),
    };
    const injectResponse = await new Promise<LightMyRequestResponse>((resolve, reject) => {
      params.app.inject(injectOptions, (err, response) => {
        if (err) {
          reject(err);
          return;
        }
        if (!response) {
          reject(new Error('axios adapter: fastify inject did not return a response'));
          return;
        }
        resolve(response);
      });
    });

    const responseHeaders = Object.fromEntries(
      Object.entries(injectResponse.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')]),
    );
    const contentTypeHeader = responseHeaders['content-type'] ?? responseHeaders['Content-Type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : undefined;
    const payloadText =
      typeof injectResponse.payload === 'string' ? injectResponse.payload : String(injectResponse.payload ?? '');

    const response: AxiosResponse = {
      data: parseResponsePayload(payloadText, contentType),
      status: injectResponse.statusCode,
      statusText: injectResponse.statusMessage ?? '',
      headers: responseHeaders,
      config,
      request: {},
    };

    const validateStatus = config.validateStatus ?? ((status: number) => status >= 200 && status < 300);
    if (!validateStatus(injectResponse.statusCode)) {
      const errorCode = injectResponse.statusCode >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST;
      throw new AxiosError(
        `Request failed with status code ${injectResponse.statusCode}`,
        errorCode,
        config,
        {},
        response,
      );
    }

    return response;
  };

  defaults.adapter = adapter;
  return () => {
    defaults.adapter = originalAdapter;
  };
}
