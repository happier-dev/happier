declare module '@openpgp/unbzip2-stream' {
  import type { ReadableStream } from 'node:stream/web';

  // The pure-JS package exposes this Web Streams boundary without bundled types.
  export default function unbzip2Stream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
}
