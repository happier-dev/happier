import { expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { openZipEntriesV1 } from './zipEntriesV1.js';

it('uses one case-insensitive match only when the exact entry is missing', async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [path, value] of [['Theme.json', 1], ['include/Base.json', 2], ['include/base.json', 3]] as const) {
    await writer.add(path, new Uint8ArrayReader(new Uint8Array([value])), { useWebWorkers: false });
  }
  const archive = await openZipEntriesV1(await writer.close());
  try {
    const exact = await archive.read('Theme.json');
    expect(await archive.read('theme.json')).toBe(exact);
    expect(await archive.read('include/Base.json')).toEqual(new Uint8Array([2]));
    expect(await archive.read('include/base.json')).toEqual(new Uint8Array([3]));
    await expect(archive.read('include/BASE.json')).rejects.toThrow('zip_entry_unreadable');
    await expect(archive.read('missing.json')).rejects.toThrow('zip_entry_unreadable');
  } finally { await archive.close(); }
});

it('indexes unrelated compressed entries without decoding them and reuses selected bytes', async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const selected = new Uint8Array([0, 255, 128, 65]);
  await writer.add('theme.bin', new Uint8ArrayReader(selected), { useWebWorkers: false, level: 0,
    externalFileAttributes: ((0o100000 | 0o755) << 16) >>> 0, msDosCompatible: false });
  await writer.add('unrelated.bin', new Uint8ArrayReader(new Uint8Array(500000)), { useWebWorkers: false });
  const bytes = await writer.close();
  // Damage only the unrelated local entry's compressed stream. Its directory
  // remains valid; a whole-archive decode cannot produce the selected result.
  const signature = [0x50, 0x4b, 0x03, 0x04];
  let entry = 0;
  for (let i = 0; i < bytes.length - 30; i++) if (signature.every((value, offset) => bytes[i + offset] === value)) {
    if (++entry === 2) { const view = new DataView(bytes.buffer, bytes.byteOffset + i); const start = i + 30 + view.getUint16(26, true) + view.getUint16(28, true); bytes[start] ^= 0xff; break; }
  }
  const archive = await openZipEntriesV1(bytes);
  try {
    expect(archive.entries).toHaveLength(2);
    expect(archive.entries[0]).toMatchObject({ path: 'theme.bin', unixMode: 0o755 });
    const first = await archive.read('theme.bin');
    expect(first).toEqual(selected);
    expect(await archive.read('theme.bin')).toBe(first);
    await expect(archive.read('unrelated.bin')).rejects.toThrow();
  } finally { await archive.close(); }
});
