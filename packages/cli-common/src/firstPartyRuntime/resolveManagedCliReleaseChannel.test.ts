import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveManagedCliReleaseChannel,
  resolveManagedCliReleaseChannelSync,
} from './resolveManagedCliReleaseChannel';

function withDefaultChannelMarker<T>(releaseChannel: string, run: (env: NodeJS.ProcessEnv) => T): T {
  const homeDir = mkdtempSync(join(tmpdir(), 'happier-managed-cli-release-channel-'));
  try {
    writeFileSync(
      join(homeDir, 'default-cli-release-channel.json'),
      `${JSON.stringify({ releaseChannel })}\n`,
      'utf8',
    );
    return run({ HAPPIER_HOME_DIR: homeDir });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

async function withDefaultChannelMarkerAsync<T>(
  releaseChannel: string,
  run: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const homeDir = mkdtempSync(join(tmpdir(), 'happier-managed-cli-release-channel-'));
  try {
    writeFileSync(
      join(homeDir, 'default-cli-release-channel.json'),
      `${JSON.stringify({ releaseChannel })}\n`,
      'utf8',
    );
    return await run({ HAPPIER_HOME_DIR: homeDir });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe('resolveManagedCliReleaseChannelSync', () => {
  it('uses explicit channel flags before env and runtime hints', () => {
    const resolved = resolveManagedCliReleaseChannelSync({
      args: ['--dev'],
      argv: ['hprev', 'self', 'update'],
      processEnv: { HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview' },
    });

    expect(resolved).toMatchObject({
      ringId: 'publicdev',
      label: 'dev',
      source: 'explicit-arg',
      channelToolName: 'hdev',
    });
  });

  it('uses managed runtime path hints before shim names', () => {
    const resolved = resolveManagedCliReleaseChannelSync({
      argv: [
        'hdev',
        '/Users/test/.happier/cli-preview/versions/1.2.3/package-dist/index.mjs',
      ],
      processEnv: {},
    });

    expect(resolved).toMatchObject({
      ringId: 'preview',
      source: 'path-hint',
      invokedToolName: 'hdev',
      channelToolName: 'hprev',
    });
  });

  it('uses the raw hdev invoker when packaged argv paths are generic', () => {
    const resolved = resolveManagedCliReleaseChannelSync({
      args: ['update'],
      argv: ['hdev', 'self', 'update'],
      invokedPath: 'self',
      processEnv: {},
    });

    expect(resolved).toMatchObject({
      ringId: 'publicdev',
      source: 'shim-name',
      invokedToolName: 'hdev',
      channelToolName: 'hdev',
    });
  });

  it('uses the persisted default channel for the unsuffixed happier invoker', () => {
    withDefaultChannelMarker('preview', (processEnv) => {
      const resolved = resolveManagedCliReleaseChannelSync({
        args: ['update'],
        argv: ['happier', 'self', 'update'],
        invokedPath: 'self',
        processEnv,
      });

      expect(resolved).toMatchObject({
        ringId: 'preview',
        source: 'default-marker',
        invokedToolName: 'happier',
        channelToolName: 'hprev',
      });
    });
  });
});

describe('resolveManagedCliReleaseChannel', () => {
  it('can use the persisted default channel as an unconditional fallback', async () => {
    await withDefaultChannelMarkerAsync('publicdev', async (processEnv) => {
      const resolved = await resolveManagedCliReleaseChannel({
        processEnv,
        markerFallback: 'always',
      });

      expect(resolved).toMatchObject({
        ringId: 'publicdev',
        source: 'default-marker',
        invokedToolName: null,
        channelToolName: 'hdev',
      });
    });
  });
});
