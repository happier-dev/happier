import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  readOpenCodeManagedServerEndpointRegistration,
} from '../../../runtime/server/endpoint.js';
import type { OpenCodeServerTransport } from '../../../runtime/server/transport.js';

export type OpenCodeExternalSessionSourceValidationResult =
  | Readonly<{ ok: true; source: ExternalSessionsSource }>
  | Readonly<{ ok: false; error: string }>;

export type OpenCodeExternalSessionClient = Readonly<{
  sessionList: (opts: Readonly<{
    limit: number;
    search?: string;
    signal?: AbortSignal;
  }>) => Promise<unknown[]>;
  sessionGet: (opts: Readonly<{ sessionId: string; signal?: AbortSignal }>) => Promise<unknown>;
  sessionStatusList: (opts?: Readonly<{ signal?: AbortSignal }>) => Promise<Record<string, { type?: string }>>;
  sessionMessagesList: (opts: Readonly<{
    sessionId: string;
    limit: number;
    before?: string;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{
    items: unknown[];
    nextCursor: string | null;
  }>>;
  dispose: () => Promise<void>;
}>;

type OpenCodeFetch = (input: string, init?: RequestInit) => Promise<Response>;
const OPENCODE_SOURCE_FIELD_MAX_LENGTH = 10_000;
type OpenCodeNormalizedSourceFieldResult =
  | Readonly<{ ok: true; value: string | null }>
  | Readonly<{ ok: false; error: string }>;

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function normalizeExternalSessionsUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function sourceValidationError(error: string): OpenCodeExternalSessionSourceValidationResult {
  return { ok: false, error };
}

function sourceFieldValidationError(error: string): OpenCodeNormalizedSourceFieldResult {
  return { ok: false, error };
}

function normalizeOptionalSourceField(
  value: unknown,
  fieldName: 'baseUrl' | 'directory',
): OpenCodeNormalizedSourceFieldResult {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return sourceFieldValidationError(`invalid source ${fieldName}`);
  }
  const normalized = value.trim();
  if (!normalized) {
    return { ok: true, value: null };
  }
  if (normalized.length > OPENCODE_SOURCE_FIELD_MAX_LENGTH) {
    return sourceFieldValidationError(`invalid source ${fieldName}`);
  }
  return { ok: true, value: normalized };
}

function tryNormalizeExternalSessionsUrl(raw: string): string | null {
  try {
    return normalizeExternalSessionsUrl(raw);
  } catch {
    return null;
  }
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (typeof value === 'string' && value.length > 0) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function fetchJsonResponse<T>(
  url: string,
  fetchFn: OpenCodeFetch,
  signal?: AbortSignal,
  headers?: Readonly<Record<string, string>>,
): Promise<Readonly<{ value: T; response: Response }>> {
  const response = await fetchFn(url, {
    method: 'GET',
    ...(headers ? { headers } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenCode HTTP GET ${url} failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ''}`);
  }
  return {
    value: (await response.json()) as T,
    response,
  };
}

async function fetchJson<T>(
  url: string,
  fetchFn: OpenCodeFetch,
  signal?: AbortSignal,
  headers?: Readonly<Record<string, string>>,
): Promise<T> {
  return (await fetchJsonResponse<T>(url, fetchFn, signal, headers)).value;
}

export function parseOpenCodeSessionStatusMap(
  raw: unknown,
): Record<string, { type?: string }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('OpenCode /session/status returned an invalid status map');
  }

  const entries: Array<[string, { type?: string }]> = [];
  for (const [sessionId, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('OpenCode /session/status returned an invalid status map');
    }
    const type = (value as Readonly<Record<string, unknown>>).type;
    if (type !== undefined && typeof type !== 'string') {
      throw new Error('OpenCode /session/status returned an invalid status map');
    }
    entries.push([sessionId, value as { type?: string }]);
  }
  return Object.fromEntries(entries);
}

export function validateOpenCodeExternalSessionsSource(params: Readonly<{
  source: ExternalSessionsSource;
  env?: Readonly<Record<string, string | undefined>>;
  baseUrlAuthority?: 'configured' | 'canonical';
}>): OpenCodeExternalSessionSourceValidationResult {
  const { source } = params;
  const env = params.env ?? {};
  if (source.kind !== 'opencodeServer') return sourceValidationError('provider/source mismatch');

  const requestedBaseUrlField = normalizeOptionalSourceField(source.baseUrl, 'baseUrl');
  if (!requestedBaseUrlField.ok) {
    return requestedBaseUrlField;
  }
  const directoryField = normalizeOptionalSourceField(source.directory, 'directory');
  if (!directoryField.ok) {
    return directoryField;
  }

  const requestedBaseUrlRaw = requestedBaseUrlField.value;
  const requestedBaseUrl = requestedBaseUrlRaw ? tryNormalizeExternalSessionsUrl(requestedBaseUrlRaw) : null;
  if (requestedBaseUrlRaw && !requestedBaseUrl) {
    return sourceValidationError('invalid source baseUrl');
  }

  const configuredBaseUrlRaw =
    typeof env.HAPPIER_OPENCODE_SERVER_URL === 'string' && env.HAPPIER_OPENCODE_SERVER_URL.trim().length > 0
      ? env.HAPPIER_OPENCODE_SERVER_URL
      : null;
  const configuredBaseUrl = configuredBaseUrlRaw ? tryNormalizeExternalSessionsUrl(configuredBaseUrlRaw) : null;
  if (configuredBaseUrlRaw && !configuredBaseUrl) {
    return sourceValidationError('invalid configured baseUrl');
  }

  const acceptsCanonicalBaseUrl = params.baseUrlAuthority === 'canonical';
  if (requestedBaseUrl && !configuredBaseUrl && !acceptsCanonicalBaseUrl) {
    return sourceValidationError('source baseUrl override is not allowed');
  }
  if (
    requestedBaseUrl
    && configuredBaseUrl
    && requestedBaseUrl !== configuredBaseUrl
    && !acceptsCanonicalBaseUrl
  ) {
    return sourceValidationError('source baseUrl override is not allowed');
  }
  const resolvedBaseUrl = acceptsCanonicalBaseUrl
    ? requestedBaseUrl ?? configuredBaseUrl
    : configuredBaseUrl ?? requestedBaseUrl;

  return {
    ok: true,
    source: {
      ...source,
      ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
      ...(directoryField.value ? { directory: directoryField.value } : {}),
    },
  };
}

function resolveBaseUrlOrThrow(source: ExternalSessionsSource): string {
  if (source.kind !== 'opencodeServer') {
    throw new Error('OpenCode external-session client requires an opencodeServer source');
  }
  const raw = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '';
  if (!raw) {
    throw new Error('OpenCode external-session client requires source.baseUrl or HAPPIER_OPENCODE_SERVER_URL');
  }
  return normalizeBaseUrl(raw);
}

function resolveDirectory(source: ExternalSessionsSource): string {
  if (source.kind !== 'opencodeServer') return '';
  return typeof source.directory === 'string' && source.directory.trim().length > 0
    ? source.directory.trim()
    : '';
}

export async function createOpenCodeExternalSessionClient(params: Readonly<{
  source: ExternalSessionsSource;
  env?: Readonly<Record<string, string | undefined>>;
  fetchFn?: OpenCodeFetch;
  headers?: Readonly<Record<string, string>>;
  baseUrlAuthority?: 'configured' | 'canonical';
  transport?: OpenCodeServerTransport;
}>): Promise<OpenCodeExternalSessionClient> {
  const validated = validateOpenCodeExternalSessionsSource({
    source: params.source,
    env: params.env ?? process.env,
    ...(params.baseUrlAuthority ? { baseUrlAuthority: params.baseUrlAuthority } : {}),
  });
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  const baseUrl = resolveBaseUrlOrThrow(validated.source);
  const transport = params.transport
    ?? readOpenCodeManagedServerEndpointRegistration(baseUrl)?.transport
    ?? null;
  const fetchFn = transport?.fetch ?? params.fetchFn ?? fetch;
  const directory = resolveDirectory(validated.source);
  const directoryQuery = directory ? { directory } : {};

  return {
    sessionList: async ({ limit, search, signal }) => {
      const raw = await fetchJson<unknown>(buildUrl(baseUrl, '/session', {
        ...directoryQuery,
        limit: String(Math.max(1, Math.trunc(limit))),
        ...(search ? { search } : {}),
      }), fetchFn, signal, params.headers);
      return Array.isArray(raw) ? raw : [];
    },
    sessionGet: async ({ sessionId, signal }) => {
      return await fetchJson<unknown>(
        buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}`, directoryQuery),
        fetchFn,
        signal,
        params.headers,
      );
    },
    sessionStatusList: async (opts) => {
      const raw = await fetchJson<unknown>(
        buildUrl(baseUrl, '/session/status', directoryQuery),
        fetchFn,
        opts?.signal,
        params.headers,
      );
      return parseOpenCodeSessionStatusMap(raw);
    },
    sessionMessagesList: async ({ sessionId, limit, before, signal }) => {
      const result = await fetchJsonResponse<unknown>(
        buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/message`, {
          ...directoryQuery,
          limit: String(Math.max(1, Math.trunc(limit))),
          ...(before ? { before } : {}),
        }),
        fetchFn,
        signal,
        params.headers,
      );
      return {
        items: Array.isArray(result.value) ? result.value : [],
        nextCursor: result.response.headers.get('x-next-cursor'),
      };
    },
    dispose: async () => {},
  };
}
