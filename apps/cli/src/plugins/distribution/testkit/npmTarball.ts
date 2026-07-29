import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

export type TestTarEntry = Readonly<{
  name: string;
  body?: string | Uint8Array;
  type?: 'file' | 'directory' | 'symlink' | 'link' | 'character-device' | 'block-device' | 'fifo' | 'extended-header';
  linkname?: string;
}>;

export async function createTestNpmTarball(entries: readonly TestTarEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = typeof entry.body === 'string' ? Buffer.from(entry.body) : Buffer.from(entry.body ?? []);
    const hasBody = entry.type === undefined || entry.type === 'file' || entry.type === 'extended-header';
    const fileBody = hasBody ? body : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, entry.type === 'directory' ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, fileBody.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, typeFlag(entry.type ?? 'file'));
    if (entry.linkname) writeString(header, 157, 100, entry.linkname);
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, '0');
    writeString(header, 148, 6, checksumText);
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, fileBody);
    const padding = (512 - (fileBody.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipAsync(Buffer.concat(chunks));
}

function writeString(target: Buffer, offset: number, maxBytes: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > maxBytes) throw new Error(`Test tar field exceeds ${maxBytes} bytes`);
  bytes.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, width: number, value: number): void {
  const text = value.toString(8).padStart(width - 1, '0');
  writeString(target, offset, width - 1, text);
  target[offset + width - 1] = 0;
}

function typeFlag(type: NonNullable<TestTarEntry['type']>): string {
  switch (type) {
    case 'file': return '0';
    case 'link': return '1';
    case 'symlink': return '2';
    case 'character-device': return '3';
    case 'block-device': return '4';
    case 'directory': return '5';
    case 'fifo': return '6';
    case 'extended-header': return 'x';
  }
}

export function sriSha512(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}
