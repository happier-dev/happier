import { request } from 'node:https';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function verifyPinnedCertificate(certificate: PeerCertificate, tlsCertificateSha256: string): Error | undefined {
  const presented = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  return presented === tlsCertificateSha256
    ? undefined
    : new Error('TLS certificate does not match the pinned fingerprint');
}

/**
 * A `fetch` that talks only to a server presenting one exact TLS certificate.
 *
 * `tlsCertificateSha256` is the leaf certificate's SHA-256 fingerprint in the form Claude Code pins
 * gateways with (lowercase hex, no colons). The standard chain and hostname checks still run:
 * Node calls `checkServerIdentity` only after the chain verifies, so the pin narrows normal trust
 * instead of replacing it. `agent: false` gives each request its own handshake, because a resumed
 * TLS session skips `checkServerIdentity`. Credential headers are written only after the handshake
 * passes. Redirects are returned, never followed.
 */
export function createCertificatePinnedFetch(tlsCertificateSha256: string): typeof fetch {
  const pinned = tlsCertificateSha256.toLowerCase();
  return async (input, init) => {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      throw new TypeError('Certificate-pinned fetch accepts a URL, not a Request');
    }
    const url = new URL(input);
    if (url.protocol !== 'https:') throw new TypeError('Certificate-pinned fetch requires https');

    return await new Promise<Response>((resolve, reject) => {
      const outgoing = request(url, {
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(init?.signal ? { signal: init.signal } : {}),
        agent: false,
        // Explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 cannot turn a failed pin into a warning.
        rejectUnauthorized: true,
        checkServerIdentity: (hostname, certificate) =>
          checkServerIdentity(hostname, certificate) ?? verifyPinnedCertificate(certificate, pinned),
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('error', reject);
        // After `end` has resolved, this reject is a no-op; before it, the body was cut short.
        incoming.once('close', () => reject(new Error('Response closed before it completed')));
        incoming.once('end', () => {
          try {
            const status = incoming.statusCode ?? 0;
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
                headers.append(name, item);
              }
            }
            resolve(new Response(NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks), {
              status,
              statusText: incoming.statusMessage ?? '',
              headers,
            }));
          } catch (error) {
            reject(error);
          }
        });
      });
      outgoing.once('error', reject);
      outgoing.end();
    });
  };
}
