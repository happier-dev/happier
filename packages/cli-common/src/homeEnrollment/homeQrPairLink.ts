import { inspectHomeQrInviteV2Payload } from '@happier-dev/protocol/crypto/qrProvisioningV2';

export function inspectHomeQrPairLink(
  rawLink: string,
  acceptsProtocol: (protocol: string) => boolean,
  nowMs = Date.now(),
): ReturnType<typeof inspectHomeQrInviteV2Payload> {
  let url: URL;
  try {
    url = new URL(rawLink);
  } catch {
    return null;
  }
  if (!acceptsProtocol(url.protocol) || url.hash) return null;
  const { pathname, hostname, searchParams } = url;
  if (pathname !== '/pair' && pathname !== 'pair'
    && !(hostname === 'pair' && (pathname === '' || pathname === '/'))) return null;
  if ([...searchParams.entries()].length !== 2 || searchParams.get('v') !== '2') return null;
  return inspectHomeQrInviteV2Payload(searchParams.get('payload') ?? '', { nowMs });
}
