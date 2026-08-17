import { describe, expect, it } from 'vitest';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
} from './artifactIntegrity.js';
import {
  createPluginUiArtifactArchiveV1,
  decodePluginUiArtifactArchiveBodyV1,
  encodePluginUiArtifactArchiveBodyV1,
  openPluginUiArtifactArchiveV1,
} from './artifactArchive.js';

const pluginId = 'com.acme.hosted';
const entryBytes = new TextEncoder().encode('entry');
const assetBytes = new TextEncoder().encode('asset');

function artifactGraph() {
  return {
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
    entry: 'entry.js',
    files: [
      {
        relativePath: 'entry.js',
        digest: computePluginUiArtifactSha256DigestV1(entryBytes),
        byteSize: entryBytes.byteLength,
      },
      {
        relativePath: 'assets/icon.svg',
        digest: computePluginUiArtifactSha256DigestV1(assetBytes),
        byteSize: assetBytes.byteLength,
      },
    ],
    digest: computePluginUiArtifactFileSetSha256DigestV1([
      { relativePath: 'entry.js', bytes: entryBytes },
      { relativePath: 'assets/icon.svg', bytes: assetBytes },
    ]),
    builtWith: { bundler: 'vite' as const, version: '5.0.0' },
    hostUiApiVersion: '1.0.0',
    compat: {},
  };
}

describe('Plugin UI Artifact archive codec', () => {
  it('round-trips one strict logical file graph and binds it to the expected outer digest', () => {
    const graph = artifactGraph();
    const archive = createPluginUiArtifactArchiveV1({
      pluginId,
      artifactGraph: graph,
      files: [
        { relativePath: 'entry.js', bytes: entryBytes },
        { relativePath: 'assets/icon.svg', bytes: assetBytes },
      ],
    });
    expect(archive).not.toBeNull();
    if (!archive) throw new Error('Expected archive');

    const decoded = decodePluginUiArtifactArchiveBodyV1(
      encodePluginUiArtifactArchiveBodyV1(archive.body),
    );
    expect(decoded).toEqual(archive.body);

    const opened = openPluginUiArtifactArchiveV1({
      pluginId,
      expectedArtifactDigest: graph.digest,
      header: archive.header,
      body: decoded,
    });
    expect(opened?.artifactGraph).toEqual(graph);
    expect(opened?.files.get('entry.js')).toEqual(entryBytes);
    expect(opened?.files.get('assets/icon.svg')).toEqual(assetBytes);
  });

  it('fails closed on a tampered file or a different outer link digest', () => {
    const graph = artifactGraph();
    const archive = createPluginUiArtifactArchiveV1({
      pluginId,
      artifactGraph: graph,
      files: [
        { relativePath: 'entry.js', bytes: entryBytes },
        { relativePath: 'assets/icon.svg', bytes: assetBytes },
      ],
    });
    if (!archive) throw new Error('Expected archive');

    expect(openPluginUiArtifactArchiveV1({
      pluginId,
      expectedArtifactDigest: `sha256:${'f'.repeat(64)}`,
      header: archive.header,
      body: archive.body,
    })).toBeNull();

    expect(openPluginUiArtifactArchiveV1({
      pluginId,
      expectedArtifactDigest: graph.digest,
      header: archive.header,
      body: {
        ...archive.body,
        files: archive.body.files.map((file) => file.relativePath === 'entry.js'
          ? { ...file, bytesBase64: 'dGFtcGVyZWQ=' }
          : file),
      },
    })).toBeNull();
  });
});
