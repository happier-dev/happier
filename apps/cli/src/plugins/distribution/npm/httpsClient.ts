import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import { resolveUrlConnectionIdentity } from '@/network/urlConnectionIdentity';
import { awaitPluginAcquisition, createPluginAcquisitionLifetime, pluginAcquisitionAbortError } from '../acquisitionLifetime';

import { assertPublicNpmNetworkAddresses, assertSafeNpmHttpsUrl } from './networkPolicy';
import type { NpmArtifactBodyClient } from './download';
import type { NpmRegistryJsonClient } from './resolver';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class NpmRegistryHttpError extends Error {
  readonly code: 'authentication_failed' | 'not_found' | 'rate_limited' | 'server_error' | 'request_failed';
  readonly statusCode: number;
  readonly publicationReason?: 'otp_required' | 'version_conflict';

  constructor(statusCode: number, publicationReason?: 'otp_required' | 'version_conflict') {
    const code = statusCode === 401 || statusCode === 403
      ? 'authentication_failed'
      : statusCode === 404
        ? 'not_found'
        : statusCode === 429
          ? 'rate_limited'
          : statusCode >= 500
            ? 'server_error'
            : 'request_failed';
    super(`Npm registry request failed (${code})`);
    this.name = 'NpmRegistryHttpError';
    this.code = code;
    this.statusCode = statusCode;
    this.publicationReason = publicationReason;
  }
}

export type NpmDnsLookup = (hostname: string) => Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[] >;

export type NpmRegistryArtifactClient = NpmRegistryJsonClient & NpmArtifactBodyClient;

export type NpmRegistryPublicationClient = NpmRegistryJsonClient & Readonly<{
  requestJson(input: Readonly<{
    url: string;
    method: 'PUT' | 'POST';
    body: unknown;
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    ignoreBody?: boolean;
    onRequestSent?: () => void;
  }>): Promise<unknown>;
}>;

export type NpmRegistryHttpsClient = NpmRegistryPublicationClient & NpmArtifactBodyClient & Readonly<{
  requestJsonResponse(input: Readonly<{
    url: string; method: 'GET' | 'POST'; body?: unknown;
    headers: Readonly<Record<string, string>>; signal?: AbortSignal;
  }>): Promise<Readonly<{ statusCode: number; headers: IncomingHttpHeaders; body: unknown }>>;
}>;

function contentLength(headers: IncomingHttpHeaders): number | undefined {
  const raw = headers['content-length'];
  if (typeof raw !== 'string') return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid npm registry content-length');
  return parsed;
}

async function defaultLookup(hostname: string): Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.filter((answer): answer is { address: string; family: 4 | 6 } => answer.family === 4 || answer.family === 6);
}

async function openPinnedHttpsResponse(params: Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  lookup: NpmDnsLookup;
  request: typeof httpsRequest;
  requiredOrigin: string;
  allowPrivateNetwork: boolean;
  method?: 'GET' | 'PUT' | 'POST';
  body?: string;
  onRequestSent?: () => void;
}>): Promise<IncomingMessage> {
  let current = assertSafeNpmHttpsUrl(params.url);
  if (current.origin !== params.requiredOrigin) throw new Error('Npm registry request origin mismatch');

  const visitedUrls = new Set<string>();
  for (;;) {
    params.signal?.throwIfAborted();
    // Fragments are not sent in the HTTP request and cannot distinguish hops.
    current.hash = '';
    const currentUrl = current.toString();
    if (visitedUrls.has(currentUrl)) throw new Error('Npm registry redirect loop');
    visitedUrls.add(currentUrl);
    const { hostname, servername } = resolveUrlConnectionIdentity(current.hostname);
    params.signal?.throwIfAborted();
    const addresses = await awaitPluginAcquisition(params.lookup(hostname), params.signal);
    assertPublicNpmNetworkAddresses(addresses.map((answer) => answer.address), {
      allowPrivateNetwork: params.allowPrivateNetwork,
    });
    const selected = addresses[0]!;
    const options: RequestOptions = {
      protocol: 'https:', hostname, port: current.port || undefined,
      path: `${current.pathname}${current.search}`, method: params.method ?? 'GET', headers: params.headers,
      ...(servername === undefined ? {} : { servername }),
      lookup: (_hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === 'object' && lookupOptions.all) {
          callback(null, addresses.map((answer) => ({ address: answer.address, family: answer.family })));
          return;
        }
        callback(null, selected.address, selected.family);
      },
    };
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      params.signal?.throwIfAborted();
      const abort = () => request.destroy(pluginAcquisitionAbortError(params.signal!));
      const clear = () => params.signal?.removeEventListener('abort', abort);
      const request = params.request(options, (message) => {
        clear();
        resolve(message);
      });
      params.signal?.addEventListener('abort', abort, { once: true });
      request.once('error', (error) => { clear(); reject(error); });
      if (params.signal?.aborted) { abort(); return; }
      params.onRequestSent?.();
      request.end(params.body);
    });
    const status = response.statusCode ?? 0;
    if (!REDIRECT_STATUSES.has(status)) {
      if (!params.method && (status < 200 || status >= 300)) {
        response.destroy();
        throw new NpmRegistryHttpError(status);
      }
      return response;
    }
    // An external write is never replayed, even when a registry redirects it.
    if (params.method && params.method !== 'GET') { response.destroy(); throw new Error('Npm registry publication redirected'); }
    const location = response.headers.location;
    response.destroy();
    if (!location) throw new Error('Npm registry redirect omitted location');
    const next = assertSafeNpmHttpsUrl(new URL(location, current).toString());
    if (next.origin !== params.requiredOrigin) throw new Error('Npm registry redirect changed origin');
    current = next;
  }
}

export function createNpmRegistryHttpsClient(options: Readonly<{
  registryOrigin: string;
  authorizationHeader?: string;
  allowPrivateNetwork?: boolean;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  lookup?: NpmDnsLookup;
  request?: typeof httpsRequest;
}>): NpmRegistryHttpsClient {
  const requiredOrigin = assertSafeNpmHttpsUrl(options.registryOrigin).origin;
  const timeoutMs = options.timeoutMs;
  if (timeoutMs != null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw new Error('Invalid npm registry network limits');
  }
  const lookup = options.lookup ?? defaultLookup;
  const request = options.request ?? httpsRequest;
  const baseHeaders: Readonly<Record<string, string>> = options.authorizationHeader ? { authorization: options.authorizationHeader } : {};

  async function open(input: Readonly<{ url: string; maxBytes?: number | null; headers: Readonly<Record<string, string>>; deadlineAtMonotonicMs?: number; signal?: AbortSignal; method?: 'GET' | 'PUT' | 'POST'; body?: string; onRequestSent?: () => void }>): Promise<IncomingMessage> {
    if (input.maxBytes != null && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)) throw new Error('Invalid npm registry response size limit');
    const lifetime = createPluginAcquisitionLifetime({
      signal: input.signal && options.signal ? AbortSignal.any([input.signal, options.signal]) : input.signal ?? options.signal,
      deadlineAtMonotonicMs: input.deadlineAtMonotonicMs,
      timeoutMs: input.deadlineAtMonotonicMs === undefined ? timeoutMs : null,
      errorLabel: 'Npm registry request',
    });
    try {
      const response = await openPinnedHttpsResponse({
        url: input.url, requiredOrigin, signal: lifetime.signal, lookup, request,
        allowPrivateNetwork: options.allowPrivateNetwork === true,
        headers: { ...input.headers, ...baseHeaders },
        method: input.method, body: input.body, onRequestSent: input.onRequestSent,
      });
      const abort = () => response.destroy(pluginAcquisitionAbortError(lifetime.signal!));
      const clear = () => {
        lifetime.signal?.removeEventListener('abort', abort);
        lifetime.dispose();
      };
      response.once('end', clear);
      response.once('close', clear);
      response.once('error', clear);
      lifetime.signal?.addEventListener('abort', abort, { once: true });
      if (lifetime.signal?.aborted) { abort(); lifetime.signal.throwIfAborted(); }
      let declared: number | undefined;
      try {
        declared = contentLength(response.headers);
      } catch (error) {
        response.destroy();
        throw error;
      }
      if (input.maxBytes != null && declared !== undefined && declared > input.maxBytes) {
        response.destroy();
        throw new Error(`Npm registry response exceeds the configured size limit (${input.maxBytes} bytes)`);
      }
      return response;
    } catch (error) {
      lifetime.dispose();
      throw error;
    }
  }

  async function requestJsonResponse(input: Readonly<{
    url: string; method: 'GET' | 'POST' | 'PUT'; body?: unknown; headers: Readonly<Record<string, string>>;
    signal?: AbortSignal; ignoreBody?: boolean; onRequestSent?: () => void;
  }>): Promise<Readonly<{ statusCode: number; headers: IncomingHttpHeaders; body: unknown }>> {
      const body = input.method === 'GET' ? undefined : JSON.stringify(input.body);
      if (body === undefined && input.method !== 'GET') throw new Error('Invalid npm registry request body');
      const response = await open({ ...input, body, headers: {
        ...input.headers, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
      } });
      const status = response.statusCode ?? 0;
      if (input.ignoreBody && status >= 200 && status < 300) {
        response.resume();
        return { statusCode: status, headers: response.headers, body: undefined };
      }
      const chunks: Buffer[] = [];
      for await (const value of response) chunks.push(Buffer.from(value));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (status < 200 || status >= 300) {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { /* Only classified facts leave this private boundary. */ }
        const error = parsed && typeof parsed === 'object' && 'error' in parsed ? parsed.error : undefined;
        const otp = status === 401 && (String(response.headers['www-authenticate'] ?? '').split(/,\s*/).some((value) => value.toLowerCase() === 'otp') || /one-time pass/.test(raw));
        const conflict = status === 409 || error === 'EPUBLISHCONFLICT'
          || (status === 403 && typeof error === 'string' && /cannot publish over (?:the )?previously published/i.test(error));
        throw new NpmRegistryHttpError(status, otp ? 'otp_required' : conflict ? 'version_conflict' : undefined);
      }
      try { return { statusCode: status, headers: response.headers, body: JSON.parse(raw) as unknown }; }
      catch { throw new Error('Invalid npm registry JSON response'); }
  }

  return {
    requestJsonResponse,
    async requestJson(input) { return (await requestJsonResponse(input)).body; },
    async getJson(input) {
      const response = await open(input);
      const contentType = response.headers['content-type'];
      if (typeof contentType !== 'string' || !/^(application\/json|application\/vnd\.npm\.install-v1\+json)(?:\s*;|$)/i.test(contentType)) {
        response.destroy();
        throw new Error('Npm registry metadata response is not JSON');
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const value of response) {
        const chunk = Buffer.from(value);
        bytes += chunk.byteLength;
        if (input.maxBytes != null && bytes > input.maxBytes) {
          response.destroy();
          throw new Error(`Npm registry response exceeds the configured size limit (${input.maxBytes} bytes)`);
        }
        chunks.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown; }
      catch { throw new Error('Invalid npm registry JSON response'); }
    },
    async getBody(input) {
      const response = await open(input);
      return { body: response, ...(contentLength(response.headers) === undefined ? {} : { contentLength: contentLength(response.headers) }) };
    },
  };
}
