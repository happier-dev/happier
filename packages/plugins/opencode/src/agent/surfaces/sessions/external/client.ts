import type { ExternalSessionsSource } from '@happier-dev/protocol';

export type OpenCodeExternalSessionSourceValidationResult =
  | Readonly<{ ok: true; source: ExternalSessionsSource }>
  | Readonly<{ ok: false; error: string }>;

export type OpenCodeExternalSessionClient = Readonly<{
  sessionList: () => Promise<unknown[]>;
  sessionGet: (opts: Readonly<{ sessionId: string }>) => Promise<unknown>;
  sessionStatusList: () => Promise<Record<string, { type?: string }>>;
  sessionMessagesList: (opts: Readonly<{ sessionId: string }>) => Promise<unknown[]>;
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

async function fetchJson<T>(url: string, fetchFn: OpenCodeFetch): Promise<T> {
  const response = await fetchFn(url, { method: 'GET' });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenCode HTTP GET ${url} failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ''}`);
  }
  return (await response.json()) as T;
}

export function validateOpenCodeExternalSessionsSource(params: Readonly<{
  source: ExternalSessionsSource;
  env?: Readonly<Record<string, string | undefined>>;
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

  if (requestedBaseUrl && !configuredBaseUrl) {
    return sourceValidationError('source baseUrl override is not allowed');
  }
  if (requestedBaseUrl && configuredBaseUrl && requestedBaseUrl !== configuredBaseUrl) {
    return sourceValidationError('source baseUrl override is not allowed');
  }

  return {
    ok: true,
    source: {
      ...source,
      ...(requestedBaseUrl || configuredBaseUrl ? { baseUrl: configuredBaseUrl ?? requestedBaseUrl } : {}),
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
}>): Promise<OpenCodeExternalSessionClient> {
  const validated = validateOpenCodeExternalSessionsSource({
    source: params.source,
    env: params.env ?? process.env,
  });
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = resolveBaseUrlOrThrow(validated.source);
  const directory = resolveDirectory(validated.source);
  const directoryQuery = directory ? { directory } : {};

  return {
    sessionList: async () => {
      const raw = await fetchJson<unknown>(buildUrl(baseUrl, '/session', directoryQuery), fetchFn);
      return Array.isArray(raw) ? raw : [];
    },
    sessionGet: async ({ sessionId }) => {
      return await fetchJson<unknown>(
        buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}`, directoryQuery),
        fetchFn,
      );
    },
    sessionStatusList: async () => {
      const raw = await fetchJson<unknown>(buildUrl(baseUrl, '/session/status', directoryQuery), fetchFn);
      return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, { type?: string }>
        : {};
    },
    sessionMessagesList: async ({ sessionId }) => {
      const raw = await fetchJson<unknown>(
        buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/message`, directoryQuery),
        fetchFn,
      );
      return Array.isArray(raw) ? raw : [];
    },
    dispose: async () => {},
  };
}
