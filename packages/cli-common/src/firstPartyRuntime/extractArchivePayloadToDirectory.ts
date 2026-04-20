import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import extractZip from 'extract-zip';
import * as tar from 'tar';

type XzReadableStreamConstructor = new (compressedStream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;

let xzReadableStreamConstructorPromise: Promise<XzReadableStreamConstructor> | null = null;

async function resolveXzReadableStreamConstructor(): Promise<XzReadableStreamConstructor> {
    if (!xzReadableStreamConstructorPromise) {
        xzReadableStreamConstructorPromise = import('xz-decompress').then((module) => {
            const xzModule = module as Readonly<{
                XzReadableStream?: XzReadableStreamConstructor;
                default?: Readonly<{
                    XzReadableStream?: XzReadableStreamConstructor;
                }>;
            }>;
            const XzReadableStream = xzModule.XzReadableStream ?? xzModule.default?.XzReadableStream;
            if (!XzReadableStream) {
                throw new Error('[first-party-runtime] xz-decompress does not expose XzReadableStream');
            }
            return XzReadableStream;
        });
    }
    return await xzReadableStreamConstructorPromise;
}

async function extractTarXzArchiveToDirectory(params: Readonly<{
    archivePath: string;
    extractDir: string;
}>): Promise<void> {
    const source = createReadStream(params.archivePath);
    const XzReadableStream = await resolveXzReadableStreamConstructor();
    const decompressedStream = new XzReadableStream(Readable.toWeb(source));
    await pipeline(Readable.fromWeb(decompressedStream), tar.x({ cwd: params.extractDir, strict: true }));
}

export async function extractArchivePayloadToDirectory(params: Readonly<{
  archivePath: string;
  archiveName: string;
  extractDir: string;
}>): Promise<void> {
  await mkdir(params.extractDir, { recursive: true });

  const archiveName = params.archiveName.toLowerCase();
  if (archiveName.endsWith('.zip')) {
    await extractZip(params.archivePath, { dir: params.extractDir });
    return;
  }

  if (archiveName.endsWith('.tar.xz')) {
    await extractTarXzArchiveToDirectory({ archivePath: params.archivePath, extractDir: params.extractDir });
    return;
  }

  if (archiveName.endsWith('.tar.gz') || archiveName.endsWith('.tgz')) {
    await tar.x({
      file: params.archivePath,
      cwd: params.extractDir,
      strict: true,
    });
    return;
  }

  throw new Error(`[first-party-runtime] unsupported archive type: ${params.archiveName}`);
}
