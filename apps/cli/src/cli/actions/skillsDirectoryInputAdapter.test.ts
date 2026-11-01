import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readSkillDirectoryInputV1 } from './skillsDirectoryInputAdapter';

it('reads nested bytes and the actual executable mode at the filesystem boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-skill-input-'));
  try {
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'SKILL.md'), '---\nname: sample\n---\nBody');
    await writeFile(join(dir, 'scripts', 'payload.bin'), Buffer.from([0xff, 0x00, 0x80]));
    await writeFile(join(dir, 'scripts', 'run'), '#!/bin/sh\nexit 0');
    await chmod(join(dir, 'scripts', 'run'), 0o755);
    const files = await readSkillDirectoryInputV1(dir);
    expect(files).toHaveLength(3);
    expect(files.map(file => ({
      path: file.path,
      contentKind: file.contentKind,
      bytes: Buffer.from(file.contentBase64, 'base64'),
    }))).toEqual(expect.arrayContaining([
      { path: 'SKILL.md', contentKind: 'utf8', bytes: Buffer.from('---\nname: sample\n---\nBody') },
      { path: 'scripts/payload.bin', contentKind: 'binary', bytes: Buffer.from([0xff, 0x00, 0x80]) },
      { path: 'scripts/run', contentKind: 'utf8', bytes: Buffer.from('#!/bin/sh\nexit 0') },
    ]));
    expect(files.find(file => file.path === 'scripts/run')).toMatchObject({ contentKind: 'utf8', unixMode: 0o755 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
