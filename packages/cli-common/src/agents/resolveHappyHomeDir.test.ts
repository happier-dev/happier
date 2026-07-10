import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';

function resolveOriginalPlatformDescriptor(): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) {
    throw new Error('process.platform descriptor is unavailable');
  }
  return descriptor;
}

const originalPlatformDescriptor: PropertyDescriptor = resolveOriginalPlatformDescriptor();

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
}

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

  it('preserves Windows-shaped absolute overrides on Windows', () => {
    withPlatform('win32', () => {
      expect(resolveHappyHomeDirFromEnvironment({
        HAPPIER_HOME_DIR: 'C:\\Users\\tester\\.happier-custom',
        USERPROFILE: 'C:\\Users\\tester',
      })).toBe('C:\\Users\\tester\\.happier-custom');
    });
  });

  it('rejects Windows-shaped absolute overrides on non-Windows hosts', () => {
    withPlatform('darwin', () => {
      expect(() => resolveHappyHomeDirFromEnvironment({
        HAPPIER_HOME_DIR: 'C:\\Users\\tester\\.happier-custom',
        HOME: '/Users/tester',
      })).toThrow(/windows/i);
    });
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
