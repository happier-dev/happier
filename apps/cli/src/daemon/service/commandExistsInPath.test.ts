import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { commandExistsInPath } from './commandExistsInPath';

describe('commandExistsInPath', () => {
  it('detects unix commands by exact filename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-cli-cmd-'));
    try {
      await writeFile(join(dir, 'hello'), '#!/bin/sh\necho hi\n', 'utf8');
      expect(commandExistsInPath({ cmd: 'hello', envPath: dir, platform: 'linux' })).toBe(true);
      expect(commandExistsInPath({ cmd: 'missing', envPath: dir, platform: 'linux' })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects windows commands via PATHEXT fallbacks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-cli-cmdwin-'));
    try {
      await writeFile(join(dir, 'schtasks.exe'), 'binary', 'utf8');
      expect(commandExistsInPath({ cmd: 'schtasks', envPath: dir, platform: 'win32', pathext: '.EXE;.CMD' })).toBe(true);
      expect(commandExistsInPath({ cmd: 'schtasks.exe', envPath: dir, platform: 'win32', pathext: '.EXE;.CMD' })).toBe(true);
      expect(commandExistsInPath({ cmd: 'missing', envPath: dir, platform: 'win32', pathext: '.EXE;.CMD' })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

