import { describe, expect, it } from 'vitest';

import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';

import { ensureSshAskpassScriptPath } from './sshAskpass.js';

describe('ensureSshAskpassScriptPath', () => {
  it('creates a user-scoped executable script under tmpdir and returns a stable path', () => {
    const first = ensureSshAskpassScriptPath();
    const second = ensureSshAskpassScriptPath();

    expect(second).toBe(first);
    expect(first.startsWith(tmpdir())).toBe(true);
    expect(basename(first)).toBe('askpass.sh');

    const stat = statSync(first);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('writes a Windows-compatible askpass helper when the platform override is win32', () => {
    const path = ensureSshAskpassScriptPath('win32');
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(basename(path)).toBe('askpass.cmd');
    const stat = statSync(path);
    expect(stat.isFile()).toBe(true);
  });
});
