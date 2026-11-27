import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

import { resolveUrlConnectionIdentity } from './urlConnectionIdentity';

export type PinnedHttpStreamRequest = Readonly<{
  url: string;
  validatedAddresses: readonly string[];
  tlsCertificateSha256?: string;
  headers: Readonly<Record<string, string>>;
  method?: string;
  body?: Uint8Array;
  signal: AbortSignal;
  wallTimeMs?: number;
  idleTimeMs?: number;
}>;

export type PinnedHttpStreamResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  contentLength: number | null;
  read: () => Promise<Uint8Array | null>;
  cancel: () => void;
}>;

export type PinnedHttpStreamTransport = (
  request: PinnedHttpStreamRequest,
) => Promise<PinnedHttpStreamResponse>;

export type PinnedHttpStreamDependencies = Readonly<{
  httpRequest?: typeof httpRequest;
  httpsRequest?: typeof httpsRequest;
}>;

function pinnedRequestHeaders(
  url: URL,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array | undefined,
): Readonly<Record<string, string>> {
  const hasBodyFraming = Object.keys(headers).some((name) => (
    name.toLowerCase() === 'content-length' || name.toLowerCase() === 'transfer-encoding'
  ));
  return Object.freeze({
    ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'host')),
    // Node does not add framing for every method (notably DELETE). These
    // complete bytes otherwise reach the peer as an unframed request body.
    ...(body !== undefined && !hasBodyFraming ? { 'content-length': String(body.byteLength) } : {}),
    host: url.host,
  });
}

/**
 * Low-level connection owner shared by callers that already validated DNS.
 * The socket lookup can return only one of the caller-supplied addresses while
 * TLS SNI and certificate verification continue to use the original hostname.
 */
export function openPinnedHttpStream(
  input: PinnedHttpStreamRequest,
  dependencies: PinnedHttpStreamDependencies = {},
): Promise<PinnedHttpStreamResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const connectionIdentity = resolveUrlConnectionIdentity(url.hostname);
    const pinnedAddress = input.validatedAddresses[0];
    if (!pinnedAddress) {
      reject(new Error('pinned_http_validated_address_required'));
      return;
    }

    const { tlsCertificateSha256 } = input;
    if (tlsCertificateSha256 !== undefined && url.protocol !== 'https:') {
      reject(new Error('pinned_http_tls_certificate_requires_https'));
      return;
    }

    let settled = false;
    const requestBoundary = url.protocol === 'https:'
      ? dependencies.httpsRequest ?? httpsRequest
      : dependencies.httpRequest ?? httpRequest;
    const request = requestBoundary({
      protocol: url.protocol,
      hostname: connectionIdentity.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: input.method ?? 'GET',
      headers: pinnedRequestHeaders(url, input.headers, input.body),
      // A pooled socket was admitted for the address set of an earlier request.
      // Reusing it would bypass this request's fresh DNS admission entirely.
      agent: false,
      ...(tlsCertificateSha256 === undefined ? {} : {
        rejectUnauthorized: true,
        checkServerIdentity: (hostname: string, certificate: PeerCertificate) =>
          checkServerIdentity(hostname, certificate)
          ?? (certificate.fingerprint256.replaceAll(':', '').toLowerCase() === tlsCertificateSha256
            ? undefined
            : new Error('pinned_http_tls_certificate_mismatch')),
      }),
      ...(url.protocol === 'https:' && connectionIdentity.servername !== undefined
        ? { servername: connectionIdentity.servername }
        : {}),
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all === true) {
          callback(null, input.validatedAddresses.map((address) => ({
            address,
            family: address.includes(':') ? 6 as const : 4 as const,
          })));
          return;
        }
        callback(null, pinnedAddress, pinnedAddress.includes(':') ? 6 : 4);
      },
      signal: input.signal,
    }, (response) => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      const parsedLength = Number.parseInt(headers['content-length'] ?? '', 10);
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let terminalError: Error | null = null;
      const resetIdle = () => {
        if (input.idleTimeMs === undefined) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          terminalError = new Error('pinned_http_idle_timeout');
          request.destroy(terminalError);
        }, input.idleTimeMs);
        idleTimer.unref?.();
      };
      resetIdle();
      const iterator = response[Symbol.asyncIterator]();
      settled = true;
      resolve({
        status: response.statusCode ?? 0,
        headers,
        contentLength: Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : null,
        read: async () => {
          resetIdle();
          let next: IteratorResult<Buffer>;
          try {
            next = await iterator.next();
          } catch (error) {
            throw terminalError ?? error;
          }
          resetIdle();
          if (next.done) {
            if (idleTimer) clearTimeout(idleTimer);
            return null;
          }
          return next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        },
        cancel: () => {
          if (idleTimer) clearTimeout(idleTimer);
          response.destroy();
        },
      });
    });

    const wallTimer = input.wallTimeMs === undefined
      ? null
      : setTimeout(() => request.destroy(new Error('pinned_http_wall_timeout')), input.wallTimeMs);
    wallTimer?.unref?.();
    request.once('close', () => {
      if (wallTimer) clearTimeout(wallTimer);
    });
    request.once('error', (error) => {
      if (!settled) reject(error);
    });
    request.end(input.body);
  });
}
