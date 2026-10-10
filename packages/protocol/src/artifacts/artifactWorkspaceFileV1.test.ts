import { describe, expect, it } from 'vitest';
import { ArtifactPublishFromFileInputV1Schema } from './artifactActionsV1.js';
import { ARTIFACT_HTML_BUNDLE_MIME_V1 } from './artifactHtmlV1.js';
import { prepareArtifactWorkspaceFileV1 } from './artifactWorkspaceFileV1.js';

describe('workspace HTML publication', () => {
  const bundle = { v: 1 as const, entrypoint: 'pages/index.html', files: {
    'pages/index.html': { mime: 'text/html', contentBase64: 'PGgxPkhlbGxvPC9oMT4=' },
  } };

  it('prepares acquired folders as a canonical HTML bundle with workspace provenance', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const result = prepareArtifactWorkspaceFileV1({ caller: { sessionId: 'session', machineId: 'machine' },
      file: { bytes, name: 'site', path: 'site', sha: 'a'.repeat(64), bundle }, input: {} });
    expect(result).toMatchObject({ header: { kind: 'html', mime: ARTIFACT_HTML_BUNDLE_MIME_V1, title: 'site' },
      source: { path: 'site', sha: 'a'.repeat(64) }, binary: { bytes, mime: ARTIFACT_HTML_BUNDLE_MIME_V1 } });
  });

  it('admits the declared confined folder entrypoint on the existing publication Action', () => {
    expect(ArtifactPublishFromFileInputV1Schema.parse({ path: 'site', entrypoint: 'pages/index.html' }))
      .toEqual({ path: 'site', entrypoint: 'pages/index.html' });
    for (const entrypoint of ['../index.html', 'a\\index.html', '/index.html', 'a%2findex.html']) {
      expect(ArtifactPublishFromFileInputV1Schema.safeParse({ path: 'site', entrypoint }).success).toBe(false);
    }
  });
});
