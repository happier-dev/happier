import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSelfContainedCliRuntimeRootPath } from './resolveSelfContainedCliRuntimeRoot.js';

describe('resolveSelfContainedCliRuntimeRootPath', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createHappierHome(defaultReleaseChannel?: string): string {
    const root = mkdtempSync(join(tmpdir(), 'happier-self-contained-root-'));
    tempRoots.push(root);
    const happierHomeDir = join(root, '.happier');
    mkdirSync(join(happierHomeDir, 'bin'), { recursive: true });
    if (defaultReleaseChannel) {
      writeFileSync(
        join(happierHomeDir, 'default-cli-release-channel.json'),
        `${JSON.stringify({ releaseChannel: defaultReleaseChannel })}\n`,
        'utf8',
      );
    }
    return happierHomeDir;
  }

  it('resolves the default happier shim to the default release channel install', () => {
    const happierHomeDir = createHappierHome('preview');

    expect(resolveSelfContainedCliRuntimeRootPath(join(happierHomeDir, 'bin', 'happier.exe'))).toBe(
      join(happierHomeDir, 'cli-preview', 'current'),
    );
  });

  it('resolves the default happier shim to the stable install when no default channel is recorded', () => {
    const happierHomeDir = createHappierHome();

    expect(resolveSelfContainedCliRuntimeRootPath(join(happierHomeDir, 'bin', 'happier'))).toBe(
      join(happierHomeDir, 'cli', 'current'),
    );
  });

  it('resolves a channel shim to its own install regardless of the default channel', () => {
    const happierHomeDir = createHappierHome('preview');

    expect(resolveSelfContainedCliRuntimeRootPath(join(happierHomeDir, 'bin', 'hdev'))).toBe(
      join(happierHomeDir, 'cli-dev', 'current'),
    );
  });
});
