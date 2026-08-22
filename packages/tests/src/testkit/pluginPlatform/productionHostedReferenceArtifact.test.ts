import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  deriveGeneratedHostedWebAssetPolicyV1,
  PluginUiArtifactsManifestV1Schema,
  resolveHostedWebAssetPolicy,
} from '@happier-dev/protocol/plugins/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveHostedWebAssetRuntime } from '../../../../../apps/cli/src/plugins/install/ui/hostedWebAssets';
import { runPluginBuildUiCli } from '../../../../plugin-sdk/src/ui/build/bin';

const repoRoot = fileURLToPath(new URL('../../../../..', import.meta.url));
const referenceRoot = join(
  repoRoot,
  'packages',
  'plugin-sdk',
  'examples',
  'production-hosted-reference',
);

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => {
    await rm(root, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }));
});

describe('production hosted reference Artifact boundary', () => {
  it('builds real emitted bytes and adopts their exact graph through the incumbent installed-Artifact resolver', async () => {
    // Keep the project outside the synchronized checkout so remote-work sync
    // cannot delete the live bundler cwd. Link the repository dependencies to
    // preserve the copyable example's ordinary package resolution.
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-production-hosted-reference-'));
    temporaryRoots.add(projectRoot);
    await cp(referenceRoot, projectRoot, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]+/u).includes('dist'),
    });
    await symlink(
      join(repoRoot, 'node_modules'),
      join(projectRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const errors: string[] = [];
    const exitCode = await runPluginBuildUiCli({
      argv: ['--project-root', projectRoot],
      onError: (message) => errors.push(message),
    });
    expect(errors).toEqual([]);
    expect(exitCode).toBe(0);

    const artifactRoot = join(projectRoot, 'dist', 'happier-plugin-ui');
    const graph = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(await readFile(
      join(artifactRoot, 'ui-artifacts.json'),
      'utf8',
    )));
    const hosted = graph.entries.find((entry) => (
      entry.contributionId === 'review-hosted' && entry.tier === 'hostedWeb'
    ));
    expect(hosted).toBeDefined();
    if (!hosted) throw new Error('production hosted reference graph is missing');

    const emittedFiles = await Promise.all(hosted.files.map(async (file) => ({
      relativePath: file.relativePath,
      bytes: await readFile(join(artifactRoot, ...file.relativePath.split('/'))),
    })));
    expect(computePluginUiArtifactFileSetSha256DigestV1(emittedFiles)).toBe(hosted.digest);
    expect(hosted.entry).toMatch(/^hosted-web\/review-hosted\/index\.html$/u);
    expect(hosted.files.map(({ relativePath }) => relativePath)).toEqual(expect.arrayContaining([
      hosted.entry,
      expect.stringMatching(/^hosted-web\/review-hosted\/assets\/.+\.js$/u),
      expect.stringMatching(/^hosted-web\/review-hosted\/assets\/.+\.css$/u),
    ]));

    const assetPolicy = deriveGeneratedHostedWebAssetPolicyV1(hosted);
    expect(assetPolicy).not.toBeNull();
    if (!assetPolicy) throw new Error('production hosted reference asset policy is missing');
    for (const file of hosted.files) {
      const requestPath = file.relativePath === hosted.entry
        ? '/'
        : file.relativePath.slice(`${assetPolicy.assetRootId}/`.length);
      expect(resolveHostedWebAssetPolicy({
        ...assetPolicy,
        requestPath,
        delivery: 'ephemeralCapability',
        frameAncestors: ['https://app.happier.test'],
      })).toMatchObject({
        ok: true,
        relativePath: file.relativePath,
        headers: {
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': expect.stringContaining(
            'frame-ancestors https://app.happier.test',
          ),
        },
      });
    }
    expect(resolveHostedWebAssetPolicy({
      ...assetPolicy,
      requestPath: '../outside.js',
      delivery: 'ephemeralCapability',
      frameAncestors: ['https://app.happier.test'],
    })).toEqual({
      ok: false,
      code: 'invalid_request_path',
      status: 400,
    });

    const adoption = resolveHostedWebAssetRuntime({
      contributionId: 'review-hosted',
      manifestContributionId: 'review-hosted',
      runtimeMode: {
        kind: 'installedStaticAssets',
        artifactId: 'review-hosted',
        assetRootId: 'hosted-web/review-hosted',
      },
      manifest: graph,
    });

    expect(adoption).toMatchObject({
      ok: true,
      artifactId: 'review-hosted',
      assetRootId: 'hosted-web/review-hosted',
      entryPath: hosted.entry,
      files: hosted.files.map(({ relativePath }) => relativePath),
      digest: hosted.digest,
      integrity: {
        pluginId: 'examples.production-hosted-reference',
        contributionId: 'review-hosted',
        artifactKind: 'hostedWebAsset',
        digest: hosted.digest,
      },
    });
  }, 30_000);
});
