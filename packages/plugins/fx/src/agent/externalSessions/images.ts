import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';

import { fxFile, isFxRecord } from './source.js';

type Image = NonNullable<AgentExternalSessionTranscriptItem['raw']['media']>[number];
type Images = Readonly<{ media: readonly Image[]; partial: boolean }>;

export const fxImageUnavailable = (text: string) => text ? `${text}\n[Image unavailable]` : '[Image unavailable]';

async function userImageSource(dir: string, value: unknown) {
  if (!isFxRecord(value) || typeof value.snapshot_path !== 'string'
    || !/^images\/[^/\\]+$/.test(value.snapshot_path)
    || typeof value.snapshot_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot_sha256)) {
    throw new Error('Unsupported native snapshot');
  }
  return { path: await fxFile(dir, 'images', value.snapshot_path.slice('images/'.length)),
    sha256: value.snapshot_sha256, mimeType: value.media_type };
}

async function toolImagePath(dir: string, handle: unknown): Promise<string> {
  if (typeof handle !== 'string' || !/^image-result-[A-Za-z0-9_-]+-[a-f0-9]{16}-[a-f0-9]{16}\.txt$/.test(handle)) {
    throw new Error('Unsupported native image handle');
  }
  return fxFile(dir, 'tool-results', handle);
}

/** Cursor currentness needs source descriptors and file revisions, never image bodies. */
export async function readFxImageSourceWitness(dir: string, values: unknown, handle: unknown, signal: AbortSignal): Promise<string> {
  const sources = values !== undefined
    ? Array.isArray(values) ? values : null
    : handle === undefined || handle === null ? [] : [handle];
  if (!sources) return 'invalid';
  const revisions = [];
  for (const source of sources) {
    signal.throwIfAborted();
    try {
      const path = values !== undefined ? (await userImageSource(dir, source)).path : await toolImagePath(dir, source);
      const info = await stat(path);
      revisions.push([info.dev, info.ino, info.birthtimeMs, info.ctimeMs, info.mtimeMs, info.size]);
    } catch {
      signal.throwIfAborted();
      revisions.push(null);
    }
  }
  return JSON.stringify(revisions);
}

// Source: fx v0.0.14@1a070af32cdf, image_data.zig:110–139. These are
// persisted native image formats; source_ref is never file/network authority.
function image(mimeType: unknown, bytes: Buffer): Image {
  const detected = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) ? 'image/gif'
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : null;
  if (!detected || mimeType !== detected) throw new Error('Unsupported native image');
  return { type: 'image', mimeType: detected, data: bytes.toString('base64') };
}

/** Hydrate only the session-owned snapshot, never the original attachment path. */
export async function readFxUserImages(dir: string, values: unknown, signal: AbortSignal): Promise<Images> {
  if (!Array.isArray(values)) return { media: [], partial: true };
  const media: Image[] = [];
  let partial = false;
  for (const value of values) {
    signal.throwIfAborted();
    try {
      const source = await userImageSource(dir, value);
      const bytes = await readFile(source.path);
      signal.throwIfAborted();
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Changed native snapshot');
      media.push(image(source.mimeType, bytes));
    } catch {
      signal.throwIfAborted();
      partial = true;
    }
  }
  return { media, partial };
}

/** v0.0.14 result_store.zig:257–288 authenticates the raw JSON pack by handle. */
export async function readFxToolImages(dir: string, handle: unknown, signal: AbortSignal): Promise<Images> {
  signal.throwIfAborted();
  if (handle === undefined || handle === null) return { media: [], partial: false };
  try {
    const bytes = await readFile(await toolImagePath(dir, handle));
    signal.throwIfAborted();
    if (typeof handle !== 'string' || !handle.endsWith(`-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.txt`)) {
      throw new Error('Changed native image pack');
    }
    const values: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(values)) throw new Error('Unsupported native image pack');
    const media: Image[] = [];
    let partial = values.length === 0;
    for (const value of values) {
      if (!isFxRecord(value) || value.type !== 'image' || typeof value.data !== 'string') { partial = true; continue; }
      try {
        const decoded = Buffer.from(value.data, 'base64');
        if (decoded.toString('base64') !== value.data) throw new Error('Invalid image encoding');
        media.push(image(value.mimeType, decoded));
      } catch { partial = true; }
    }
    return { media, partial };
  } catch {
    signal.throwIfAborted();
    return { media: [], partial: true };
  }
}
