import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { writeTextFile } from '@/testkit/fs/fileHelpers';
import { withTempDir } from '@/testkit/fs/tempDir';
import { commandExistsInPath } from './commandExistsInPath.js';

describe('commandExistsInPath', () => {
  it('detects unix commands by exact filename', async () => {
    await withTempDir('happier-cli-cmd-', async (dir) => {
      await writeTextFile(join(dir, 'hello'), '#!/bin/sh\necho hi\n');
      expect(commandExistsInPath({ cmd: 'hello', envPath: dir, platform: 'linux' })).toBe(true);
      expect(commandExistsInPath({ cmd: 'missing', envPath: dir, platform: 'linux' })).toBe(false);
    });
  });

  it('detects windows commands via PATHEXT fallbacks', async () => {
    await withTempDir('happier-cli-cmdwin-', async (dir) => {
      await writeTextFile(join(dir, 'schtasks.exe'), 'binary');
      expect(commandExistsInPath({ cmd: 'schtasks', envPath: dir, platform: 'win32', pathext: '.EXE;.CMD' })).toBe(true);
      expect(commandExistsInPath({ cmd: 'schtasks.exe', envPath: dir, platform: 'win32', pathext: '.EXE;.CMD' })).toBe(true);
      expect(commandExistsInPath({ cmd: 'missing', envPath: dir, platform: 'win32', pathext: '.EXE;.CMD' })).toBe(false);
    });
  });
});
