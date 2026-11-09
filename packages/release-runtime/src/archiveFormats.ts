/// <reference path="./unbzip2-stream.d.ts" />

import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';

const ARCHIVE_FORMATS = [
  { suffix: '.zip', compression: 'zip' },
  { suffix: '.tar.gz', compression: 'gzip' },
  { suffix: '.tgz', compression: 'gzip' },
  { suffix: '.tar.xz', compression: 'xz' },
  { suffix: '.tar.bz2', compression: 'bzip2' },
  { suffix: '.tbz2', compression: 'bzip2' },
] as const;

/** Shared by extraction and release-asset dispatch; bare compression streams are not archives. */
export function resolveReleaseArchiveFormat(archiveName: string): typeof ARCHIVE_FORMATS[number] | null {
  const name = archiveName.toLowerCase();
  return ARCHIVE_FORMATS.find(({ suffix }) => name.endsWith(suffix)) ?? null;
}

export type TarArchiveCompression = Exclude<typeof ARCHIVE_FORMATS[number]['compression'], 'zip'>;

type XzReadableStreamConstructor = new (
  compressedStream: NodeReadableStream<Uint8Array>,
) => NodeReadableStream<Uint8Array>;

let xzReadableStreamConstructorPromise: Promise<XzReadableStreamConstructor> | null = null;

async function resolveXzReadableStreamConstructor(): Promise<XzReadableStreamConstructor> {
  if (!xzReadableStreamConstructorPromise) {
    xzReadableStreamConstructorPromise = import('xz-decompress').then((module) => {
      const xzModule = module as Readonly<{
        XzReadableStream?: XzReadableStreamConstructor;
        default?: Readonly<{ XzReadableStream?: XzReadableStreamConstructor }>;
      }>;
      const XzReadableStream = xzModule.XzReadableStream ?? xzModule.default?.XzReadableStream;
      if (!XzReadableStream) {
        throw new Error('[release-runtime] xz-decompress does not expose XzReadableStream');
      }
      return XzReadableStream;
    });
  }
  return await xzReadableStreamConstructorPromise;
}

export async function createTarDecompressionStreams(source: Readable, compression: TarArchiveCompression): Promise<Readable[]> {
  switch (compression) {
    case 'gzip':
      // Keep gzip teardown inside pipeline rather than node-tar's internal gunzip.
      return [source, createGunzip()];
    case 'xz': {
      const XzReadableStream = await resolveXzReadableStreamConstructor();
      return [Readable.fromWeb(new XzReadableStream(Readable.toWeb(source)))];
    }
    case 'bzip2': {
      const { default: unbzip2Stream } = await import('@openpgp/unbzip2-stream');
      return [Readable.fromWeb(unbzip2Stream(Readable.toWeb(source)))];
    }
  }
}
