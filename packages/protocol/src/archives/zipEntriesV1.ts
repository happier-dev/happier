export type ZipEntryV1 = Readonly<{ path: string; directory: boolean; unixMode?: number;
  compressedSize: number; uncompressedSize: number; read(): Promise<Uint8Array> }>;

/** One operation-local ZIP index; content is decoded only when its entry is read. */
export async function openZipEntriesV1(bytes: Uint8Array, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  try {
    const byPath = new Map<string, ZipEntryV1 | null>();
    const entries: ZipEntryV1[] = (await reader.getEntries()).map(entry => {
      const mode = entry.msDosCompatible ? undefined : entry.externalFileAttributes >>> 16;
      if (mode !== undefined && (mode & 0o170000) === 0o120000) throw Object.assign(new Error('unsupported_entry'), { code: 'unsupported_entry' });
      let decoded: Promise<Uint8Array> | undefined;
      const result: ZipEntryV1 = {
        path: entry.filename, directory: entry.directory, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize,
        ...(mode === undefined ? {} : { unixMode: mode & 0o7777 }),
        read() {
          signal?.throwIfAborted();
          if (entry.directory || !entry.getData) return Promise.reject(new Error('zip_entry_unreadable'));
          decoded ??= entry.getData(new Uint8ArrayWriter(), { checkSignature: true, signal });
          return decoded;
        },
      };
      // Preserve all-entry callers' archive order; selected lookup requires an
      // unambiguous resource rather than silently choosing a duplicate name.
      byPath.set(entry.filename, byPath.has(entry.filename) ? null : result);
      return result;
    });
    return {
      entries,
      read(path: string): Promise<Uint8Array> {
        const entry = byPath.get(path);
        return entry ? entry.read() : Promise.reject(new Error('zip_entry_unreadable'));
      },
      close: () => reader.close(),
    };
  } catch (error) { await reader.close(); throw error; }
}
