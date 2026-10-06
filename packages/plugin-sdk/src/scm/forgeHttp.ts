import { redactBugReportSensitiveText as canonicalRedactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';

const redactBugReportSensitiveText: (input: string) => string = canonicalRedactBugReportSensitiveText;

export type ScmForgeHttpResponse = Readonly<{
    ok: boolean;
    status: number;
    statusText: string;
    /**
     * `Headers` satisfies this read, so a `fetch`-backed fetcher needs no
     * adaptation. It stays optional because a fetcher may be a narrow stub: a
     * mapper that cannot see a header classifies conservatively from the status
     * alone rather than failing.
     */
    headers?: Readonly<{ get(name: string): string | null }>;
    json(): Promise<unknown>;
    text(): Promise<string>;
}>;

export type ScmForgeHttpFetcher = (url: string, init?: RequestInit) => Promise<ScmForgeHttpResponse>;

export type ScmForgeHttpErrorContext = Readonly<{
    url: string;
    method: string;
    status: number;
    statusText: string;
    body: unknown;
    request: Readonly<{
        headers: Readonly<Record<string, string>>;
    }>;
    /**
     * The forge's own retry/permission evidence, normalized to lowercase names.
     * Without it a mapper can only read a status, and every forge answers a
     * throttle and a permission refusal with the same `403`.
     */
    response: Readonly<{
        headers: Readonly<Record<string, string>>;
    }>;
}>;

export type ScmForgeHttpErrorMapper = (context: ScmForgeHttpErrorContext) => unknown;

export type ScmForgeHttpJsonRequest = Readonly<{
    url: string;
    init?: RequestInit;
    fetcher?: ScmForgeHttpFetcher;
    mapError?: ScmForgeHttpErrorMapper;
}>;

const REDACTED_HEADER_VALUE = '[redacted]';
const SCM_ERROR_CONTEXT_SAFE_HEADER_NAMES = new Set([
    'accept',
    'content-type',
    'if-match',
    'if-modified-since',
    'if-none-match',
    'user-agent',
    'x-github-api-version',
]);

/**
 * The response headers an error mapper may read, and the whole set. A forge
 * response carries `set-cookie` and other credential-bearing material, and an
 * error mapper may persist or log this context, so the default stays "not
 * disclosed" — the same rule the request-header allowlist above applies.
 *
 * Every name here is read by a current mapper: the first three are how a forge
 * says a refusal is a throttle and when it may be retried, and the last is how
 * GitHub names the permission a rejected request required, which is what
 * separates a missing scope from an ordinary refusal.
 */
const SCM_FORGE_RESPONSE_EVIDENCE_HEADER_NAMES = [
    'retry-after',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-accepted-github-permissions',
] as const;

function readForgeResponseEvidenceHeaders(
    response: ScmForgeHttpResponse,
): Readonly<Record<string, string>> {
    const headers = response.headers;
    if (!headers || typeof headers.get !== 'function') return Object.freeze({});
    const normalized: Record<string, string> = {};
    for (const name of SCM_FORGE_RESPONSE_EVIDENCE_HEADER_NAMES) {
        const value = headers.get(name);
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed) normalized[name] = trimmed;
    }
    return Object.freeze(normalized);
}

function defaultForgeHttpFetcher(url: string, init?: RequestInit): Promise<ScmForgeHttpResponse> {
    return fetch(url, init);
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) return {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        const normalized: Record<string, string> = {};
        headers.forEach((value, key) => {
            normalized[key] = value;
        });
        return normalized;
    }
    if (Array.isArray(headers)) {
        const normalized: Record<string, string> = {};
        for (const [key, value] of headers) {
            normalized[key] = value;
        }
        return normalized;
    }
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function redactHeaders(headers: HeadersInit | undefined): Record<string, string> {
    const normalized = normalizeHeaders(headers);
    return Object.fromEntries(
        Object.entries(normalized).map(([key, value]) => [
            key,
            // Error mappers may persist or log this context. SCM request headers
            // have no stable public-value contract, so retain only the small
            // diagnostics allowlist and redact every other header by default.
            SCM_ERROR_CONTEXT_SAFE_HEADER_NAMES.has(key.toLowerCase()) ? value : REDACTED_HEADER_VALUE,
        ]),
    );
}

async function readScmForgeResponseBody(response: ScmForgeHttpResponse): Promise<unknown> {
    try {
        const text = await response.text();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    } catch {
        try {
            return await response.json();
        } catch {
            return null;
        }
    }
}

export async function requestScmForgeJson(input: ScmForgeHttpJsonRequest): Promise<unknown> {
    const fetcher = input.fetcher ?? defaultForgeHttpFetcher;
    const response = await fetcher(input.url, input.init);
    if (response.ok) {
        return response.json();
    }

    const context: ScmForgeHttpErrorContext = {
        url: redactBugReportSensitiveText(input.url),
        method: input.init?.method?.toUpperCase() ?? 'GET',
        status: response.status,
        statusText: response.statusText,
        body: await readScmForgeResponseBody(response),
        request: {
            headers: redactHeaders(input.init?.headers),
        },
        response: {
            headers: readForgeResponseEvidenceHeaders(response),
        },
    };

    if (input.mapError) {
        throw input.mapError(context);
    }

    throw new Error(`SCM forge HTTP request failed with status ${response.status || response.statusText}`);
}
