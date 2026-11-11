import { describe, expect, it } from 'vitest';
import { ArtifactPublishFromFileInputV1Schema } from './artifactActionsV1.js';
import { ARTIFACT_HTML_BUNDLE_MIME_V1 } from './artifactHtmlV1.js';
import { prepareArtifactWorkspaceFileV1 } from './artifactWorkspaceFileV1.js';
import { ArtifactWorkspaceSourceV1Schema } from './artifactBinaryV1.js';

it('admits a closed explicit workspace source without changing the legacy Session input', () => {
  const workspace = { machineId: 'machine', rootPath: '/repo' };
  expect(ArtifactPublishFromFileInputV1Schema.safeParse({ path: 'docs/note.txt', workspace }).success).toBe(true);
  expect(ArtifactPublishFromFileInputV1Schema.parse({ path: 'docs/note.txt' })).toEqual({ path: 'docs/note.txt' });
  for (const input of [
    { path: 'docs/note.txt', workspace, sessionId: 'session' },
    { path: 'docs/note.txt', workspace: { ...workspace, sessionId: 'session' } },
    { path: 'docs/note.txt', workspace: { ...workspace, machineId: '' } },
    { path: 'docs/note.txt', workspace: { ...workspace, rootPath: '' } },
  ]) expect(ArtifactPublishFromFileInputV1Schema.safeParse(input).success).toBe(false);
});

it('prepares private workspace provenance without inventing a Session and preserves the Session shape', () => {
  const file = { bytes: new TextEncoder().encode('Copy'), name: 'note.txt', path: 'docs/note.txt', sha: 'a'.repeat(64) };
  const result = prepareArtifactWorkspaceFileV1({ caller: { machineId: 'machine', rootPath: '/repo' }, file, input: {} });
  expect(result.source).toEqual({ machineId: 'machine', rootPath: '/repo', path: file.path, sha: file.sha });
  expect(ArtifactWorkspaceSourceV1Schema.parse(result.source)).toEqual(result.source);
  const legacy = prepareArtifactWorkspaceFileV1({ caller: { sessionId: 'session', machineId: 'machine' }, file, input: {} });
  expect(legacy.source).toEqual({ sessionId: 'session', machineId: 'machine', path: file.path, sha: file.sha });
  expect(ArtifactWorkspaceSourceV1Schema.safeParse({ ...result.source, sessionId: 'session' }).success).toBe(false);
  expect(result.header).not.toHaveProperty('source');
});

it.each([{}, { mime: 'text/plain' }, { mime: 'application/octet-stream' }, { mime: 'text/html' }, { mime: 'application/pdf' }])('publishes PDF signature bytes through the binary PDF path (%j)', input => {
  const bytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj');
  const result = prepareArtifactWorkspaceFileV1({ caller: { machineId: 'machine', rootPath: '/repo' },
    file: { bytes, name: 'Report', path: 'Report', sha: 'a'.repeat(64) }, input });
  expect(result).toMatchObject({ header: { kind: 'published.v1', mime: 'application/pdf', sizeBytes: bytes.length }, binary: { bytes, mime: 'application/pdf' } });
  expect(result).not.toHaveProperty('body');
});

it.each(['text/plain', 'application/json'])('keeps valid UTF-8 %s content as text', mime => {
  const body = '{"message":"A report about %PDF- files"}';
  const result = prepareArtifactWorkspaceFileV1({ caller: { machineId: 'machine', rootPath: '/repo' },
    file: { bytes: new TextEncoder().encode(body), name: 'Note', path: 'Note', sha: 'a'.repeat(64) }, input: { mime } });
  expect(result).toMatchObject({ header: { mime }, body });
  expect(result).not.toHaveProperty('binary');
});

describe('workspace HTML publication', () => {
  const bundle = { v: 1 as const, entrypoint: 'pages/index.html', files: {
    'pages/index.html': { mime: 'text/html', contentBase64: 'PGgxPkhlbGxvPC9oMT4=' },
  } };

  it('prepares declared HTML folders as a canonical bundle with workspace provenance', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const result = prepareArtifactWorkspaceFileV1({ caller: { sessionId: 'session', machineId: 'machine' },
      file: { bytes, name: 'site', path: 'site', sha: 'a'.repeat(64), bundle }, input: { kind: 'html', mime: 'text/html' } });
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

  it('refuses declarations that conflict with an acquired HTML folder', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    for (const input of [{ kind: 'published.v1' }, { mime: 'text/plain' }]) {
      expect(() => prepareArtifactWorkspaceFileV1({ caller: { sessionId: 'session', machineId: 'machine' },
        file: { bytes, name: 'site', path: 'site', sha: 'a'.repeat(64), bundle }, input }))
        .toThrowError(expect.objectContaining({ code: 'artifact_source_forbidden' }));
    }
  });

  it.each([true, false])('stores the approved network choice in published HTML bytes (folder=%s)', folder => {
    const requestedCapabilities = { networkOrigins: ['https://cdn.example.com'] };
    const input = ArtifactPublishFromFileInputV1Schema.parse({ path: folder ? 'site' : 'index.html', requestedCapabilities });
    const original = folder ? new TextEncoder().encode(JSON.stringify(bundle)) : new TextEncoder().encode('<h1>Hello</h1>');
    const content = prepareArtifactWorkspaceFileV1({ caller: { sessionId: 'session', machineId: 'machine' },
      file: { bytes: original, name: folder ? 'site' : 'index.html', path: input.path, sha: 'a'.repeat(64), ...(folder ? { bundle } : {}) }, input });
    expect(content.bundle).toMatchObject({ requestedCapabilities });
    expect(content.binary).toBeDefined();
    const stored = JSON.parse(new TextDecoder().decode(content.binary!.bytes));
    expect(stored).toEqual(content.bundle);
    expect(content.header).toMatchObject({ mime: ARTIFACT_HTML_BUNDLE_MIME_V1, sizeBytes: content.binary!.bytes.length });
    expect(content.source.sha).toBe('a'.repeat(64));
    expect(bundle).not.toHaveProperty('requestedCapabilities');
  });
});
