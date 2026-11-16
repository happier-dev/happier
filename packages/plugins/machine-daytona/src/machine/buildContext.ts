import { computeSha256HexDigest } from '@happier-dev/plugin-sdk';
import { computeHttpContentMd5Hex, computeHttpHmacSha256 } from '@happier-dev/plugin-sdk/http';
import { decodeBase64 } from '@happier-dev/plugin-sdk/protocol';

export type DaytonaStorageCredentials = Readonly<{ accessKey: string; secret: string; sessionToken?: string; region: string }>;
const encoder = new TextEncoder();
const invalid = () => new Error('daytona_snapshot_context_invalid');

/** Match SDK 0.231.1 ObjectStorage's single-file archivePath+contents MD5 and portable tar. */
export function createDaytonaContextFile(file: Readonly<{ path: string; contentsBase64: string }>): { hash: string; bytes: Uint8Array<ArrayBuffer> } {
  if (!file.path || file.path.startsWith('/') || file.path.includes('\0') || file.path.split('/').includes('..')) throw invalid();
  const contents = decodeBase64(file.contentsBase64);
  const archive = new Uint8Array(512 + Math.ceil(contents.length / 512) * 512 + 1024);
  let name = file.path, prefix = '';
  // USTAR has a 100-byte name and 155-byte prefix, rather than a local policy cap.
  if (encoder.encode(name).length > 100) {
    for (let slash = file.path.lastIndexOf('/'); slash > 0; slash = file.path.lastIndexOf('/', slash - 1)) {
      if (encoder.encode(file.path.slice(slash + 1)).length <= 100 && encoder.encode(file.path.slice(0, slash)).length <= 155) {
        name = file.path.slice(slash + 1); prefix = file.path.slice(0, slash); break;
      }
    }
  }
  const text = (value: string, offset: number, width: number) => {
    const bytes = encoder.encode(value);
    if (bytes.length > width) throw invalid();
    archive.set(bytes, offset);
  };
  const octal = (value: number, offset: number, width: number) => text(value.toString(8).padStart(width - 1, '0') + '\0', offset, width);
  text(name, 0, 100); octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(contents.length, 124, 12); octal(0, 136, 12); text('        ', 148, 8);
  text('0', 156, 1); text('ustar\0', 257, 6); text('00', 263, 2); text(prefix, 345, 155);
  const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  text(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  archive.set(contents, 512);
  return { hash: computeHttpContentMd5Hex([file.path, contents]), bytes: archive };
}

const uri = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
const sha256 = computeSha256HexDigest;
const hmac = computeHttpHmacSha256;

/** S3 SigV4 signed payload, including the vendor-issued temporary session token.
 * https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html */
export function signDaytonaStoragePut(input: Readonly<{ url: URL; body: Uint8Array; credentials: DaytonaStorageCredentials;
  at: Date; headers?: Readonly<Record<string, string>> }>): Record<string, string> {
  const timestamp = input.at.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8), scope = `${date}/${input.credentials.region}/s3/aws4_request`;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  Object.assign(headers, { host: input.url.host, 'x-amz-content-sha256': sha256(input.body), 'x-amz-date': timestamp });
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;
  const names = Object.keys(headers).sort(), signedHeaders = names.join(';');
  const query = [...input.url.searchParams].map(([key, value]) => [uri(key), uri(value)] as const)
    .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('&');
  const path = input.url.pathname.split('/').map(part => uri(decodeURIComponent(part))).join('/');
  const canonical = ['PUT', path, query, names.map(name => name + ':' + headers[name] + '\n').join(''), signedHeaders, headers['x-amz-content-sha256']].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + input.credentials.secret, date), input.credentials.region), 's3'), 'aws4_request');
  const signature = Array.from(hmac(key, 'AWS4-HMAC-SHA256\n' + timestamp + '\n' + scope + '\n' + sha256(canonical)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKey}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return headers;
}
