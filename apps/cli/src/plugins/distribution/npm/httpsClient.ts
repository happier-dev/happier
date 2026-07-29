import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';

import { resolveUrlConnectionIdentity } from '@/network/urlConnectionIdentity';

import { assertPublicNpmNetworkAddresses, assertSafeNpmHttpsUrl } from './networkPolicy';
import type { NpmArtifactBodyClient } from './download';
import type { NpmRegistryJsonClient } from './resolver';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class NpmRegistryHttpError extends Error {
  readonly code: 'authentication_failed' | 'not_found' | 'rate_limited' | 'server_error' | 'request_failed';
  readonly statusCode: number;

  constructor(statusCode: number) {
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
  }
}

export type NpmDnsLookup = (hostname: string) => Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[] >;

export type NpmRegistryHttpsClient = NpmRegistryJsonClient & NpmArtifactBodyClient;

function deadlineRemainingMs(deadlineAtMonotonicMs: number): number {
  const remaining = deadlineAtMonotonicMs - performance.now();
  if (!Number.isFinite(deadlineAtMonotonicMs) || remaining <= 0) throw new Error('Npm registry request timed out');
  return remaining;
}

async function awaitWithinDeadline<T>(promise: Promise<T>, deadlineAtMonotonicMs: number): Promise<T> {
  const remaining = deadlineRemainingMs(deadlineAtMonotonicMs);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Npm registry request timed out')), remaining); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function attachBodyDeadline(response: IncomingMessage, deadlineAtMonotonicMs: number): void {
  const timer = setTimeout(() => response.destroy(new Error('Npm registry request timed out')), deadlineRemainingMs(deadlineAtMonotonicMs));
  const clear = () => clearTimeout(timer);
  response.once('end', clear);
  response.once('close', clear);
}

function contentLength(headers: IncomingHttpHeaders): number | undefined {
  const raw = headers['content-length'];
  if (typeof raw !== 'string') return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid npm registry content-length');
  return parsed;
}

function assertHeadersWithinLimit(headers: IncomingHttpHeaders, maxBytes = 64 * 1024): void {
  let total = 0;
  for (const [name, value] of Object.entries(headers)) {
    total += Buffer.byteLength(name);
    if (Array.isArray(value)) total += value.reduce((sum, item) => sum + Buffer.byteLength(item), 0);
    else if (typeof value === 'string') total += Buffer.byteLength(value);
  }
  if (total > maxBytes) throw new Error(`Npm registry response headers exceed the configured size limit (${maxBytes} bytes)`);
}

async function defaultLookup(hostname: string): Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.filter((answer): answer is { address: string; family: 4 | 6 } => answer.family === 4 || answer.family === 6);
}

async function openPinnedHttpsResponse(params: Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  deadlineAtMonotonicMs: number;
  maxRedirects: number;
  lookup: NpmDnsLookup;
  request: typeof httpsRequest;
  requiredOrigin: string;
  allowPrivateNetwork: boolean;
}>): Promise<IncomingMessage> {
  let current = assertSafeNpmHttpsUrl(params.url);
  if (current.origin !== params.requiredOrigin) throw new Error('Npm registry request origin mismatch');

  for (let redirectCount = 0; ; redirectCount += 1) {
    const { hostname, servername } = resolveUrlConnectionIdentity(current.hostname);
    const addresses = await awaitWithinDeadline(params.lookup(hostname), params.deadlineAtMonotonicMs);
    assertPublicNpmNetworkAddresses(addresses.map((answer) => answer.address), {
      allowPrivateNetwork: params.allowPrivateNetwork,
    });
    const selected = addresses[0]!;
    const options: RequestOptions = {
      protocol: 'https:', hostname, port: current.port || undefined,
      path: `${current.pathname}${current.search}`, method: 'GET', headers: params.headers,
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
      let deadlineTimer: NodeJS.Timeout | undefined;
      const request = params.request(options, (message) => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        resolve(message);
      });
      const remaining = deadlineRemainingMs(params.deadlineAtMonotonicMs);
      deadlineTimer = setTimeout(() => request.destroy(new Error('Npm registry request timed out')), remaining);
      const clearDeadline = () => { if (deadlineTimer) clearTimeout(deadlineTimer); };
      request.setTimeout(Math.min(params.timeoutMs, remaining), () => request.destroy(new Error('Npm registry request timed out')));
      request.once('error', (error) => { clearDeadline(); reject(error); });
      request.end();
    });
    const status = response.statusCode ?? 0;
    if (!REDIRECT_STATUSES.has(status)) {
      if (status < 200 || status >= 300) {
        response.resume();
        throw new NpmRegistryHttpError(status);
      }
      return response;
    }
    if (redirectCount >= params.maxRedirects) {
      response.resume();
      throw new Error(`Npm registry request exceeded ${params.maxRedirects} redirects`);
    }
    const location = response.headers.location;
    response.resume();
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
  timeoutMs?: number;
  maxRedirects?: number;
  lookup?: NpmDnsLookup;
  request?: typeof httpsRequest;
}>): NpmRegistryHttpsClient {
  const requiredOrigin = assertSafeNpmHttpsUrl(options.registryOrigin).origin;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error('Invalid npm registry network limits');
  }
  const lookup = options.lookup ?? defaultLookup;
  const request = options.request ?? httpsRequest;
  const baseHeaders: Readonly<Record<string, string>> = options.authorizationHeader ? { authorization: options.authorizationHeader } : {};

  async function open(input: Readonly<{ url: string; maxBytes: number; headers: Readonly<Record<string, string>>; deadlineAtMonotonicMs?: number }>): Promise<IncomingMessage> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new Error('Invalid npm registry response size limit');
    const deadlineAtMonotonicMs = input.deadlineAtMonotonicMs ?? performance.now() + timeoutMs;
    deadlineRemainingMs(deadlineAtMonotonicMs);
    const response = await openPinnedHttpsResponse({
      url: input.url, requiredOrigin, timeoutMs, deadlineAtMonotonicMs, maxRedirects, lookup, request,
      allowPrivateNetwork: options.allowPrivateNetwork === true,
      headers: { ...input.headers, ...baseHeaders },
    });
    attachBodyDeadline(response, deadlineAtMonotonicMs);
    let declared: number | undefined;
    try {
      assertHeadersWithinLimit(response.headers);
      declared = contentLength(response.headers);
    } catch (error) {
      response.destroy();
      throw error;
    }
    if (declared !== undefined && declared > input.maxBytes) {
      response.destroy();
      throw new Error(`Npm registry response exceeds the configured size limit (${input.maxBytes} bytes)`);
    }
    return response;
  }

  return {
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
        if (bytes > input.maxBytes) {
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
