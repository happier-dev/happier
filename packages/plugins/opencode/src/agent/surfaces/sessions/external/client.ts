import {
  readManagedServiceEndpointUrl,
  type ManagedServiceEndpointUrlRejection,
} from '@happier-dev/plugin-sdk/managed-services';
import type {
  AgentExternalSessionSource,
  AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
  OpenCodeNativeFetch,
} from '../../../runtime/server/transport.js';
import { createManagedEndpointFetch } from './managedEndpointFetch.js';

export type OpenCodeExternalSessionSourceValidationResult =
  | Readonly<{ ok: true; source: OpenCodeExternalSessionSource }>
  | Readonly<{ ok: false; error: string }>;

export type OpenCodeExternalSessionSource = AgentExternalSessionSource & Readonly<{
  kind: 'opencodeServer';
  baseUrl?: string;
  directory?: string;
  managedEndpoint?: true;
}>;

export function projectOpenCodeExternalSessionSource(
  source: AgentExternalSessionSource,
): OpenCodeExternalSessionSource | null {
  return source.kind === 'opencodeServer'
    ? { ...source, kind: 'opencodeServer' }
    : null;
}

export type OpenCodeExternalSessionClient = Readonly<{
  sessionList: (opts: Readonly<{
    limit: number;
    search?: string;
    cursor?: number;
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

type OpenCodeFetch = OpenCodeNativeFetch;
const OPENCODE_SOURCE_FIELD_MAX_LENGTH = 10_000;
type OpenCodeNormalizedSourceFieldResult =
  | Readonly<{ ok: true; value: string | null }>
  | Readonly<{ ok: false; error: string }>;

/**
 * The user's own server address, checked here — where the value is accepted —
 * against the same rule the daemon dials it with, so a source a user can save
 * is a source the daemon can attach to. Each rejection names what is wrong;
 * without that, the first thing the user sees is a
 * `plugin_managed_server_endpoint_denied` from inside the process supervisor.
 */
const OPENCODE_SOURCE_BASE_URL_ERRORS: Readonly<Record<ManagedServiceEndpointUrlRejection, string>> = {
  malformed: 'source baseUrl must be an absolute URL, for example http://192.168.1.50:4096',
  scheme: 'source baseUrl must be an http or https URL',
  embeddedCredentials:
    'source baseUrl must not embed a username or password; put the server password in the OpenCode server password setting',
  host: 'source baseUrl must name a host',
  queryOrFragment: 'source baseUrl must not carry a query or fragment',
  port: 'source baseUrl port must be between 1 and 65535',
};

function readExternalSessionsUrl(
  raw: string,
): Readonly<{ ok: true; value: string }> | Readonly<{ ok: false; error: string }> {
  const read = readManagedServiceEndpointUrl(raw, {
    hostPolicy: 'userDeclaredAttach',
    // A saved value may carry a path, query or fragment; they are dropped
    // below rather than treated as a reason to refuse the address.
    allowSearch: true,
    allowHash: true,
  });
  if (!read.ok) {
    return { ok: false, error: OPENCODE_SOURCE_BASE_URL_ERRORS[read.rejection] };
  }
  const url = new URL(read.endpoint.baseUrl);
  url.hash = '';
  url.search = '';
  return { ok: true, value: url.toString().replace(/\/+$/, '') };
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

function buildPathAndQuery(path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path, 'http://opencode.invalid');
  for (const [key, value] of Object.entries(query ?? {})) {
    if (typeof value === 'string' && value.length > 0) {
      url.searchParams.set(key, value);
    }
  }
  return `${url.pathname}${url.search}`;
}

function readPositiveResponseByteBudget(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('OpenCode response byte budget must be a positive safe integer.');
  }
  return value;
}

function readSessionListCursor(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('OpenCode session cursor must be a non-negative safe integer.');
  }
  return String(value);
}

async function readResponseText(
  response: Response,
  maxResponseBytes: number | undefined,
): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (
        maxResponseBytes !== undefined
        && value.byteLength > maxResponseBytes - totalBytes
      ) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `OpenCode response body exceeds its ${maxResponseBytes}-byte operation budget`,
        );
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchJsonResponse<T>(
  url: string,
  fetchFn: OpenCodeFetch,
  maxResponseBytes: number | undefined,
  signal?: AbortSignal,
): Promise<Readonly<{ value: T; response: Response }>> {
  const response = await fetchFn(url, {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    await readResponseText(response, maxResponseBytes);
    throw new Error(`OpenCode HTTP GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return {
    value: JSON.parse(await readResponseText(response, maxResponseBytes)) as T,
    response,
  };
}

async function fetchJson<T>(
  url: string,
  fetchFn: OpenCodeFetch,
  maxResponseBytes: number | undefined,
  signal?: AbortSignal,
): Promise<T> {
  return (await fetchJsonResponse<T>(url, fetchFn, maxResponseBytes, signal)).value;
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

function parseOpenCodeArrayResponse(raw: unknown, endpoint: string): unknown[] {
  if (!Array.isArray(raw)) {
    throw new Error(`OpenCode ${endpoint} returned an invalid array response`);
  }
  return raw;
}

export function validateOpenCodeExternalSessionsSource(params: Readonly<{
  source: OpenCodeExternalSessionSource;
  env?: Readonly<Record<string, string | undefined>>;
  baseUrlAuthority?: 'configured' | 'canonical';
}>): OpenCodeExternalSessionSourceValidationResult {
  const { source } = params;
  if (source.kind !== 'opencodeServer') return sourceValidationError('provider/source mismatch');

  const managedEndpoint = Reflect.get(source, 'managedEndpoint');
  if (managedEndpoint !== undefined && managedEndpoint !== true) {
    return sourceValidationError('invalid source managedEndpoint');
  }

  const requestedBaseUrlField = normalizeOptionalSourceField(source.baseUrl, 'baseUrl');
  if (!requestedBaseUrlField.ok) {
    return requestedBaseUrlField;
  }
  const directoryField = normalizeOptionalSourceField(source.directory, 'directory');
  if (!directoryField.ok) {
    return directoryField;
  }

  const requestedBaseUrlRaw = requestedBaseUrlField.value;
  let requestedBaseUrl: string | null = null;
  if (requestedBaseUrlRaw) {
    const read = readExternalSessionsUrl(requestedBaseUrlRaw);
    if (!read.ok) return sourceValidationError(read.error);
    requestedBaseUrl = read.value;
  }

  if (requestedBaseUrl && managedEndpoint === true) {
    return sourceValidationError('source cannot combine baseUrl with managedEndpoint');
  }

  return {
    ok: true,
    source: {
      kind: 'opencodeServer',
      ...(requestedBaseUrl ? { baseUrl: requestedBaseUrl } : { managedEndpoint: true }),
      ...(directoryField.value ? { directory: directoryField.value } : {}),
    },
  };
}

function resolveDirectory(source: OpenCodeExternalSessionSource): string {
  if (source.kind !== 'opencodeServer') return '';
  return typeof source.directory === 'string' && source.directory.trim().length > 0
    ? source.directory.trim()
    : '';
}

/**
 * Every read goes through the host's managed-service endpoint, for a spawned
 * server and an attached one alike. The client deliberately owns no transport
 * and no address: the managed service holds the endpoint, and the host applies
 * whichever credential authenticates it, so "connect to an OpenCode server" has
 * exactly one implementation instead of one per surface.
 */
export async function createOpenCodeExternalSessionClient(params: Readonly<{
  source: OpenCodeExternalSessionSource;
  env?: Readonly<Record<string, string | undefined>>;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointRead;
  baseUrlAuthority?: 'configured' | 'canonical';
  maxResponseBytes?: number;
}>): Promise<OpenCodeExternalSessionClient> {
  const validated = validateOpenCodeExternalSessionsSource({
    source: params.source,
    env: params.env ?? process.env,
    ...(params.baseUrlAuthority ? { baseUrlAuthority: params.baseUrlAuthority } : {}),
  });
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  const managedEndpointRead = params.managedEndpointRead;
  const fetchFn: OpenCodeFetch = managedEndpointRead
    ? createManagedEndpointFetch(managedEndpointRead)
    : async () => {
      throw new Error(
        'OpenCode managed external-session client requires an invocation-bound managedEndpointRead.',
      );
    };
  const buildRequestTarget = buildPathAndQuery;
  const directory = resolveDirectory(validated.source);
  const directoryQuery = directory ? { directory } : {};
  const maxResponseBytes = readPositiveResponseByteBudget(params.maxResponseBytes);

  return {
    sessionList: async ({ limit, search, cursor, signal }) => {
      const sessionCursor = readSessionListCursor(cursor);
      const raw = await fetchJson<unknown>(buildRequestTarget('/experimental/session', {
        ...directoryQuery,
        limit: String(Math.max(1, Math.trunc(limit))),
        ...(search ? { search } : {}),
        ...(sessionCursor !== undefined ? { cursor: sessionCursor } : {}),
      }), fetchFn, maxResponseBytes, signal);
      return parseOpenCodeArrayResponse(raw, '/experimental/session');
    },
    sessionGet: async ({ sessionId, signal }) => {
      return await fetchJson<unknown>(
        buildRequestTarget(`/session/${encodeURIComponent(sessionId)}`, directoryQuery),
        fetchFn,
        maxResponseBytes,
        signal,
      );
    },
    sessionStatusList: async (opts) => {
      const raw = await fetchJson<unknown>(
        buildRequestTarget('/session/status', directoryQuery),
        fetchFn,
        maxResponseBytes,
        opts?.signal,
      );
      return parseOpenCodeSessionStatusMap(raw);
    },
    sessionMessagesList: async ({ sessionId, limit, before, signal }) => {
      const result = await fetchJsonResponse<unknown>(
        buildRequestTarget(`/session/${encodeURIComponent(sessionId)}/message`, {
          ...directoryQuery,
          limit: String(Math.max(1, Math.trunc(limit))),
          ...(before ? { before } : {}),
        }),
        fetchFn,
        maxResponseBytes,
        signal,
      );
      return {
        items: parseOpenCodeArrayResponse(result.value, '/session/:id/message'),
        nextCursor: result.response.headers.get('x-next-cursor'),
      };
    },
    dispose: async () => {},
  };
}
