import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';

describe('resolveHappyHomeDirFromEnvironment', () => {
  it('returns an absolute override path unchanged', () => {
    expect(resolveHappyHomeDirFromEnvironment({ HAPPIER_HOME_DIR: '/tmp/happier-home' })).toBe('/tmp/happier-home');
  });

  it('prefers HAPPIER_HOME_DIR over HAPPIER_STACK_CLI_HOME_DIR when both are present', () => {
    expect(
      resolveHappyHomeDirFromEnvironment({
        HAPPIER_HOME_DIR: '/tmp/happier-home',
        HAPPIER_STACK_CLI_HOME_DIR: '/tmp/stack-cli-home',
      }),
    ).toBe('/tmp/happier-home');
  });

  it('resolves relative override paths to absolute paths', () => {
    expect(resolveHappyHomeDirFromEnvironment({ HAPPIER_HOME_DIR: 'relative-home' })).toBe(resolvePath('relative-home'));
  });

  it('falls back to HAPPIER_STACK_CLI_HOME_DIR when HAPPIER_HOME_DIR is missing', () => {
    expect(
      resolveHappyHomeDirFromEnvironment({
        HAPPIER_STACK_CLI_HOME_DIR: '/tmp/stack-cli-home',
        HOME: '/tmp/ignored-home',
      }),
    ).toBe('/tmp/stack-cli-home');
  });

  it('defaults to $HOME/.happier when HOME is present', () => {
    expect(resolveHappyHomeDirFromEnvironment({ HOME: '/tmp/home' })).toBe('/tmp/home/.happier');
  });

  it('falls back to os.homedir() when HOME and USERPROFILE are missing', () => {
    expect(resolveHappyHomeDirFromEnvironment({})).toBe(join(homedir(), '.happier'));
  });
});
