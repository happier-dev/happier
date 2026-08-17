import { redactBugReportSensitiveText as canonicalRedactBugReportSensitiveText } from '@happier-dev/protocol';

const redactBugReportSensitiveText: (input: string) => string = canonicalRedactBugReportSensitiveText;

export type ScmForgeHttpResponse = Readonly<{
    ok: boolean;
    status: number;
    statusText: string;
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
    };

    if (input.mapError) {
        throw input.mapError(context);
    }

    throw new Error(`SCM forge HTTP request failed with status ${response.status || response.statusText}`);
}
