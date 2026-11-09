import { z } from 'zod/mini';
import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';

export type HomeDomainHttpRequestV1 = Readonly<{
  method: string;
  path: string;
  body: unknown | undefined;
}>;

const HomeDomainConfirmedRollbackV1Schema = z.union([
  z.strictObject({ error: z.literal('database_transaction_conflict_exhausted'), statusCode: z.literal(503) }),
  z.strictObject({ error: z.literal('database_transaction_timeout'), statusCode: z.literal(503),
    transactionOutcome: z.literal('rolled_back') }),
]);
type HomeDomainConfirmedRollbackV1 = z.infer<typeof HomeDomainConfirmedRollbackV1Schema>;

/**
 * Read the Home's global confirmation that a transaction rolled back after a
 * conflict or deadline. This response settles the mutation as a definite
 * failure; it must never be collapsed into response-loss ambiguity.
 */
export function readHomeDomainConfirmedRollbackV1(
  httpStatus: number,
  value: unknown,
): Readonly<{
  code: HomeDomainConfirmedRollbackV1['error'];
  details: HomeDomainConfirmedRollbackV1;
}> | null {
  if (httpStatus !== 503) return null;
  const parsed = HomeDomainConfirmedRollbackV1Schema.safeParse(value);
  return parsed.success ? { code: parsed.data.error, details: parsed.data } : null;
}

function appendQueryValue(query: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    query.append(key, String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(query, key, item);
    return;
  }
  query.append(key, JSON.stringify(projectNativeJsonValueForTransport(value)));
}

/**
 * Bind one already-declared Home Action row to its exact HTTP request.
 *
 * The Action input stays the single public intent contract. Path parameters are
 * consumed by name, GET remainder becomes a query, and mutation remainder stays
 * a body unless the existing route requires path fields in that body as well.
 * Existing unparameterized POST rows therefore retain their byte-level
 * shape while REST-shaped families avoid a second client-owned route table.
 */
export function bindHomeDomainHttpRequestV1(params: Readonly<{
  transport: Readonly<{ method: string; path: string; preservePathFieldsInBody?: true }>;
  inputSchema: z.ZodMiniType;
  input: unknown;
}>): HomeDomainHttpRequestV1 {
  const parsed = params.inputSchema.parse(params.input);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Home-domain Action input must be an object');
  }
  const remaining: Record<string, unknown> = { ...parsed as Record<string, unknown> };
  const path = params.transport.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, key: string) => {
    const value = remaining[key];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError(`Home-domain Action input is missing path field: ${key}`);
    }
    delete remaining[key];
    return encodeURIComponent(String(value));
  });

  if (params.transport.method.toUpperCase() === 'GET') {
    delete remaining.v;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(remaining)) appendQueryValue(query, key, value);
    const encoded = query.toString();
    return {
      method: params.transport.method,
      path: encoded.length > 0 ? `${path}?${encoded}` : path,
      body: undefined,
    };
  }

  return { method: params.transport.method, path,
    body: projectNativeJsonValueForTransport(params.transport.preservePathFieldsInBody ? parsed : remaining) };
}

/**
 * Connection-establishment failures are the only transport codes that prove the Home never
 * received the bytes. Everything else that fails after the request was handed to the transport
 * stays ambiguous and must be reported with its frozen request rather than silently retried.
 */
const PROVEN_NO_HOME_DISPATCH_ERROR_CODES_V1 = Object.freeze(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

function readHomeDomainTransportErrorCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 3) return null;
  const record = error as Readonly<{ code?: unknown; cause?: unknown }>;
  if (typeof record.code === 'string' && record.code.trim().length > 0) {
    return record.code.trim().toUpperCase();
  }
  return readHomeDomainTransportErrorCode(record.cause, depth + 1);
}

export type HomeDomainHttpMutationFailureV1 = 'cancelled' | 'not_dispatched' | 'outcome_unknown';

/**
 * Decide whether a failed Home-domain HTTP mutation may have committed.
 *
 * `issued` means every local authority/setup guard passed and the request reached the transport.
 * It deliberately does not claim the Home received bytes. Both the browser and the CLI/daemon
 * carriers own their own transport witness (fetch vs axios) and consume this one decision, so a
 * single sealed mutation cannot mean "offline" on one host and "outcome unknown" on the other.
 */
export function classifyHomeDomainHttpMutationFailureV1(input: Readonly<{
  error: unknown;
  issued: boolean;
  aborted: boolean;
}>): HomeDomainHttpMutationFailureV1 {
  const aborted = input.aborted
    || (input.error instanceof Error && input.error.name === 'AbortError')
    || readHomeDomainTransportErrorCode(input.error) === 'ERR_CANCELED';
  if (!input.issued) return aborted ? 'cancelled' : 'not_dispatched';
  return PROVEN_NO_HOME_DISPATCH_ERROR_CODES_V1.includes(readHomeDomainTransportErrorCode(input.error) ?? '')
    ? 'not_dispatched'
    : 'outcome_unknown';
}
