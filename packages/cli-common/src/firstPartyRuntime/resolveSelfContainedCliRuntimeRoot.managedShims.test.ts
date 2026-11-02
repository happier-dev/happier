import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSelfContainedCliRuntimeRootPath } from './resolveSelfContainedCliRuntimeRoot.js';


describe('managed shim runtime roots', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createHappierHome(releaseChannel?: string): string {
    const home = mkdtempSync(join(tmpdir(), 'happier-self-contained-root-'));
    tempRoots.push(home);
    mkdirSync(join(home, 'bin'));
    if (releaseChannel) {
      writeFileSync(join(home, 'default-cli-release-channel.json'), JSON.stringify({ releaseChannel }));
    }
    return home;
  }

  it.each([
    ['preview', 'cli-preview'],
    ['publicdev', 'cli-dev'],
  ])('follows the default %s release channel recorded beside the shim', (channel, installRoot) => {
    const home = createHappierHome(channel);
    expect(resolveSelfContainedCliRuntimeRootPath(join(home, 'bin', 'happier.exe'))).toBe(
      join(home, installRoot, 'current'),
    );
  });

  it('uses stable when the default release channel is not recorded', () => {
    const home = createHappierHome();
    expect(resolveSelfContainedCliRuntimeRootPath(join(home, 'bin', 'happier'))).toBe(join(home, 'cli', 'current'));
  });

  it.each([
    ['hprev', 'cli-preview'],
    ['happier-preview.exe', 'cli-preview'],
    ['hdev.exe', 'cli-dev'],
    ['happier-dev', 'cli-dev'],
  ])('keeps the %s channel shim independent of the default', (shim, installRoot) => {
    const home = createHappierHome('stable');
    expect(resolveSelfContainedCliRuntimeRootPath(join(home, 'bin', shim))).toBe(join(home, installRoot, 'current'));
  });

  it('uses current.version without traversing the current junction', () => {
    const home = createHappierHome('preview');
    mkdirSync(join(home, 'cli-preview'));
    writeFileSync(join(home, 'cli-preview', 'current.version'), 'version-a\n');
    expect(resolveSelfContainedCliRuntimeRootPath(join(home, 'bin', 'happier.exe'))).toBe(
      join(home, 'cli-preview', 'versions', 'version-a'),
    );
  });

  it('normalizes Windows separators before recognizing the shim home', () => {
    const home = createHappierHome('preview');
    const shim = join(home, 'bin', 'happier.exe').replaceAll('/', '\\');
    expect(resolveSelfContainedCliRuntimeRootPath(shim)).toBe(join(home, 'cli-preview', 'current'));
  });
});
