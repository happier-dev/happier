import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';

describe('resolveHappyHomeDirFromEnvironment', () => {
  it('returns an absolute override path unchanged', () => {
    expect(resolveHappyHomeDirFromEnvironment({ HAPPIER_HOME_DIR: '/tmp/happier-home' })).toBe('/tmp/happier-home');
  });

  it('resolves relative override paths to absolute paths', () => {
    expect(resolveHappyHomeDirFromEnvironment({ HAPPIER_HOME_DIR: 'relative-home' })).toBe(resolvePath('relative-home'));
  });

  it('defaults to $HOME/.happier when HOME is present', () => {
    expect(resolveHappyHomeDirFromEnvironment({ HOME: '/tmp/home' })).toBe('/tmp/home/.happier');
  });

  it('falls back to os.homedir() when HOME and USERPROFILE are missing', () => {
    expect(resolveHappyHomeDirFromEnvironment({})).toBe(join(homedir(), '.happier'));
  });
});
