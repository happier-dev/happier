import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildServerBinaryArtifactPayload } from './buildServerBinaryArtifactPayload.js';
import { SERVER_BINARY_TARGETS, resolveCurrentBinaryTarget } from './targets.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('buildServerBinaryArtifactPayload', () => {
  // A Bun-compiled executable's import.meta.url is the virtual /$bunfs root, so the server reads
  // public-profile faces beside the executable. The payload must stage every face there.
  it('stages every public-profile face beside the server executable', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'server-binary-public-profile-'));
    tempRoots.push(tempRoot);
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const fontSourceDir = join(tempRoot, 'fonts');
    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(join(repoRoot, 'apps', 'server', 'scripts', 'runtime'), { recursive: true });
    mkdirSync(fontSourceDir, { recursive: true });
    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(repoRoot, 'apps', 'server', 'scripts', 'runtime', 'migrateFullRuntime.ts'), 'export {};\n', 'utf8');
    const faces = ['Inter-Regular.ttf', 'NotoEmoji[wght].ttf', 'LICENSE-Inter.txt'];
    for (const filename of faces) writeFileSync(join(fontSourceDir, filename), `${filename}\n`, 'utf8');

    await buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      includeRuntimeSupport: false,
      serverComponent: 'happier-server-light',
      entrypoint: join(serverSourcesDir, 'main.light.ts'),
      target: resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS, platform: 'linux', arch: 'x64' }),
      commandProbe: () => true,
      runCommand: () => {},
      compileBinary: async ({ outfile }) => writeFileSync(outfile, '#!/bin/sh\n', 'utf8'),
      readPublicProfileAssetFiles: async () => faces.map(filename => ({ filename, sourcePath: join(fontSourceDir, filename) })),
    });

    const staged = faces.filter(filename => existsSync(join(payloadDir, 'assets', 'public-profile', filename)));
    expect(staged).toEqual(faces);
  });

  it('reads the face list from the server-owned module of the repository it packages', async () => {
    const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
    const tempRoot = mkdtempSync(join(tmpdir(), 'server-binary-public-profile-owner-'));
    tempRoots.push(tempRoot);
    const payloadDir = join(tempRoot, 'payload');
    await buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      includeRuntimeSupport: false,
      serverComponent: 'happier-server-light',
      target: resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS, platform: 'linux', arch: 'x64' }),
      commandProbe: () => true,
      runCommand: () => {},
      compileBinary: async ({ outfile }) => writeFileSync(outfile, '#!/bin/sh\n', 'utf8'),
    });
    // Every face publicProfileFonts.ts reads (PUBLIC_PROFILE_FONT_FILES).
    const faces = ['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf', 'NotoSansCJKsc-Regular.otf',
      'NotoSansArabic-Regular.ttf', 'NotoEmoji[wght].ttf'];
    expect(faces.filter(filename => existsSync(join(payloadDir, 'assets', 'public-profile', filename)))).toEqual(faces);
  });
});
