import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { mirrorHostAuthStateForProvider } from '../../src/testkit/providers/harness';

describe('providers harness: host auth mirroring', () => {
  it('does not mirror provider host auth directory in host mode', async () => {
    const hostHome = await mkdtemp(join(tmpdir(), 'happier-host-home-'));
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const sourceDir = join(hostHome, '.kimi');
    const sourceFile = join(sourceDir, 'credentials.json');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(sourceFile, '{"token":"abc"}\n', 'utf8');

    await mirrorHostAuthStateForProvider({
      providerSubcommand: 'kimi',
      mode: 'host',
      hostHomeDir: hostHome,
      cliHome,
    });

    expect(existsSync(join(cliHome, '.kimi'))).toBe(false);
  });

  it('does not mirror host auth directory in env mode', async () => {
    const hostHome = await mkdtemp(join(tmpdir(), 'happier-host-home-'));
    const cliHome = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const sourceDir = join(hostHome, '.kimi');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'credentials.json'), '{"token":"abc"}\n', 'utf8');

    await mirrorHostAuthStateForProvider({
      providerSubcommand: 'kimi',
      mode: 'env',
      hostHomeDir: hostHome,
      cliHome,
    });

    expect(existsSync(join(cliHome, '.kimi'))).toBe(false);
  });
});
