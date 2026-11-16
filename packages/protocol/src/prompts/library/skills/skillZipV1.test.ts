import { expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { decodeBase64 } from '../../../crypto/base64.js';
import { exportSkillBundlesAsZipV1, readSkillZipFilesV1 } from './skillZipV1.js';

it('exports Agent Skills folders with exact bytes and executable mode readable by the real ZIP consumer', async () => {
  const archive = await exportSkillBundlesAsZipV1([{ name: 'sample', files: [
    { path: 'SKILL.md', contentBase64: 'eA==', contentKind: 'utf8' },
    { path: 'scripts/run', contentBase64: 'eQ==', contentKind: 'utf8', unixMode: 0o755 },
    { path: 'asset.bin', contentBase64: 'AP+AQQ==', contentKind: 'binary' },
  ] }]);
  expect(archive.fileName).toBe('sample.zip');
  expect(await readSkillZipFilesV1(decodeBase64(archive.bytes))).toEqual([
    { path: 'sample/SKILL.md', contentBase64: 'eA==', contentKind: 'utf8', unixMode: 0o644 },
    { path: 'sample/scripts/run', contentBase64: 'eQ==', contentKind: 'utf8', unixMode: 0o755 },
    { path: 'sample/asset.bin', contentBase64: 'AP+AQQ==', contentKind: 'binary', unixMode: 0o644 },
  ]);
});

it('refuses a symbolic link without following or materializing it', async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add('link', new Uint8ArrayReader(new TextEncoder().encode('../outside')), {
    useWebWorkers: false, msDosCompatible: false, externalFileAttributes: ((0o120000 | 0o777) << 16) >>> 0,
  });
  await expect(readSkillZipFilesV1(await writer.close())).rejects.toMatchObject({ code: 'unsupported_entry' });
});
