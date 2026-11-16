import { decodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { computeSha256HexDigest } from '@happier-dev/plugin-sdk';

const encoder = new TextEncoder();
const padded = (length: number) => Math.ceil(length / 512) * 512;

/** E2B's COPY upload is a tar archive, keyed by a lowercase SHA-256 digest.
 * Use the SDK's portable digest so Account runtimes share the same bytes.
 * GNU long-name records preserve valid supplier paths beyond USTAR's name field. */
export function createE2bBuildContext(files: readonly Readonly<{ path: string; contentsBase64: string }>[]) {
  const records: { path: string; contents: Uint8Array; type: string }[] = [];
  for (const file of files) {
    if (encoder.encode(file.path).length > 100) {
      records.push({ path: '././@LongLink', contents: encoder.encode(file.path + '\0'), type: 'L' });
    }
    records.push({ path: encoder.encode(file.path).length > 100 ? 'file' : file.path, contents: decodeBase64(file.contentsBase64), type: '0' });
  }
  const bytes = new Uint8Array(records.reduce((size, record) => size + 512 + padded(record.contents.length), 1024));
  let offset = 0;
  for (const record of records) {
    const header = bytes.subarray(offset, offset + 512);
    const text = (value: string, start: number) => header.set(encoder.encode(value), start);
    const octal = (value: number, start: number, width: number) => text(value.toString(8).padStart(width - 1, '0') + '\0', start);
    text(record.path, 0); octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(record.contents.length, 124, 12); octal(0, 136, 12); text('        ', 148);
    text(record.type, 156); text('ustar\0', 257); text('00', 263);
    text(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    bytes.set(record.contents, offset + 512);
    offset += 512 + padded(record.contents.length);
  }
  return { bytes, hash: computeSha256HexDigest(bytes) };
}
