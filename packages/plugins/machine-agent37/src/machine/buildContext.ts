import { decodeBase64 } from '@happier-dev/plugin-sdk/protocol';

const encoder = new TextEncoder();
const invalid = () => new Error('agent37_context_invalid');

/** Agent37 requires a gzipped USTAR context with Dockerfile at its root.
 * Only supplier-projected files enter it; never archive the host checkout. */
export async function createAgent37BuildContext(dockerfile: string, files: readonly Readonly<{ path: string; contentsBase64: string }>[]): Promise<Uint8Array<ArrayBuffer>> {
  const names = new Set(['Dockerfile']);
  const entries = [{ path: 'Dockerfile', bytes: encoder.encode(dockerfile) }, ...files.map(file => {
    if (!file.path || /[\\\0\r\n]/.test(file.path) || file.path.startsWith('/')
      || file.path.split('/').some(part => !part || part === '.' || part === '..') || names.has(file.path)) throw invalid();
    names.add(file.path);
    return { path: file.path, bytes: decodeBase64(file.contentsBase64) };
  })];
  const chunks: Uint8Array[] = [];
  for (const file of entries) {
    const archive = new Uint8Array(512 + Math.ceil(file.bytes.length / 512) * 512);
    let name = file.path, prefix = '';
    // These widths belong to USTAR, rather than an adapter payload policy.
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
    octal(file.bytes.length, 124, 12); octal(0, 136, 12); text('        ', 148, 8);
    text('0', 156, 1); text('ustar\0', 257, 6); text('00', 263, 2); text(prefix, 345, 155);
    text(archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    archive.set(file.bytes, 512);
    chunks.push(archive);
  }
  const archive = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 1024));
  let offset = 0;
  for (const chunk of chunks) { archive.set(chunk, offset); offset += chunk.length; }
  const result = new Uint8Array(await new Response(new Blob([archive]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  // POST size_bytes accepts 1..1,000,000,000, per templates API (2026-11-16).
  if (result.length > 1_000_000_000) throw new Error('agent37_context_too_large');
  return result;
}
