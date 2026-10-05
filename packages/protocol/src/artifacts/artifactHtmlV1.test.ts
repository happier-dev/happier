import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../crypto/base64.js';
import { ARTIFACT_HTML_BUNDLE_MIME_V1, ArtifactHtmlBundleV1Schema, artifactHtmlBundleFromBodyV1,
  buildArtifactHtmlPreviewUrlV1, readArtifactHtmlPreviewBundleV1, isArtifactHtmlHeaderV1, ArtifactHtmlPreviewResponseV1Schema } from './artifactHtmlV1.js';

const bundle = { v: 1 as const, entrypoint: 'index.html', files: { 'index.html': {
  mime: 'text/html', contentBase64: encodeBase64(new TextEncoder().encode('<h1>Hello</h1>')),
} } };
describe('Artifact HTML bundle V1', () => {
  it('normalizes a document and authenticates the closed bundle shape', () => {
    expect(artifactHtmlBundleFromBodyV1('<h1>Hello</h1>')).toEqual(bundle);
    expect(artifactHtmlBundleFromBodyV1('<h1>Hello</h1>', ' Text/HTML; charset=utf-8 ')).toEqual(bundle);
    expect(artifactHtmlBundleFromBodyV1(new TextEncoder().encode(JSON.stringify(bundle)), ARTIFACT_HTML_BUNDLE_MIME_V1)).toEqual(bundle);
    expect(isArtifactHtmlHeaderV1({ kind: 'html' })).toBe(true);
    expect(isArtifactHtmlHeaderV1({ kind: ' html ' })).toBe(false);
    expect(() => artifactHtmlBundleFromBodyV1(new Uint8Array([255]), 'text/html')).toThrow();
    expect(() => artifactHtmlBundleFromBodyV1('x', 'text/plain')).toThrow();
    expect(ArtifactHtmlBundleV1Schema.safeParse({ ...bundle, extra: true }).success).toBe(false);
  });
  it.each(['../index.html', '/index.html', 'a\\index.html', 'a//index.html', 'a/./index.html', 'https:x', 'a%2findex.html', '__proto__', 'a?x', 'a#x'])('rejects unsafe bundle path %s', path => {
    expect(ArtifactHtmlBundleV1Schema.safeParse({ ...bundle, entrypoint: path, files: { [path]: bundle.files['index.html'] } }).success).toBe(false);
  });
  it('accepts ordinary Unicode and space-bearing relative filenames', () => {
    expect(ArtifactHtmlBundleV1Schema.safeParse({ v: 1, entrypoint: '日本 index.html', files: {
      '日本 index.html': bundle.files['index.html'],
      'café image.svg': { mime: 'image/svg+xml', contentBase64: '' },
    } }).success).toBe(true);
  });
  it('keeps private bytes in a fragment and refuses substituted/malformed fragment payloads', () => {
    const url = buildArtifactHtmlPreviewUrlV1({ url: 'https://artifact.preview.test/a/artifact', bundle });
    expect(new URL(url).pathname).toBe('/a/artifact');
    expect(new URL(url).search).toBe('');
    expect(readArtifactHtmlPreviewBundleV1(new URL(url).hash)).toEqual(bundle);
    expect(() => readArtifactHtmlPreviewBundleV1('#d=bad')).toThrow();
    expect(() => readArtifactHtmlPreviewBundleV1(new URL(url).hash + '&d=x')).toThrow();
    expect(() => buildArtifactHtmlPreviewUrlV1({ url: 'http://artifact.preview.test/a/artifact', bundle })).toThrow();
  });
  it('refuses the captured application origin before adding document bytes', () => {
    expect(() => buildArtifactHtmlPreviewUrlV1({ url: 'https://app.example.test/a/artifact', bundle,
      forbiddenOrigins: ['https://APP.example.test:443/api'] })).toThrow();
    expect(new URL(buildArtifactHtmlPreviewUrlV1({ url: 'https://artifact.preview.test/a/artifact', bundle,
      forbiddenOrigins: ['https://app.example.test'] })).origin).toBe('https://artifact.preview.test');
    expect(ArtifactHtmlPreviewResponseV1Schema.safeParse({ url: 'not a URL' }).success).toBe(false);
  });
});
