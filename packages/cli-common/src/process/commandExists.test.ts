import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { commandExistsOnPath } from './commandExists.js';

describe('commandExistsOnPath', () => {
  it.runIf(process.platform !== 'win32')('checks the supplied PATH without asking a login shell to replace it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-command-exists-'));
    try {
      const command = 'happier-test-custom-tool';
      await writeFile(join(root, command), '#!/bin/sh\nexit 0\n');
      await chmod(join(root, command), 0o755);
      expect(commandExistsOnPath(command, { env: { PATH: root } })).toBe(true);
      expect(commandExistsOnPath(command, { env: { PATH: '' } })).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('honors a supplied Windows Path instead of injecting the parent PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-windows-command-exists-'));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      await writeFile(join(root, 'happier-test-tool.cmd'), '@echo off\r\n');
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(commandExistsOnPath('happier-test-tool', { env: { Path: root, PATHEXT: '.CMD;.EXE' } })).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      await rm(root, { recursive: true, force: true });
    }
  });

});
